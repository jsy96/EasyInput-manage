import { edgeGec } from './edge-gec'
/** Edge read-aloud service adapter; same voice/rate as edge-tts-chinese. */
export async function synthesize(text: string): Promise<ArrayBuffer> {
  const id = crypto.randomUUID().replaceAll('-', '')
  const endpoint = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
  const response = await fetch(`${endpoint}?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${id}&Sec-MS-GEC=${edgeGec()}&Sec-MS-GEC-Version=2-143.0.3650.75`, {
    headers: { Upgrade: 'websocket', Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', Cookie: `muid=${crypto.randomUUID().replaceAll('-', '').toUpperCase()};`, Pragma: 'no-cache', 'Cache-Control': 'no-cache', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0' },
  })
  const socket = response.webSocket
  if (!socket) throw new Error(`文字转语音暂不可用（${response.status}），请稍后重试`)
  // Modern Workers follow the browser default (Blob); parse binary audio as bytes.
  socket.binaryType = 'arraybuffer'
  socket.accept()
  const now = new Date()
  const stamp = `${now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${now.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ${String(now.getUTCDate()).padStart(2, '0')} ${now.getUTCFullYear()} ${now.toISOString().slice(11, 19)} GMT+0000 (Coordinated Universal Time)`
  const escaped = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []; let size = 0; let done = false
    const finish = (error?: Error): void => {
      if (done) return; done = true; clearTimeout(timer); socket.close()
      if (error) { reject(error); return }
      if (size < 256) { reject(new Error('未收到有效语音，请稍后重试')); return }
      const audio = new Uint8Array(size); let offset = 0
      for (const c of chunks) { audio.set(c, offset); offset += c.length }
      resolve(audio.buffer)
    }
    const timer = setTimeout(() => finish(new Error('文字转语音超时，请稍后重试')), 45000)
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') { if (event.data.includes('Path:turn.end')) finish(); return }
      const bytes = new Uint8Array(event.data)
      if (bytes.length < 2) return
      const header = bytes[0] * 256 + bytes[1]
      const metadata = new TextDecoder().decode(bytes.subarray(2, 2 + header))
      if (!metadata.includes('Path:audio')) return
      const audio = bytes.slice(header + 2); chunks.push(audio); size += audio.length
      if (size > 600000) finish(new Error('文字过长，请缩短后发送'))
    })
    socket.addEventListener('error', () => finish(new Error('文字转语音连接失败')))
    socket.addEventListener('close', event => finish(size ? undefined : new Error(`文字转语音连接结束（${event.code}），请稍后重试`)))
    socket.send(`X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } })}\r\n`)
    socket.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="zh-CN-YunjianNeural"><prosody pitch="+0Hz" rate="-10%" volume="+0%">${escaped}</prosody></voice></speak>`)
  })
}
