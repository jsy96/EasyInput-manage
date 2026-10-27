import { useEffect, useRef, useState } from 'react'
import { Mic, Send, Square, Volume2 } from 'lucide-react'
import { keyForSlot, slotLight } from '@shared/chat'
import type { ChatMessage, RoomState } from '@shared/chat'
import type { BoardStatus } from '@shared/protocol'
import type { ChatConnection } from './services/chat'
import { textVoice, VoiceRecorder, voiceWav } from './services/voice'
export function VoiceChat({ room, board, connection, busyChanged, disabled }: { room: RoomState; board: BoardStatus | null; connection: ChatConnection | null; busyChanged(busy: boolean): void; disabled: boolean }): React.JSX.Element {
  const [text, setText] = useState(''), [recording, setRecording] = useState(false), [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState('')
  const [draft, setDraft] = useState<{ bytes: Uint8Array; text?: string } | null>(null)
  const [playing, setPlaying] = useState(false)
  const players = useRef<Record<string, HTMLAudioElement | null>>({})
  const [loading, setLoading] = useState(''), [urls, setUrls] = useState<Record<string, string>>({})
  const recorder = useRef<VoiceRecorder | null>(null), alive = useRef(true), urlsRef = useRef<Record<string, string>>({})
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { busyChanged(recording || sending || !!loading || playing); return () => busyChanged(false) }, [recording, sending, loading, playing, busyChanged])
  useEffect(() => { alive.current = true; return () => { alive.current = false; recorder.current?.dispose(); Object.values(urlsRef.current).forEach(URL.revokeObjectURL) } }, [])
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [room.messages.length])
  useEffect(() => {
    for (const m of room.messages) if (m.cleared && urlsRef.current[m.id]) {
      URL.revokeObjectURL(urlsRef.current[m.id]); delete urlsRef.current[m.id]; setUrls({ ...urlsRef.current })
    }
  }, [room.messages])
  async function sendVoice(value: { bytes: Uint8Array; text?: string }): Promise<void> {
    if (!connection) return
    setSending(true); setProgress(0); setError(''); setDraft(value)
    try { await connection.upload(value.bytes, value.text, setProgress); if (alive.current) { setDraft(null); if (value.text) setText('') } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '发送失败，请重试') }
    finally { if (alive.current) setSending(false) }
  }
  async function record(): Promise<void> {
    setError(''); setSeconds(0); setRecording(true)
    const capture = new VoiceRecorder((bytes) => { if (alive.current) { setRecording(false); if (bytes.length) void sendVoice({ bytes }); else setError('录音时间太短，请重新录制') } }, setSeconds)
    recorder.current = capture
    try { await capture.start() } catch (e) { setRecording(false); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '请允许麦克风权限后再录音' : '无法录音，请检查麦克风或使用 Chrome / Edge') }
  }
  async function sendText(): Promise<void> {
    if (!connection || !text.trim()) return
    setSending(true); setError(''); setProgress(0)
    try { const bytes = await textVoice(text, connection.gateway); await sendVoice({ bytes, text }) }
    catch (e) { setError(e instanceof Error ? e.message : '文字转语音失败，请重试') }
    finally { if (alive.current) setSending(false) }
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
  const busy = recording || sending || disabled
  return <article className="panel voice-chat">
    <div className="panel-heading"><div><span className="section-kicker">VOICE ROOM</span><h3>和开发板聊一聊</h3></div><span className="status-chip">{room.self ? `${room.self.name} · ${keyForSlot(room.self.slot)}` : '连接群聊中…'}</span></div>
    <div className="chat-slots">{Array.from({ length: 5 }, (_, slot) => <span key={slot}><i className={`chat-led ${slot === 4 && board?.voice?.pending ? board.voice.sending ? 'yellow flashing' : 'yellow' : slotLight(room.messages, slot)}`} /><b>{keyForSlot(slot)}</b><small>{slot < 4 ? room.clients.find(c => c.slot === slot)?.name ?? '等待加入' : board?.voice?.s8_enabled === false ? '其他电脑 · 暂停播放' : '其他电脑'}</small></span>)}</div>
    {board?.voice && <p className="chat-board-state" role="status">音量 {board.speaker.volume ?? '—'}% · S8 {board.voice.s8_enabled ? '允许播放' : '禁止播放'}{board.voice.pending > 0 ? ` · ${board.voice.sending ? '发送中' : '待发送'} ${board.voice.pending} 条（自动重试）` : ''}{board.voice.storage_error ? ' · 录音存储异常，请保持供电' : ''}{board.voice.setup_active ? ' · 手机配网模式已开启' : ''}</p>}
    <div className="chat-messages" ref={scrollRef} aria-live="polite">
      {!room.messages.length && <div className="empty-state"><Mic size={28} /><strong>第一条留言，从你开始</strong><p>发送语音或文字，开发板都能听见<br />开发板回复后，群里的电脑都能播放</p></div>}
      {room.messages.map(m => <div key={m.id} className={`chat-message ${m.sender === room.self?.id ? 'chat-mine' : ''}`}>
        <div className="chat-message-meta"><strong>{m.name}</strong><span>{m.sender === 'board' ? '开发板' : keyForSlot(m.slot)}</span><time>{new Date(m.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
        {m.text && <p className="chat-text">{m.text}</p>}
        {m.cleared ? <p className="chat-cleared">已在开发板清除</p> : urls[m.id] ? <audio controls autoPlay preload="metadata" ref={element => { players.current[m.id] = element }} onPlay={() => { Object.entries(players.current).forEach(([id, player]) => { if (id !== m.id) player?.pause() }); setPlaying(true) }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} src={urls[m.id]} aria-label={`${m.name}的语音留言`} /> : <button className="button button-subtle chat-play" disabled={!room.connected || !!loading || disabled} onClick={() => void load(m)}><Volume2 size={16} />{loading === m.id ? '加载语音…' : '播放语音'}<span>{Math.ceil(m.samples / 8000)}″</span></button>}
        {m.sender !== 'board' && <small className={m.read ? 'is-live' : 'is-muted'}>{m.read ? '开发板已读' : '开发板未读'}</small>}
      </div>)}
    </div>
    <div className="chat-compose">
      {error && <p className="result-note error" role="alert">{error}</p>}
      {draft && !sending && <div className="chat-draft"><span>有一条待发送语音（{Math.ceil(draft.bytes.length / 8000)} 秒）</span><button className="text-button" disabled={!room.connected} onClick={() => void sendVoice(draft)}>重试发送</button><button className="text-button" onClick={() => setDraft(null)}>放弃</button></div>}
      <form onSubmit={e => { e.preventDefault(); void sendText() }} className="chat-text-form"><textarea aria-label="文字留言" maxLength={300} rows={2} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="输入文字，会自动转成语音…" /><button className="button button-primary" disabled={!room.connected || busy || !text.trim() || !!draft} type="submit"><Send size={16} />发送</button></form>
      <div className="chat-record-row">{recording ? <button className="button button-primary recording-button" onClick={() => recorder.current?.stop()}><Square size={15} />结束并发送 · {Math.floor(seconds)} / 20 秒</button> : <button className="button button-subtle" disabled={!room.connected || busy || !!draft} onClick={() => void record()}><Mic size={16} />录一条语音</button>}<span>{sending ? progress ? `正在发送 ${progress}%` : '正在处理语音…' : room.connected ? '最长 20 秒 · 支持离线留言' : '正在连接群聊…'}</span></div>
    </div>
    <p className="chat-help">开发板：S1～S4 / S8 播放，长按 1.2 秒清除已读。S5 录音，S6 结束发送，最长 20 秒。S7 播报网络。旋转调音量，短按切换 S8 播放，长按 3 秒手机配网。</p>
  </article>
}
