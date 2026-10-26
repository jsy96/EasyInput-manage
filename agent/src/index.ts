import WebSocket from 'ws'

const boardIp = process.env.BOARD_IP
const gateway = process.env.GATEWAY_WS
const device = process.env.DEVICE_ID
const token = process.env.PAIRING_TOKEN
if (!boardIp || !gateway || !device || !token) throw new Error('需要设置 BOARD_IP、GATEWAY_WS、DEVICE_ID 和 PAIRING_TOKEN。')

const boardUrl = `ws://${boardIp}/ws`
const gatewayUrl = `${gateway}?device=${encodeURIComponent(device)}&role=agent&token=${encodeURIComponent(token)}`
let board: WebSocket | null = null
let cloud: WebSocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null

function schedule(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, 3000)
}

function connect(): void {
  board?.close(); cloud?.close()
  board = new WebSocket(boardUrl)
  cloud = new WebSocket(gatewayUrl)
  board.on('open', () => board?.send(`${JSON.stringify({ type: 'command', protocol: 2, action: 'hello.get' })}\n`))
  board.on('message', (data) => { if (cloud?.readyState === WebSocket.OPEN) cloud.send(data.toString()) })
  cloud.on('message', (data) => {
    try {
      const value = JSON.parse(data.toString()) as { type?: string; action?: string }
      if (value.type !== 'command' || !['hello.get', 'status.get'].includes(value.action ?? '')) return
    } catch { return }
    if (board?.readyState === WebSocket.OPEN) board.send(data.toString())
  })
  for (const socket of [board, cloud]) {
    socket.on('error', schedule)
    socket.on('close', schedule)
  }
  console.log(`EasyInput Agent: ${boardUrl} -> ${gatewayUrl}`)
}

connect()
process.on('SIGINT', () => { board?.close(); cloud?.close(); process.exit(0) })
