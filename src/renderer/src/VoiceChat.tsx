import { useEffect, useRef, useState } from 'react'
import { Bell, Keyboard, Mic, Radio, Square, Timer, Volume2 } from 'lucide-react'
import type { ChatMessage, RoomState } from '@shared/chat'
import type { BoardStatus } from '@shared/protocol'
import type { ChatConnection } from './services/chat'
import { LiveVoicePlayer } from './services/live-audio'
import { VoiceRecorder, voiceWav } from './services/voice'
export function VoiceChat({ room, board, connection, busyChanged, disabled }: { room: RoomState; board: BoardStatus | null; connection: ChatConnection | null; busyChanged(busy: boolean): void; disabled: boolean }): React.JSX.Element {
  const [recording, setRecording] = useState(false), [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState('')
  const [draft, setDraft] = useState<Uint8Array | null>(null)
  const [playing, setPlaying] = useState(false)
  const [realtimeBusy, setRealtimeBusy] = useState(false)
  const players = useRef<Record<string, HTMLAudioElement | null>>({})
  const [loading, setLoading] = useState(''), [urls, setUrls] = useState<Record<string, string>>({})
  const recorder = useRef<VoiceRecorder | null>(null), alive = useRef(true), urlsRef = useRef<Record<string, string>>({})
  const livePlayer = useRef<LiveVoicePlayer | null>(null)
  const messages = [...room.messages].sort((a, b) => b.created - a.created)
  const unread = room.messages.filter((message) => !message.read).length
  const alarmMinute = board?.voice?.alarm_minute
  const countdownSeconds = board?.voice?.countdown_seconds ?? 0
  useEffect(() => { busyChanged(recording || sending || !!loading || playing); return () => busyChanged(false) }, [recording, sending, loading, playing, busyChanged])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      recorder.current?.dispose()
      livePlayer.current?.dispose()
      Object.values(urlsRef.current).forEach(URL.revokeObjectURL)
    }
  }, [])
  useEffect(() => {
    if (!connection) return
    return connection.onRealtime((event) => {
      if (event.type === 'start') {
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
      const bytes = await connection.download(m)
      if (!alive.current) return
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
    catch (e) { setError(e instanceof Error ? e.message : '实时监听设置失败') }
    finally { if (alive.current) setRealtimeBusy(false) }
  }
  const busy = recording || sending || disabled
  return <article className="panel voice-page">
    <div className="voice-main">
      <div className="panel-heading voice-heading">
        <div><span className="section-kicker">SHARED VOICE TIMELINE</span><h3>所有声音，一条时间线</h3></div>
        <div className="voice-heading-stats"><span className={unread ? 'unread-pill' : 'status-chip'}>{unread ? `${unread} 条未读` : '全部已读'}</span><span className="status-chip">{room.messages.length} 条语音</span></div>
      </div>
      {board?.voice && <p className="chat-board-state" role="status">{alarmMinute === null || alarmMinute === undefined ? '未设置闹钟' : `闹钟 ${String(Math.floor(alarmMinute / 60)).padStart(2, '0')}:${String(alarmMinute % 60).padStart(2, '0')}`} · {countdownSeconds ? `倒计时 ${Math.ceil(countdownSeconds / 60)} 分钟` : '无倒计时'}{board.voice.pending > 0 ? ` · ${board.voice.sending ? '发送中' : '待发送'} ${board.voice.pending} 条` : ''}{board.voice.storage_error ? ' · 录音存储异常' : ''}</p>}
      <div className="chat-messages" aria-live="polite">
        {!messages.length && <div className="empty-state"><Mic size={30} /><strong>还没有语音</strong><p>网页或开发板 S5 录下的语音<br />都会进入同一条时间线</p></div>}
        {messages.map(m => <div key={m.id} className={`chat-message ${m.sender === room.self?.id ? 'chat-mine' : ''}`}>
          <div className="chat-message-meta"><strong>{m.sender === 'board' ? '开发板' : m.name}</strong><span>{m.sender === 'board' ? '录音' : '网页'}</span><time>{new Date(m.created).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
          {urls[m.id] ? <audio controls autoPlay preload="metadata" ref={element => { players.current[m.id] = element }} onPlay={() => { Object.entries(players.current).forEach(([id, player]) => { if (id !== m.id) player?.pause() }); setPlaying(true) }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} src={urls[m.id]} aria-label={`${m.name}的语音留言`} /> : <button className="button button-subtle chat-play" disabled={!room.connected || !!loading || disabled} onClick={() => void load(m)}><Volume2 size={16} />{loading === m.id ? '加载语音…' : '播放语音'}<span>{Math.ceil(m.samples / 8000)}″</span></button>}
          <small className={m.read ? 'is-live' : 'is-muted'}>{m.read ? '开发板已播放' : '开发板未读'}</small>
        </div>)}
      </div>
      <div className="chat-compose">
        {error && <p className="result-note error" role="alert">{error}</p>}
        {draft && !sending && <div className="chat-draft"><span>有一条语音未发送（{Math.ceil(draft.length / 8000)} 秒）</span><button className="text-button" disabled={!room.connected} onClick={() => void sendVoice(draft)}>重试发送</button><button className="text-button" onClick={() => setDraft(null)}>放弃</button></div>}
        <div className="chat-record-row">{recording ? <button className="button button-primary recording-button" onClick={() => recorder.current?.stop()}><Square size={15} />结束并发送 · {Math.floor(seconds)} / 20 秒</button> : <button className="button button-primary" disabled={!room.connected || busy || !!draft} onClick={() => void record()}><Mic size={16} />录制语音</button>}<span>{sending ? progress ? `正在发送 ${progress}%` : '正在处理语音…' : room.connected ? '仅支持语音 · 最长 20 秒' : '正在连接语音服务…'}</span></div>
      </div>
    </div>
    <aside className="voice-side">
      <section className={`realtime-card ${room.realtimeActive ? 'is-active' : ''}`}>
        <div className="side-title"><span><Radio size={17} />实时麦克风</span><i className={room.realtimeActive ? 'live-dot active' : 'live-dot'} /></div>
        <p>{room.realtimeActive ? '开发板正在采集，声音仅实时播放，不会保存；按开发板 S8 可结束。' : room.realtimeEnabled ? '房间已允许开发板按 S7 开始采集；当前没有采集。再次点击可关闭权限。' : '允许后，按开发板 S7 可实时收听麦克风，按 S8 结束。'}</p>
        <button className={`button ${room.realtimeEnabled ? 'button-primary' : 'button-subtle'} full-button`} disabled={!room.connected || realtimeBusy || disabled} onClick={() => void toggleRealtime()}><Radio size={15} />{room.realtimeEnabled ? '关闭实时监听权限' : '允许实时监听'}</button>
      </section>
      <section className="key-map">
        <div className="side-title"><span><Keyboard size={17} />开发板按键</span></div>
        <dl>
          <div><dt>S1</dt><dd>按时间选择下一条未读；已读跳过，无长按功能</dd></div>
          <div><dt>S2</dt><dd>播放当前语音；再按重播，其他键停止</dd></div>
          <div><dt>S3</dt><dd><Bell size={13} />设置每日闹钟，长按取消</dd></div>
          <div><dt>S4</dt><dd><Timer size={13} />设置倒计时</dd></div>
          <div><dt>S5 / S6</dt><dd>录音 / 发送</dd></div>
          <div><dt>S7</dt><dd>实时麦克风；按 S8 结束并语音提示</dd></div>
          <div><dt>S8</dt><dd>播报联网状态和电脑端在线人数；实时中按下停止监听</dd></div>
        </dl>
      </section>
    </aside>
  </article>
}
