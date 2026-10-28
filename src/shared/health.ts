export const HEALTH_KINDS = ['mother_high', 'mother_low', 'father_high', 'father_low', 'father_glucose', 'mother_glucose'] as const
export type HealthKind = typeof HEALTH_KINDS[number]
export interface HealthMeasurement {
  id: string
  kind: HealthKind
  /** Glucose uses integer tenths; pressure uses integers. */
  value: number
  measuredAt: number | null
  uptimeMs: number
}
export interface HealthRecord extends HealthMeasurement { receivedAt: number; sequence: number }
export function isHealthMeasurement(value: unknown): value is HealthMeasurement {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (typeof r.id !== 'string' || !/^[a-f0-9]{32}$/.test(r.id) || !HEALTH_KINDS.includes(r.kind as HealthKind)) return false
  const glucose = String(r.kind).endsWith('glucose'), low = String(r.kind).endsWith('low')
  return Number.isSafeInteger(r.value) && Number(r.value) >= (glucose ? 30 : low ? 50 : 80) &&
    Number(r.value) <= (glucose ? 200 : low ? 120 : 220) &&
    (r.measuredAt === null || (Number.isSafeInteger(r.measuredAt) && Number(r.measuredAt) >= 1735689600000 && Number(r.measuredAt) <= 4102444800000)) &&
    Number.isSafeInteger(r.uptimeMs) && Number(r.uptimeMs) >= 0
}
export function isHealthRecord(value: unknown): value is HealthRecord {
  if (!isHealthMeasurement(value)) return false
  const r = value as HealthRecord
  return Number.isSafeInteger(r.sequence) && r.sequence > 0 && Number.isSafeInteger(r.receivedAt) && r.receivedAt > 0
}
