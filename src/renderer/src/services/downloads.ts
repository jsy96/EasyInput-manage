import type { ChatMessage } from '@shared/chat'
import type { HealthRecord } from '@shared/health'
import type { LedgerRecord } from '@shared/ledger'

export function ledgerCsv(records: LedgerRecord[]): string {
  const rows = [['记录编号', '记账时间', '时间状态', '金额', '单位', '云端接收时间', '开机后毫秒']]
  for (const r of [...records].sort((a, b) => a.sequence - b.sequence)) {
    rows.push([r.id, r.recordedAt === null ? '' : new Date(r.recordedAt).toISOString(),
      r.recordedAt === null ? '未知（设备时钟未校准）' : '设备时间', String(r.amount), '元（人民币）',
      new Date(r.receivedAt).toISOString(), String(r.uptimeMs)])
  }
  return '\ufeff' + rows.map(row => row.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n'
}

export function healthCsv(records: HealthRecord[]): string {
  const rows = [['记录编号', '测量时间', '时间状态', '人物', '项目', '测量值', '单位', '云端接收时间', '开机后毫秒']]
  for (const r of [...records].sort((a, b) => a.sequence - b.sequence)) {
    const glucose = r.kind.endsWith('glucose')
    rows.push([r.id, r.measuredAt === null ? '' : new Date(r.measuredAt).toISOString(), r.measuredAt === null ? '未知（设备时钟未校准）' : '设备时间',
      r.kind.startsWith('mother') ? '妈妈' : '爸爸', glucose ? '血糖' : r.kind.endsWith('high') ? '收缩压（高压）' : '舒张压（低压）',
      glucose ? (r.value / 10).toFixed(1) : String(r.value), glucose ? 'mmol/L' : 'mmHg', new Date(r.receivedAt).toISOString(), String(r.uptimeMs)])
  }
  return '\ufeff' + rows.map(row => row.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n'
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** ZIP STORE keeps WAV data intact, requires no additional dependency. */
export async function voiceZip(files: Array<{ name: string; blob: Blob }>): Promise<Blob> {
  const parts: BlobPart[] = [], directory: BlobPart[] = []
  let offset = 0, directoryBytes = 0
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), data = new Uint8Array(await file.blob.arrayBuffer()), crc = crc32(data)
    const local = new ArrayBuffer(30), l = new DataView(local)
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true)
    l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, name.length, true)
    parts.push(local, name.buffer as ArrayBuffer, data.buffer as ArrayBuffer)
    const central = new ArrayBuffer(46), c = new DataView(central)
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true)
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true)
    directory.push(central, name.buffer as ArrayBuffer); directoryBytes += 46 + name.length; offset += 30 + name.length + data.length
  }
  const end = new ArrayBuffer(22), e = new DataView(end)
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true)
  e.setUint32(12, directoryBytes, true); e.setUint32(16, offset, true)
  return new Blob([...parts, ...directory, end], { type: 'application/zip' })
}
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const VOICE_ZIP_BATCH_SIZE = 100
export function voiceZipBatches(messages: ChatMessage[]): ChatMessage[][] {
  const batches: ChatMessage[][] = []
  for (let i = 0; i < messages.length; i += VOICE_ZIP_BATCH_SIZE) batches.push(messages.slice(i, i + VOICE_ZIP_BATCH_SIZE))
  return batches
}
