import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bell, Download, Keyboard, Lightbulb, Mic, Play, Radio, Square, Timer, Volume2 } from 'lucide-react'
import type { ChatMessage, RoomState } from '@shared/chat'
import { sortMessages } from '@shared/chat'
import type { BoardLights, BoardStatus } from '@shared/protocol'
import type { ChatConnection } from './services/chat'
import { LiveVoicePlayer } from './services/live-audio'
import { VoiceRecorder, VoiceSequencePlayer, voiceWavChunks } from './services/voice'
import { downloadFile, voiceZip, voiceZipBatches } from './services/downloads'
import { MandarinRecorder, retryTranscription } from './services/transcription'
import type { TranscriptionDraft } from './services/transcription'
const BOARD_LIGHTS = [
  { label: '灯 1', hint: '接收信息慢闪；有未读语音常亮；其余熄灭' },
  { label: '灯 2', hint: '闹钟到点慢闪 1 分钟；正／倒计时 1 Hz；已设闹钟常亮' },
  { label: '灯 3', hint: 'S5／S6／S7 常亮；有待发送内容慢闪；其余熄灭' },
  { label: '灯 4', hint: '网页实时监听采集中慢闪；其余熄灭' },
  { label: '灯 5', hint: '连接／重试 Wi-Fi 时慢闪；连接正常常亮；未连接熄灭' },
]
export function VoiceChat({ room, board, lights, connection, busyChanged, disabled }: { room: RoomState; board: BoardStatus | null; lights: BoardLights | null; connection: ChatConnection | null; busyChanged(busy: boolean): void; disabled: boolean }): React.JSX.Element {
  const [recording, setRecording] = useState(false), [seconds, setSeconds] = useState(0)
  const [recordingMode, setRecordingMode] = useState<'dialect' | 'mandarin' | null>(null), [recognizing, setRecognizing] = useState(false)
  const [connectingMandarin, setConnectingMandarin] = useState(false)
  const [transcriptionDraft, setTranscriptionDraft] = useState<TranscriptionDraft | null>(null)
  const mandarinRecorder = useRef<MandarinRecorder | null>(null), recordingLock = useRef(false)
  const recordingRun = useRef(0), transcriptionRetry = useRef<AbortController | null>(null)
  const [sending, setSending] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState('')
  const [draft, setDraft] = useState<Uint8Array | null>(null)
  const [playing, setPlaying] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [locatingUnread, setLocatingUnread] = useState(false), [navigationNote, setNavigationNote] = useState('')
  const [highlightedMessage, setHighlightedMessage] = useState('')
  const locateRun = useRef(0), pendingScroll = useRef('')
  const chatViewport = useRef<HTMLDivElement | null>(null), messageElements = useRef(new Map<string, HTMLDivElement>())
  const initialScroll = useRef(false)
  const viewportPosition = useRef<{ anchor: string; offset: number; last: string; bottom: boolean } | null>(null)
  const [zipBatches, setZipBatches] = useState<ChatMessage[][]>([]), [zipPart, setZipPart] = useState(0)
  const [operationTotal, setOperationTotal] = useState(0)
  const [batchDownloading, setBatchDownloading] = useState(false), [batchProgress, setBatchProgress] = useState(0)
  const [sequencePlaying, setSequencePlaying] = useState(false), [sequenceProgress, setSequenceProgress] = useState(0)
  const sequencePlayer = useRef<VoiceSequencePlayer | null>(null)
  const sequenceRun = useRef(0)
  const urlSizes = useRef(new Map<string, number>())
  const [realtimeBusy, setRealtimeBusy] = useState(false)
  const players = useRef<Record<string, HTMLAudioElement | null>>({})
  const [loading, setLoading] = useState(''), [urls, setUrls] = useState<Record<string, string>>({})
  const recorder = useRef<VoiceRecorder | null>(null), alive = useRef(true), urlsRef = useRef<Record<string, string>>({})
  const livePlayer = useRef<LiveVoicePlayer | null>(null)
  const messages = sortMessages(room.messages)
  const unread = room.unread
  const alarmMinute = board?.voice?.alarm_minute
  const countdownSeconds = board?.voice?.countdown_seconds ?? 0
  function rememberViewport(): void {
    const viewport = chatViewport.current
    if (!viewport) return
    const top = viewport.getBoundingClientRect().top
    const anchor = messages.map(message => [message.id, messageElements.current.get(message.id)] as const).find((entry): entry is readonly [string, HTMLDivElement] => !!entry[1] && entry[1].getBoundingClientRect().bottom > top)
    viewportPosition.current = {
      anchor: anchor?.[0] ?? '', offset: anchor ? anchor[1].getBoundingClientRect().top - top : 0,
      last: messages.at(-1)?.id ?? '', bottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40,
    }
  }
  useLayoutEffect(() => {
    const viewport = chatViewport.current
    if (!viewport) return
    if (!room.connected) initialScroll.current = false
    const target = pendingScroll.current && messageElements.current.get(pendingScroll.current)
    const position = viewportPosition.current
    if (target) {
      viewport.scrollTop += target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 8
      pendingScroll.current = ''
      initialScroll.current = true
    } else if (room.connected && !initialScroll.current && messages.length) {
      viewport.scrollTop = viewport.scrollHeight
      initialScroll.current = true
    } else if (position && initialScroll.current) {
      if (position.bottom && position.last !== messages.at(-1)?.id) viewport.scrollTop = viewport.scrollHeight
      else {
        const anchor = messageElements.current.get(position.anchor)
        if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - position.offset
      }
    }
    rememberViewport()
  })
  useEffect(() => {
    locateRun.current++; pendingScroll.current = ''; setLocatingUnread(false)
  }, [connection, room.connected])
  useEffect(() => {
    if (!connection || !room.connected) return
    // Effects run after the text nodes have been committed to the mounted chat page.
    for (const message of room.messages) if (message.kind === 'text' && message.sender === 'board') {
      void connection.textDisplayed(message.id).catch(() => { /* A later message replay or reconnect can retry. */ })
    }
  }, [connection, room.connected, room.messages])
  useEffect(() => { busyChanged(recording || connectingMandarin || recognizing || sending || !!loading || playing || batchDownloading || sequencePlaying); return () => busyChanged(false) }, [recording, connectingMandarin, recognizing, sending, loading, playing, batchDownloading, sequencePlaying, busyChanged])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      locateRun.current++
      recordingRun.current++
      transcriptionRetry.current?.abort()
      recorder.current?.dispose()
      mandarinRecorder.current?.dispose()
      livePlayer.current?.dispose()
      sequenceRun.current++
      sequencePlayer.current?.stop()
      Object.values(urlsRef.current).forEach(URL.revokeObjectURL)
    }
  }, [])
  useEffect(() => {
    const ids = new Set(room.messages.map(m => m.id))
    for (const [id, url] of Object.entries(urlsRef.current)) if (!ids.has(id)) {
      URL.revokeObjectURL(url); delete urlsRef.current[id]; delete players.current[id]; urlSizes.current.delete(id)
    }
    setUrls({ ...urlsRef.current })
  }, [room.messages])
  async function audioBlob(message: ChatMessage): Promise<Blob> {
    if (!connection) throw new Error('语音服务未连接')
    return voiceWavChunks(connection.audioChunks(message), message.samples, () => alive.current)
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
    try { await player.play(snapshot, (m) => connection.audioChunks(m), (_message, index) => { if (alive.current) setSequenceProgress(index + 1) }) }
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
        const blob = await audioBlob(m)
        if (!alive.current) return
        const ordinal = batches.slice(0, selected).reduce((n, batch) => n + batch.length, 0) + index + 1
        files.push({ name: `${String(ordinal).padStart(4, '0')}_${new Date(m.created).toISOString().replaceAll(':', '-')}_${m.sender === 'board' ? '开发板' : '网页'}_${m.id}.wav`, blob })
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
  function cancelUnreadLocation(): void {
    locateRun.current++; pendingScroll.current = ''; setLocatingUnread(false); setNavigationNote('已取消定位')
  }
  async function locateUnread(): Promise<void> {
    if (!connection || !room.connected || locatingUnread) return
    const run = ++locateRun.current
    setLocatingUnread(true); setNavigationNote('正在查找开发板最早未读…'); setError('')
    try {
      const target = await connection.findFirstUnread(() => !alive.current || run !== locateRun.current)
      if (!alive.current || run !== locateRun.current) return
      if (!target) { setNavigationNote('开发板全部已读'); return }
      pendingScroll.current = target.id; setHighlightedMessage(target.id); setNavigationNote('已定位开发板最早未读；网页查看不会标记开发板已读')
    } catch (e) { if (alive.current && run === locateRun.current) { setNavigationNote(''); setError(e instanceof Error ? e.message : '未读定位失败，请重试') } }
    finally { if (alive.current && run === locateRun.current) setLocatingUnread(false) }
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      const target = event.target
      if (event.defaultPrevented || event.isComposing || event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.code !== 'KeyU' && event.key.toLowerCase() !== 'u') ||
        (target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select')))) return
      event.preventDefault()
      if (locatingUnread) cancelUnreadLocation()
      else void locateUnread()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
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
  async function record(mode: 'dialect' | 'mandarin'): Promise<void> {
    if (!connection || recordingLock.current || recording || recognizing || sending || draft || transcriptionDraft) return
    recordingLock.current = true
    const run = ++recordingRun.current
    setError(''); setSeconds(0); setRecordingMode(mode); setRecording(mode === 'dialect'); setConnectingMandarin(mode === 'mandarin')
    const capture = mode === 'dialect' ? new VoiceRecorder((bytes) => {
      if (!alive.current || run !== recordingRun.current) return
      recordingLock.current = false
      setRecording(false); setRecordingMode(null); if (bytes.length) void sendVoice(bytes); else setError('录音时间太短，请重新录制')
    }, setSeconds) : new MandarinRecorder(connection, (error, savedDraft) => {
      if (!alive.current || run !== recordingRun.current) return
      recordingLock.current = false
      setRecording(false); setConnectingMandarin(false); setRecognizing(false); setRecordingMode(null)
      if (error) { setTranscriptionDraft(savedDraft ?? null); setError(error.message) }
      else setTranscriptionDraft(null)
    }, setSeconds, () => { if (alive.current && run === recordingRun.current) { setConnectingMandarin(false); setRecording(false); setRecognizing(true) } })
    if (capture instanceof VoiceRecorder) recorder.current = capture
    else mandarinRecorder.current = capture
    try {
      await capture.start()
      if (alive.current && run === recordingRun.current && recordingLock.current && mode === 'mandarin') { setConnectingMandarin(false); setRecording(true) }
    }
    catch (e) {
      capture.dispose()
      if (alive.current && run === recordingRun.current) { recordingLock.current = false; setRecording(false); setConnectingMandarin(false); setRecordingMode(null); setRecognizing(false); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '请允许麦克风权限后再录音' : e instanceof Error ? e.message : '无法录音，请检查麦克风或使用 Chrome / Edge') }
    }
  }
  function cancelMandarinConnection(): void {
    recordingRun.current++; mandarinRecorder.current?.dispose(); recordingLock.current = false
    setConnectingMandarin(false); setRecording(false); setRecordingMode(null)
  }
  async function retryMandarin(): Promise<void> {
    if (!connection || !transcriptionDraft || recordingLock.current || recognizing) return
    recordingLock.current = true; setRecognizing(true); setError('')
    const controller = new AbortController(); transcriptionRetry.current = controller
    try { await retryTranscription(connection, transcriptionDraft, controller.signal); if (alive.current) setTranscriptionDraft(null) }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '普通话转写失败，请重试') }
    finally { if (transcriptionRetry.current === controller) transcriptionRetry.current = null; recordingLock.current = false; if (alive.current) setRecognizing(false) }
  }
  async function load(m: ChatMessage): Promise<void> {
    if (!connection || loading) return
    setLoading(m.id); setError('')
    try {
      const blob = await audioBlob(m)
      if (!alive.current) return
      while (Object.keys(urlsRef.current).length && (Object.keys(urlsRef.current).length >= 5 || [...urlSizes.current.values()].reduce((a, b) => a + b, 0) + blob.size > 32 * 1024 * 1024)) {
        const oldest = Object.keys(urlsRef.current)[0]
        players.current[oldest]?.pause(); delete players.current[oldest]
        URL.revokeObjectURL(urlsRef.current[oldest]); delete urlsRef.current[oldest]; urlSizes.current.delete(oldest)
      }
      urlSizes.current.set(m.id, blob.size)
      const url = URL.createObjectURL(blob); urlsRef.current[m.id] = url; setUrls({ ...urlsRef.current })
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
  const busy = recording || connectingMandarin || recognizing || sending || disabled || batchDownloading || sequencePlaying
  return <article className="panel voice-page">
    <div className="voice-main">
      <div className="panel-heading voice-heading">
        <div><span className="section-kicker">SHARED CHAT TIMELINE</span><h3>语音与文字，一条时间线</h3></div>
        <div className="voice-heading-stats"><span className={unread ? 'unread-pill' : 'status-chip'}>{unread ? `开发板 ${unread} 条未读` : '开发板全部已读'}</span><span className="status-chip">{room.total} / 5000 条消息</span></div>
      </div>
      <div className="voice-batch-actions">
        <button className="button button-subtle" disabled={!room.connected || busy || !!loading || !room.total} onClick={() => void downloadAll()}><Download size={15} />{batchDownloading ? `正在打包 ${batchProgress} / ${operationTotal} 条` : '下载全部语音 ZIP'}</button>
        <button className="button button-subtle" disabled={!sequencePlaying && (!room.connected || busy || !!loading || !room.total || room.realtimeEnabled)} onClick={() => sequencePlaying ? stopSequence() : void playAll()}>{sequencePlaying ? <Square size={15} /> : <Play size={15} />}{sequencePlaying ? `停止播放 · ${sequenceProgress} / ${operationTotal}` : '顺序播放全部'}</button>
        <button className="button button-subtle" disabled={!locatingUnread && (!room.connected || !unread)} aria-keyshortcuts="Alt+U" title="Alt+U；定位期间再次按下可取消" onClick={() => locatingUnread ? cancelUnreadLocation() : void locateUnread()}><Keyboard size={15} />{locatingUnread ? '取消定位 · Alt+U' : '最早未读 · Alt+U'}</button>
      </div>
      {navigationNote && <p className="chat-navigation-note" role="status">{navigationNote}</p>}
      {zipBatches.length > 1 && <div className="voice-batch-actions" role="status"><span>每包最多 100 条或约 64 MiB（单条较大时独立一包），共 {zipBatches.length} 包；已完成 {zipPart} 包。</span>{zipPart < zipBatches.length && <button className="button button-subtle" disabled={busy || !!loading || !room.connected} onClick={() => void downloadAll(zipPart)}><Download size={15} />下载第 {zipPart + 1} 包</button>}</div>}
      {board?.voice && <p className="chat-board-state" role="status">{alarmMinute === null || alarmMinute === undefined ? '未设置闹钟' : `闹钟 ${String(Math.floor(alarmMinute / 60)).padStart(2, '0')}:${String(alarmMinute % 60).padStart(2, '0')}`} · {countdownSeconds ? `倒计时 ${Math.ceil(countdownSeconds / 60)} 分钟` : '无倒计时'}{board.voice.pending > 0 ? ` · ${board.voice.sending ? '发送中' : '待发送'} ${board.voice.pending} 条` : ''}{board.voice.storage_error ? ' · 录音存储异常' : ''}</p>}
      <div className="chat-messages" aria-live="polite" ref={chatViewport} onScroll={rememberViewport}>
        {room.next && <button className="button button-subtle full-button" disabled={historyLoading || locatingUnread || busy || !room.connected} onClick={() => void loadOlder()}>{historyLoading || locatingUnread ? '正在加载历史…' : `加载更早消息 · 已加载 ${messages.length} / ${room.total}`}</button>}
        {!messages.length && <div className="empty-state"><Mic size={30} /><strong>还没有消息</strong><p>网页原声、普通话转写、开发板录音和 S7 文字共用一条时间线</p></div>}
        {messages.map(m => <div key={m.id} data-message-id={m.id} ref={element => { if (element) messageElements.current.set(m.id, element); else messageElements.current.delete(m.id) }} className={`chat-message ${m.sender === room.self?.id ? 'chat-mine' : ''} ${m.id === highlightedMessage ? 'chat-message-target' : ''}`}>
          <div className="chat-message-meta"><strong>{m.sender === 'board' ? '开发板' : m.name}</strong><span>{m.kind === 'text' ? '语音转文字' : m.sender === 'board' ? '录音' : '网页'}</span><time>{new Date(m.created).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
          {m.kind === 'text' ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</p> : urls[m.id] ? <audio controls autoPlay preload="metadata" ref={element => { players.current[m.id] = element }} onPlay={() => { stopSequence(); Object.entries(players.current).forEach(([id, player]) => { if (id !== m.id) player?.pause() }); setPlaying(true) }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} src={urls[m.id]} aria-label={`${m.name}的语音留言`} /> : <button className="button button-subtle chat-play" disabled={!room.connected || !!loading || busy} onClick={() => void load(m)}><Volume2 size={16} />{loading === m.id ? '加载语音…' : '播放语音'}<span>{Math.ceil(m.samples / 8000)}″</span></button>}
          {m.kind !== 'text' && m.interrupted && <small className="voice-interrupted">录音传输中断 · 仅保留云端已收到的部分</small>}
          {m.kind !== 'text' && m.sender !== 'board' && <small className={m.read ? 'is-live' : 'is-muted'}>{m.read ? '开发板已读' : '开发板未读'}</small>}
        </div>)}
      </div>
      <div className="chat-compose">
        {error && <p className="result-note error" role="alert">{error}</p>}
        {draft && !sending && <div className="chat-draft"><span>有一条语音未发送（{Math.ceil(draft.length / 8000)} 秒）</span><button className="text-button" disabled={!room.connected} onClick={() => void sendVoice(draft)}>重试发送</button><button className="text-button" onClick={() => setDraft(null)}>放弃</button></div>}
        {transcriptionDraft && !recognizing && <div className="chat-draft"><span>有一条普通话录音待转写</span><button className="text-button" disabled={!room.connected || busy} onClick={() => void retryMandarin()}>重试转写</button><button className="text-button" onClick={() => setTranscriptionDraft(null)}>放弃</button></div>}
        <div className="chat-record-row">{connectingMandarin ? <button className="button button-subtle" onClick={cancelMandarinConnection}><Square size={15} />取消连接小智</button> : recording ? <button className="button button-primary recording-button" onClick={() => recordingMode === 'mandarin' ? mandarinRecorder.current?.stop() : recorder.current?.stop()}><Square size={15} />{recordingMode === 'mandarin' ? '结束并转文字' : '结束并发送'} · {Math.floor(seconds)} / 60 秒</button> : <><button className="button button-primary" disabled={!room.connected || busy || !!draft || !!transcriptionDraft} onClick={() => void record('dialect')}><Mic size={16} />录制家乡话</button><button className="button button-subtle" disabled={!room.connected || busy || !!draft || !!transcriptionDraft} onClick={() => void record('mandarin')}><Mic size={16} />录制普通话</button></>}<span>{connectingMandarin ? '正在连接小智，就绪后开始录音…' : recognizing ? '正在转写；重试按原录音时长传输，结束后再等待最多 20 秒尾句…' : sending ? progress ? `正在发送 ${progress}%` : '正在处理语音…' : room.connected ? '最长 60 秒 · 家乡话发送原声，普通话经小智转成文字' : '正在连接语音服务…'}</span></div>
      </div>
    </div>
    <aside className="voice-side">
      <section className="lights-card">
        <div className="side-title"><span><Lightbulb size={17} />开发板灯光</span></div>
        <ul className="board-lights">
          {BOARD_LIGHTS.map(({ label, hint }, index) => {
            const pixel = board?.lights.pixels[index]
            const mode = board || room.online ? lights?.modes?.[index] ?? (pixel === 'on' ? 'solid' : pixel === 'off' ? 'off' : 'unknown') : 'unknown'
            return <li className="board-light-row" key={label}><i className={`board-light-dot is-${mode}`} /><span>{label}</span><small>{hint}</small></li>
          })}
        </ul>
        <p className="light-note">适用固件 0.4.22 起。红灯均为 1% 亮度；慢闪：亮 0.5 秒、灭 1.5 秒；1 Hz：亮灭各 0.5 秒。灯 2 按表中顺序优先显示，其他计时继续运行。</p>
      </section>
      <section className={`realtime-card ${room.realtimeActive ? 'is-active' : ''}`}>
        <div className="side-title"><span><Radio size={17} />实时监听状态</span><span>{room.realtimeActive ? '监听中' : room.realtimeEnabled ? '开启中' : '关闭'}<i className={room.realtimeActive ? 'live-dot active' : 'live-dot'} /></span></div>
        <p>{room.realtimeActive ? '开发板正在采集，声音仅实时播放，不会保存。开发板一开始工作便立即关闭监听。' : room.realtimeEnabled ? '正在打开开发板实时麦克风…开发板工作时会取消开启。' : '开发板空闲且 Wi-Fi 直连在线时可打开监听。S1～S8 的播放、传输、计时、对话、录音等工作都会立即关闭监听，结束后不自动重开。'}</p>
        <button className={`button ${room.realtimeEnabled ? 'button-primary' : 'button-subtle'} full-button`} disabled={!room.connected || realtimeBusy || disabled || (!room.realtimeEnabled && (busy || !room.online || room.via !== 'wifi'))} onClick={() => void toggleRealtime()}><Radio size={15} />{room.realtimeEnabled ? '关闭实时监听' : '打开实时监听'}</button>
      </section>
      <section className="key-map">
        <div className="side-title"><span><Keyboard size={17} />开发板按键</span></div>
        <dl>
          <div><dt>S1</dt><dd>短按回听前一条历史语音，连续按继续往前，到最早不循环。长按 3 秒，进入全部已读确认。</dd></div>
          <div><dt>S2</dt><dd>短按播放最早未读，并重设 S1 回听起点；提示“暂无语音”时，将 S1 重置到最新历史位置。全部已读确认中，长按 3 秒执行，短按取消。</dd></div>
          <div><dt>S3</dt><dd><Bell size={13} />短按设置每日闹钟，旋钮每格调 30 分钟（00:00～23:30）；数字播完静置 3 秒保存。到点播放音乐 1 分钟。长按 1.2 秒取消闹钟。</dd></div>
          <div><dt>S4</dt><dd><Timer size={13} />短按设置倒计时，默认 30 分钟；旋钮每格调 1 分钟（1～60 分钟），数字播完静置 3 秒开始。运行中按 S1～S7 或旋钮可取消；S8 独立计时。</dd></div>
          <div><dt>S5</dt><dd>短按开始，提示结束并连接云端后持续录音上传；按任意键停止并保存，尾音保存完成后显示留言。一条录音一条留言；长按也按停止保存处理。</dd></div>
          <div><dt>S6</dt><dd>短按开始小智对话，按任意键立即结束收音和播放。回答时暂停收音，播完自动继续听；请等回答结束再说。对话不写入聊天记录。</dd></div>
          <div><dt>S7</dt><dd>短按开始持续语音转文字，按任意键停止收音。最多等 20 秒尾句，再等 12 秒网页显示回执；本轮有文字且全部显示才播报“成功”。需打开本“语音”页，等待期间再按不会另开一轮。</dd></div>
          <div><dt>S8</dt><dd>短按开始正计时，每满 1 分钟播放 1 秒提示音；按下任意 S1～S8 或旋钮按键立即结束计时及并行语音，空闲后播报总时长。本次按键只停止，下次从零开始。与倒计时独立，断网可用，重启归零。</dd></div>
          <div><dt>旋钮</dt><dd>设置闹钟／倒计时时调整数值；其余状态每格调音量 10%，范围 10%～100%，音频空闲保存后重启恢复音量。空闲时长按 3 秒开启手机配网热点。</dd></div>
        </dl>
      </section>
      <section className="key-map">
        <details className="board-help">
          <summary>全部已读怎么操作</summary>
          <p>长按 S1 3 秒后松开，听到确认提示，再长按 S2 3 秒。云端确认后播报成功；失败或 12 秒超时会提示失败。历史和音频保留。</p>
          <p>确认中短按 S2，或按 S3／S4／旋钮可取消；S5～S7 暂不响应。正计时运行时任意按键优先停止计时。灯 1 继续按未读／接收状态显示。</p>
        </details>
        <details className="board-help">
          <summary>操作限制与失败处理</summary>
          <p>S5 录音、S6 对话、S7 转写和网页实时监听互斥。S5／S6／S7 期间按 S1～S8 或旋钮按键停止，本次按键不执行原功能；旋转仍调音量。开发板开始任意播放、传输、计时、对话或录音时立即取消实时监听，结束或重连后也不自动重开，需在网页重新打开。</p>
          <p>S5／S6／S7 连续 60 秒未检测到说话或单次达到 60 分钟时自动结束。S6 思考和回答播放不计入静音时间，重新收音后重新计时；总时长仍继续。S5 保存尾音，S7 继续等待尾句。</p>
          <p>S6／S7 需开发板直接连接 2.4 GHz Wi-Fi，并在小智官方平台绑定；蓝牙网关可转发历史语音和状态，不能代替小智连接或实时监听。</p>
          <p>正计时、停止结果和待播报提示不跨重启保存。停止时先记录实际时刻，音频忙时最多排队 8 次结果，等空闲再播报。正计时每满 1 分钟立即响 1 秒，其他音频播放中会混入提示音。闹钟音乐从实际开始播放起持续 1 分钟，收音或播放繁忙时延后。</p>
          <p>S7 失败后文字仍可能补传，后来送达不补播成功。待发文字队列未满时可开始下一轮；本轮音频不保存，只有已持久化的队首文字有断电保留保证。</p>
          <p>S5 需 Wi-Fi 直连云端，网页可关闭；停止并保存后再查看。短时断网会缓冲重试，持续失败则停止，云端将已收到的部分标为中断。历史固件留下的离线录音仍会补传。网页播放不会改变开发板未读状态。</p>
          <p>闹钟使用北京时间 UTC+8，每次开机需有效网络校时；设置可跨重启保存。倒计时和正计时断网继续，重启后清零。S5／S6／S7 在松手时开始，按下任意键即停止，没有双击功能。</p>
          <p>网页两种录音均最长 60 秒：家乡话发送原声音频，普通话通过小智识别后只发送文字，不保存原声。普通话首次使用按提示绑定独立的网页转写设备；识别为空会提示重录，传输失败可重试。网页转写文字不计入开发板未读语音。</p>
        </details>
      </section>
    </aside>
  </article>
}
