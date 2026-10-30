/** Independent browser transcription. No board credentials or microphone are used. */
const OTA = 'https://api.tenclass.net/xiaozhi/ota/'
export const ASR_FRAME_MS = 60
export const ASR_MAX_PACKETS = 1001 // Includes the encoder's final padded packet.
export const ASR_DRAIN_MS = 20_000
export interface XiaozhiIdentity { deviceId: string; clientId: string }
type Json = Record<string, unknown>
type Fetcher = typeof fetch

export class XiaozhiActivationError extends Error {
  constructor(readonly code: string) {
    super(`请在小智官方平台 xiaozhi.me 绑定网页转写设备，验证码：${code}。绑定后重新点击录制普通话。`)
  }
}
export function createXiaozhiIdentity(): XiaozhiIdentity {
  // This locally administered protocol ID belongs to the cloud software client.
  // It must never be copied from a physical board or presented as its MAC.
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  bytes[0] = (bytes[0] | 2) & 0xfe
  return { deviceId: [...bytes].map(b => b.toString(16).padStart(2, '0')).join(':'), clientId: crypto.randomUUID() }
}
export function opusPacket(bytes: ArrayBuffer, protocol: number, timestampMs: number): Uint8Array {
  if (!bytes.byteLength || bytes.byteLength > 4000 || ![1, 2, 3].includes(protocol)) throw new Error('普通话音频帧格式错误')
  const offset = protocol === 2 ? 16 : protocol === 3 ? 4 : 0
  const packet = new Uint8Array(offset + bytes.byteLength), view = new DataView(packet.buffer)
  if (protocol === 2) { view.setUint16(0, 2); view.setUint32(8, timestampMs); view.setUint32(12, bytes.byteLength) }
  if (protocol === 3) view.setUint16(2, bytes.byteLength)
  packet.set(new Uint8Array(bytes), offset)
  return packet
}
export async function provisionXiaozhi(identity: XiaozhiIdentity, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<{ url: string; token?: string; version: number }> {
  const headers = { 'Content-Type': 'application/json', 'Activation-Version': '1',
    'Device-Id': identity.deviceId, 'Client-Id': identity.clientId, 'Accept-Language': 'zh-CN' }
  const body = JSON.stringify({ version: 2, language: 'zh-CN', mac_address: identity.deviceId, uuid: identity.clientId,
    application: { name: 'easyinput-studio-web-asr', version: '1.0.0' }, board: { type: 'web', name: 'EasyInput Studio' } })
  const request = async (url: string, value: string, timeout: number): Promise<Response> => {
    // Workers supports manual/follow redirects; error is not implemented.
    const response = await fetcher(url, {
      method: 'POST', headers, body: value, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    if (response.status >= 300 && response.status < 400) throw new Error('小智设备接入不接受重定向，请重试')
    return response
  }
  const getConfig = async (): Promise<Json> => {
    const response = await request(OTA, body, 12_000)
    if (!response.ok) throw new Error(`小智网页设备接入失败（HTTP ${response.status}）`)
    return await response.json() as Json
  }
  let config = await getConfig()
  const activation = config.activation as Json | undefined
  if (typeof activation?.code === 'string' && activation.code) {
    let activated = false
    try { activated = (await request(`${OTA}activate`, '{}', 3000)).ok } catch { /* Show the stable binding code rather than retrying. */ }
    if (signal.aborted) throw new Error('普通话识别已取消')
    if (activated) config = await getConfig()
    const code = (config.activation as Json | undefined)?.code
    if (typeof code === 'string' && code) throw new XiaozhiActivationError(code.slice(0, 64))
    if (!activated) throw new XiaozhiActivationError(activation.code.slice(0, 64))
  }
  const ws = config.websocket as Json | undefined
  if (typeof ws?.url !== 'string' || !ws.url.startsWith('wss://') || ![1, 2, 3].includes(Number(ws.version ?? 1))) {
    throw new Error('小智未返回可用的网页转写连接，请检查独立设备绑定')
  }
  return { url: ws.url, token: typeof ws.token === 'string' ? ws.token : undefined, version: Number(ws.version ?? 1) }
}

export async function runXiaozhiTranscription(browser: WebSocket, identity: XiaozhiIdentity,
  commit: (text: string) => Promise<void>, fetcher: Fetcher = fetch): Promise<void> {
  const controller = new AbortController()
  let upstream: WebSocket | undefined, session = '', version = 1, frames = 0, bytes = 0
  let ready = false, stopping = false, finished = false, committing = false
  let drain: ReturnType<typeof setTimeout> | undefined, capture: ReturnType<typeof setTimeout> | undefined
  const segments: string[] = []
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const send = (value: Json): void => { if (browser.readyState === 1) browser.send(JSON.stringify(value)) }
  const cleanup = (): void => {
    clearTimeout(total); clearTimeout(drain); clearTimeout(capture); controller.abort()
    try { upstream?.close(1000, 'transcription finished') } catch { /* Already closed. */ }
    try { browser.close(1000, 'transcription finished') } catch { /* Already closed. */ }
    resolveClosed()
  }
  const fail = (error: unknown): void => {
    if (finished || committing) return
    finished = true
    send({ type: 'error', message: error instanceof Error ? error.message : '普通话识别失败，请重试' })
    cleanup()
  }
  const finish = async (): Promise<void> => {
    if (finished || committing) return
    const text = segments.join('\n').trim()
    if (!text) { fail(new Error('未识别到普通话文字，请重新录制')); return }
    committing = true
    try {
      await commit(text)
      finished = true; send({ type: 'done' }); cleanup()
    } catch (error) {
      committing = false; fail(error)
    }
  }
  const stop = (): void => {
    if (!ready || stopping || finished) return
    stopping = true; clearTimeout(capture)
    upstream!.send(JSON.stringify({ type: 'listen', session_id: session, state: 'stop' }))
    send({ type: 'recognizing' })
    // There is no transcript-end ACK. Do not truncate later utterances at an
    // earlier STT or TTS event; receive the same full tail window as S7.
    drain = setTimeout(() => { void finish() }, ASR_DRAIN_MS)
  }
  const total = setTimeout(() => fail(new Error('普通话识别超时，请重试')), 130_000)
  browser.addEventListener('close', () => { if (!finished && !committing) { finished = true; cleanup() } })
  browser.addEventListener('error', () => fail(new Error('网页转写连接中断，请重试')))
  browser.addEventListener('message', event => {
    if (finished || committing) return
    try {
      if (typeof event.data === 'string') {
        if (event.data.length > 256) throw new Error('普通话控制消息过长')
        const value = JSON.parse(event.data) as Json
        if (value.type === 'stop') stop()
        else if (value.type === 'cancel') { finished = true; cleanup() }
        else throw new Error('普通话控制消息无效')
      } else {
        if (!ready || stopping || !(event.data instanceof ArrayBuffer)) throw new Error('普通话音频会话尚未就绪')
        if (++frames > ASR_MAX_PACKETS || (bytes += event.data.byteLength) > 1024 * 1024) throw new Error('普通话录音最长 60 秒')
        // Microphone permission can take time after ready. Its delay must not
        // shorten the sixty seconds of actual capture.
        if (frames === 1) capture = setTimeout(stop, 65_000)
        upstream!.send(opusPacket(event.data, version, (frames - 1) * ASR_FRAME_MS))
      }
    } catch (error) { fail(error) }
  })
  try {
    const config = await provisionXiaozhi(identity, controller.signal, fetcher)
    if (finished) return
    version = config.version
    const headers: Record<string, string> = { Upgrade: 'websocket', 'Device-Id': identity.deviceId,
      'Client-Id': identity.clientId, 'Protocol-Version': String(version) }
    if (config.token) headers.Authorization = config.token.includes(' ') ? config.token : `Bearer ${config.token}`
    const response = await fetcher(config.url.replace(/^wss:/, 'https:'), {
      headers, redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
    })
    upstream = response.webSocket ?? undefined
    if (finished) { upstream?.close(); return }
    if (response.status !== 101 || !upstream) throw new Error(`小智转写握手失败（HTTP ${response.status}）`)
    upstream.accept()
    const helloTimeout = setTimeout(() => fail(new Error('等待小智就绪超时，请重试')), 10_000)
    upstream.addEventListener('close', () => { clearTimeout(helloTimeout); fail(new Error('小智转写连接中断，请重试')) })
    upstream.addEventListener('error', () => { clearTimeout(helloTimeout); fail(new Error('小智转写网络异常，请重试')) })
    upstream.addEventListener('message', event => {
      if (finished || committing || typeof event.data !== 'string') return // Discard assistant audio.
      try {
        if (event.data.length > 65536) throw new Error('小智转写响应过长')
        const value = JSON.parse(event.data) as Json
        if (value.type === 'hello' && !ready) {
          if (typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 128 || value.transport !== 'websocket') throw new Error('小智会话参数无效')
          clearTimeout(helloTimeout); session = value.session_id; ready = true
          upstream!.send(JSON.stringify({ type: 'listen', session_id: session, state: 'start', mode: 'realtime' }))
          send({ type: 'ready' })
        } else if (value.type === 'stt' && ready && typeof value.text === 'string' && value.text.trim()) {
          const text = value.text.trim()
          if (segments.join('\n').length + text.length > 12_000) throw new Error('识别文字过长，请缩短录音')
          // Separate utterances can legitimately have identical text. Only the
          // final cloud message ID deduplicates a replay of the whole session.
          segments.push(text)
        } else if (value.type === 'error') throw new Error('小智未能完成识别，请重试')
      } catch (error) { clearTimeout(helloTimeout); fail(error) }
    })
    upstream.send(JSON.stringify({ type: 'hello', version, transport: 'websocket',
      audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: ASR_FRAME_MS } }))
    await closed
    clearTimeout(helloTimeout)
  } catch (error) { fail(error) }
}
