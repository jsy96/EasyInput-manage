export interface LedgerEntry {
  id: string
  /** Integer CNY, 1–999 yuan. */
  amount: number
  recordedAt: number | null
  uptimeMs: number
}
export interface LedgerRecord extends LedgerEntry { receivedAt: number; sequence: number }

export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && /^[a-f0-9]{32}$/.test(r.id) &&
    Number.isSafeInteger(r.amount) && Number(r.amount) >= 1 && Number(r.amount) <= 999 &&
    (r.recordedAt === null || (Number.isSafeInteger(r.recordedAt) && Number(r.recordedAt) >= 1735689600000 && Number(r.recordedAt) <= 4102444800000)) &&
    Number.isSafeInteger(r.uptimeMs) && Number(r.uptimeMs) >= 0
}
export function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (!isLedgerEntry(value)) return false
  const r = value as LedgerRecord
  return Number.isSafeInteger(r.sequence) && r.sequence > 0 && Number.isSafeInteger(r.receivedAt) && r.receivedAt > 0
}
