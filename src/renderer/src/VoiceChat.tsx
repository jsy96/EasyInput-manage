import { useEffect, useRef, useState } from 'react'
import { Bell, Download, Keyboard, Lightbulb, Mic, Play, Radio, Square, Timer, Volume2 } from 'lucide-react'
import type { ChatMessage, RoomState } from '@shared/chat'
import { sortMessages } from '@shared/chat'
import type { BoardLights, BoardStatus } from '@shared/protocol'
import type { ChatConnection } from './services/chat'
import { LiveVoicePlayer } from './services/live-audio'
import { VoiceRecorder, VoiceSequencePlayer, voiceWav } from './services/voice'
import { downloadFile, voiceZip, voiceZipBatches } from './services/downloads'
const BOARD_LIGHTS = [
  { label: '灯 1', hint: '未读慢闪 · 批量已读确认常亮' },
  { label: '灯 2', hint: '闹钟到点常亮 1 分钟' },
  { label: '灯 3', hint: '倒计时每 1 秒闪 1 次' },
  { label: '灯 4', hint: '录音常亮 · 发送慢闪' },
  { label: '灯 5', hint: '实时录音常亮' },
]
export function VoiceChat({ room, board, lights, connection, busyChanged, disabled }: { room: RoomState; board: BoardStatus | null; lights: BoardLights | null; connection: ChatConnection | null; busyChanged(busy: boolean): void; disabled: boolean }): React.JSX.Element {
  const [recording, setRecording] = useState(false), [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState('')
  const [draft, setDraft] = useState<Uint8Array | null>(null)
  const [playing, setPlaying] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [zipBatches, setZipBatches] = useState<ChatMessage[][]>([]), [zipPart, setZipPart] = useState(0)
  const [operationTotal, setOperationTotal] = useState(0)
  const [batchDownloading, setBatchDownloading] = useState(false), [batchProgress, setBatchProgress] = useState(0)
  const [sequencePlaying, setSequencePlaying] = useState(false), [sequenceProgress, setSequenceProgress] = useState(0)
  const sequencePlayer = useRef<VoiceSequencePlayer | null>(null)
  const sequenceRun = useRef(0)
  const audioCache = useRef(new Map<string, Uint8Array>())
  const [realtimeBusy, setRealtimeBusy] = useState(false)
  const players = useRef<Record<string, HTMLAudioElement | null>>({})
  const [loading, setLoading] = useState(''), [urls, setUrls] = useState<Record<string, string>>({})
  const recorder = useRef<VoiceRecorder | null>(null), alive = useRef(true), urlsRef = useRef<Record<string, string>>({})
  const livePlayer = useRef<LiveVoicePlayer | null>(null)
  const messages = sortMessages(room.messages)
  const unread = room.unread
  const alarmMinute = board?.voice?.alarm_minute
  const countdownSeconds = board?.voice?.countdown_seconds ?? 0
  useEffect(() => {
    if (!connection || !room.connected) return
    // Effects run after the text nodes have been committed to the mounted chat page.
    for (const message of room.messages) if (message.kind === 'text' && message.sender === 'board') {
      void connection.textDisplayed(message.id).catch(() => { /* A later message replay or reconnect can retry. */ })
    }
  }, [connection, room.connected, room.messages])
  useEffect(() => { busyChanged(recording || sending || !!loading || playing || batchDownloading || sequencePlaying); return () => busyChanged(false) }, [recording, sending, loading, playing, batchDownloading, sequencePlaying, busyChanged])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      recorder.current?.dispose()
      livePlayer.current?.dispose()
      sequenceRun.current++
      sequencePlayer.current?.stop()
      Object.values(urlsRef.current).forEach(URL.revokeObjectURL)
    }
  }, [])
  useEffect(() => {
    const ids = new Set(room.messages.map(m => m.id))
    for (const id of audioCache.current.keys()) if (!ids.has(id)) audioCache.current.delete(id)
    for (const [id, url] of Object.entries(urlsRef.current)) if (!ids.has(id)) {
      URL.revokeObjectURL(url); delete urlsRef.current[id]; delete players.current[id]
    }
    setUrls({ ...urlsRef.current })
  }, [room.messages])
  async function audioBytes(message: ChatMessage): Promise<Uint8Array> {
    const cached = audioCache.current.get(message.id)
    if (cached) return cached
    if (!connection) throw new Error('语音服务未连接')
    const bytes = await connection.download(message)
    if (alive.current) {
      audioCache.current.set(message.id, bytes)
      while (audioCache.current.size > 10) audioCache.current.delete(audioCache.current.keys().next().value!)
    }
    return bytes
  }
  function stopSequence(): void {
    sequenceRun.current++
    sequencePlayer.current?.stop()
    setSequencePlaying(false); setSequenceProgress(0)
  }
  async function playAll(): Promise<void> {
    if (!connection || !room.total) return
    const run = ++sequenceRun.current
    Object.values(players.current).forEach(player => player?.pause())
    setSequencePlaying(true); setSequenceProgress(0); setOperationTotal(room.total); setError('')
    const player = sequencePlayer.current ??= new VoiceSequencePlayer()
    const snapshot = connection.voiceHistory().then(items => {
      if (!alive.current || run !== sequenceRun.current) return []
      setOperationTotal(items.length)
      return items
    })
    // The player resumes audio synchronously from this click, before history requests finish.
    try { await player.play(snapshot, audioBytes, (_message, index) => { if (alive.current) setSequenceProgress(index + 1) }) }
    catch (e) { if (alive.current && run === sequenceRun.current) setError(e instanceof Error ? e.message : '连续播放失败') }
    finally { if (alive.current && run === sequenceRun.current) { setSequencePlaying(false); setSequenceProgress(0) } }
  }
  async function downloadAll(part?: number): Promise<void> {
    if (!connection || !room.total || batchDownloading) return
    setBatchDownloading(true); setBatchProgress(0); setError('')
    try {
      const batches = part === undefined ? voiceZipBatches(await connection.voiceHistory()) : zipBatches
      if (!alive.current) return
      if (!batches.length) throw new Error('没有可下载的语音')
      const selected = part ?? 0, snapshot = batches[selected]
      setZipBatches(batches); setZipPart(selected); setOperationTotal(snapshot.length)
      const files: Array<{ name: string; blob: Blob }> = []
      for (const [index, m] of snapshot.entries()) {
        // Downloads retain audio for this ZIP only; sequential playback has a separate bounded cache.
        const bytes = await connection.download(m)
        if (!alive.current) return
        const ordinal = batches.slice(0, selected).reduce((n, batch) => n + batch.length, 0) + index + 1
        files.push({ name: `${String(ordinal).padStart(4, '0')}_${new Date(m.created).toISOString().replaceAll(':', '-')}_${m.sender === 'board' ? '开发板' : '网页'}_${m.id}.wav`, blob: voiceWav(bytes) })
        setBatchProgress(index + 1)
      }
      const zip = await voiceZip(files)
      if (alive.current) {
        downloadFile(zip, `全部语音-${new Date().toISOString().slice(0, 10)}-${String(selected + 1).padStart(2, '0')}-共${batches.length}包.zip`)
        setZipPart(selected + 1)
      }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '语音打包失败，请重试当前包') }
    finally { if (alive.current) setBatchDownloading(false) }
  }
  async function loadOlder(): Promise<void> {
    if (!connection || historyLoading) return
    setHistoryLoading(true); setError('')
    try { await connection.loadOlder() }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '历史语音加载失败') }
    finally { if (alive.current) setHistoryLoading(false) }
  }
  useEffect(() => {
    if (!connection) return
    return connection.onRealtime((event) => {
      if (event.type === 'start') {
        stopSequence()
        Object.values(players.current).forEach(player => player?.pause())
        const player = livePlayer.current ??= new LiveVoicePlayer()
        void player.start()
      } else if (event.type === 'packet') {
        const player = livePlayer.current ??= new LiveVoicePlayer()
        void player.pushPcm16(event.sequence, event.samples)
      } else if (event.type === 'chunk' && event.data) {
        const player = livePlayer.current ??= new LiveVoicePlayer()
        void player.push(event.data)
      } else if (event.type === 'stop') {
        livePlayer.current?.stop()
      }
    })
  }, [connection])
  async function sendVoice(bytes: Uint8Array): Promise<void> {
    if (!connection) return
    setSending(true); setProgress(0); setError(''); setDraft(bytes)
    try { await connection.upload(bytes, setProgress); if (alive.current) setDraft(null) }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '发送失败，请重试') }
    finally { if (alive.current) setSending(false) }
  }
  async function record(): Promise<void> {
    setError(''); setSeconds(0); setRecording(true)
    const capture = new VoiceRecorder((bytes) => { if (alive.current) { setRecording(false); if (bytes.length) void sendVoice(bytes); else setError('录音时间太短，请重新录制') } }, setSeconds)
    recorder.current = capture
    try { await capture.start() } catch (e) { setRecording(false); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '请允许麦克风权限后再录音' : '无法录音，请检查麦克风或使用 Chrome / Edge') }
  }
  async function load(m: ChatMessage): Promise<void> {
    if (!connection || loading) return
    setLoading(m.id); setError('')
    try {
      const bytes = await audioBytes(m)
      if (!alive.current) return
      while (Object.keys(urlsRef.current).length >= 5) {
        const oldest = Object.keys(urlsRef.current)[0]
        players.current[oldest]?.pause(); delete players.current[oldest]
        URL.revokeObjectURL(urlsRef.current[oldest]); delete urlsRef.current[oldest]
      }
      const url = URL.createObjectURL(voiceWav(bytes)); urlsRef.current[m.id] = url; setUrls({ ...urlsRef.current })
    } catch (e) { setError(e instanceof Error ? e.message : '语音加载失败') }
    finally { if (alive.current) setLoading('') }
  }
  async function toggleRealtime(): Promise<void> {
    if (!connection || realtimeBusy) return
    setRealtimeBusy(true); setError('')
    try {
      const enabled = !room.realtimeEnabled
      if (enabled) {
        const player = livePlayer.current ??= new LiveVoicePlayer()
        await player.start()
      } else {
        livePlayer.current?.stop()
      }
      await connection.setRealtimeEnabled(enabled)
    }
    catch (e) { if (!room.realtimeEnabled) livePlayer.current?.stop(); setError(e instanceof Error ? e.message : '实时麦克风设置失败') }
    finally { if (alive.current) setRealtimeBusy(false) }
  }
  const busy = recording || sending || disabled || batchDownloading || sequencePlaying
  return <article className="panel voice-page">
    <div className="voice-main">
      <div className="panel-heading voice-heading">
        <div><span className="section-kicker">SHARED CHAT TIMELINE</span><h3>语音与文字，一条时间线</h3></div>
        <div className="voice-heading-stats"><span className={unread ? 'unread-pill' : 'status-chip'}>{unread ? `${unread} 条未读` : '全部已读'}</span><span className="status-chip">{room.total} / 5000 条消息</span></div>
      </div>
      <div className="voice-batch-actions">
        <button className="button button-subtle" disabled={!room.connected || busy || !!loading || !room.total} onClick={() => void downloadAll()}><Download size={15} />{batchDownloading ? `正在打包 ${batchProgress} / ${operationTotal} 条` : '下载全部语音 ZIP'}</button>
        <button className="button button-subtle" disabled={!sequencePlaying && (!room.connected || busy || !!loading || !room.total || room.realtimeEnabled)} onClick={() => sequencePlaying ? stopSequence() : void playAll()}>{sequencePlaying ? <Square size={15} /> : <Play size={15} />}{sequencePlaying ? `停止播放 · ${sequenceProgress} / ${operationTotal}` : '顺序播放全部'}</button>
      </div>
      {zipBatches.length > 1 && <div className="voice-batch-actions" role="status"><span>每包最多 100 条，共 {zipBatches.length} 包；已完成 {zipPart} 包。</span>{zipPart < zipBatches.length && <button className="button button-subtle" disabled={busy || !!loading || !room.connected} onClick={() => void downloadAll(zipPart)}><Download size={15} />下载第 {zipPart + 1} 包</button>}</div>}
      {board?.voice && <p className="chat-board-state" role="status">{alarmMinute === null || alarmMinute === undefined ? '未设置闹钟' : `闹钟 ${String(Math.floor(alarmMinute / 60)).padStart(2, '0')}:${String(alarmMinute % 60).padStart(2, '0')}`} · {countdownSeconds ? `倒计时 ${Math.ceil(countdownSeconds / 60)} 分钟` : '无倒计时'}{board.voice.pending > 0 ? ` · ${board.voice.sending ? '发送中' : '待发送'} ${board.voice.pending} 条` : ''}{board.voice.storage_error ? ' · 录音存储异常' : ''}</p>}
      <div className="chat-messages" aria-live="polite">
        {room.next && <button className="button button-subtle full-button" disabled={historyLoading || busy || !room.connected} onClick={() => void loadOlder()}>{historyLoading ? '正在加载历史…' : `加载更早消息 · 已加载 ${messages.length} / ${room.total}`}</button>}
        {!messages.length && <div className="empty-state"><Mic size={30} /><strong>还没有消息</strong><p>网页和开发板录音共用一条时间线<br />已有转写文字仍可查看</p></div>}
        {messages.map(m => <div key={m.id} className={`chat-message ${m.sender === room.self?.id ? 'chat-mine' : ''}`}>
          <div className="chat-message-meta"><strong>{m.sender === 'board' ? '开发板' : m.name}</strong><span>{m.kind === 'text' ? '语音转文字' : m.sender === 'board' ? '录音' : '网页'}</span><time>{new Date(m.created).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
          {m.kind === 'text' ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</p> : urls[m.id] ? <audio controls autoPlay preload="metadata" ref={element => { players.current[m.id] = element }} onPlay={() => { stopSequence(); Object.entries(players.current).forEach(([id, player]) => { if (id !== m.id) player?.pause() }); setPlaying(true) }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} src={urls[m.id]} aria-label={`${m.name}的语音留言`} /> : <button className="button button-subtle chat-play" disabled={!room.connected || !!loading || busy} onClick={() => void load(m)}><Volume2 size={16} />{loading === m.id ? '加载语音…' : '播放语音'}<span>{Math.ceil(m.samples / 8000)}″</span></button>}
          {m.kind !== 'text' && <small className={m.read ? 'is-live' : 'is-muted'}>{m.read ? '开发板已播放' : '开发板未读'}</small>}
        </div>)}
      </div>
      <div className="chat-compose">
        {error && <p className="result-note error" role="alert">{error}</p>}
        {draft && !sending && <div className="chat-draft"><span>有一条语音未发送（{Math.ceil(draft.length / 8000)} 秒）</span><button className="text-button" disabled={!room.connected} onClick={() => void sendVoice(draft)}>重试发送</button><button className="text-button" onClick={() => setDraft(null)}>放弃</button></div>}
        <div className="chat-record-row">{recording ? <button className="button button-primary recording-button" onClick={() => recorder.current?.stop()}><Square size={15} />结束并发送 · {Math.floor(seconds)} / 20 秒</button> : <button className="button button-primary" disabled={!room.connected || busy || !!draft} onClick={() => void record()}><Mic size={16} />录制语音</button>}<span>{sending ? progress ? `正在发送 ${progress}%` : '正在处理语音…' : room.connected ? '网页录音最长 20 秒 · 开发板支持语音转文字' : '正在连接语音服务…'}</span></div>
      </div>
    </div>
    <aside className="voice-side">
      <section className="lights-card">
        <div className="side-title"><span><Lightbulb size={17} />开发板灯光</span></div>
        <ul className="board-lights">
          {BOARD_LIGHTS.map(({ label, hint }, index) => {
            const pixel = board?.lights.pixels[index]
            const mode = lights?.modes?.[index] ?? (pixel === 'on' ? 'solid' : pixel === 'off' ? 'off' : 'unknown')
            return <li className="board-light-row" key={label}><i className={`board-light-dot is-${mode}`} /><span>{label}</span><small>{hint}</small></li>
          })}
        </ul>
      </section>
      <section className={`realtime-card ${room.realtimeActive ? 'is-active' : ''}`}>
        <div className="side-title"><span><Radio size={17} />实时监听状态</span><span>{room.realtimeActive ? '监听中' : room.realtimeEnabled ? '开启中' : '关闭'}<i className={room.realtimeActive ? 'live-dot active' : 'live-dot'} /></span></div>
        <p>{room.realtimeActive ? '开发板正在采集，声音仅实时播放，不会保存。点击下方按钮关闭。' : room.realtimeEnabled ? '正在打开开发板实时麦克风…可点击下方按钮关闭。' : '点击下方按钮即可收听开发板麦克风；开关由网页控制，需要开发板 Wi-Fi 直连在线。'}</p>
        <button className={`button ${room.realtimeEnabled ? 'button-primary' : 'button-subtle'} full-button`} disabled={!room.connected || realtimeBusy || disabled || (!room.realtimeEnabled && (busy || !room.online || room.via !== 'wifi'))} onClick={() => void toggleRealtime()}><Radio size={15} />{room.realtimeEnabled ? '关闭实时监听' : '打开实时监听'}</button>
      </section>
      <section className="key-map">
        <div className="side-title"><span><Keyboard size={17} />开发板按键</span></div>
        <dl>
          <div><dt>S1</dt><dd>播放前一条历史语音，连续按继续往前；长按进入批量已读确认</dd></div>
          <div><dt>S2</dt><dd>播放第一条未读，并重设 S1 回听起点；播放中可按 S1 回听</dd></div>
          <div><dt>S3</dt><dd><Bell size={13} />设置每日闹钟，长按取消</dd></div>
          <div><dt>S4</dt><dd><Timer size={13} />设置倒计时</dd></div>
          <div><dt>S5</dt><dd>短按开始录音，再短按结束并发送；长按 3 秒取消本次未发送录音，无双击功能</dd></div>
          <div><dt>S6</dt><dd>短按开始与小智实时语音对话，再短按结束；小智回答后自动继续听。需 Wi-Fi 联网并完成小智绑定，与网页实时监听互斥</dd></div>
          <div><dt>S7</dt><dd>短按开始持续语音转文字，小智识别后可分多条写入聊天记录；再短按结束，等待网页送达确认后播报“成功”或“失败”。需打开本聊天页</dd></div>
          <div><dt>S8</dt><dd>已停用</dd></div>
          <div><dt>旋钮</dt><dd>旋转调整音量，小智对话和语音转文字期间也可调节；仍可调整闹钟与倒计时</dd></div>
        </dl>
      </section>
    </aside>
  </article>
}
