import { describe, expect, it } from 'vitest'
import { isLedgerEntry, isLedgerRecord, ledgerDay } from './ledger'

const entry = { id: 'a'.repeat(32), amount: 273, recordedAt: null, uptimeMs: 123 }
describe('ledger records', () => {
  it('accepts integer yuan and preserves an unknown device timestamp', () => {
    for (const amount of [1, 273, 999]) expect(isLedgerEntry({ ...entry, amount })).toBe(true)
    expect(isLedgerRecord({ ...entry, receivedAt: 1793145600000, sequence: 1 })).toBe(true)
    expect(isLedgerRecord(entry)).toBe(false)
  })
  it('rejects out of range amounts, malformed IDs and invalid timestamps', () => {
    for (const amount of [0, -1, 1000, 1.5, '273', NaN]) expect(isLedgerEntry({ ...entry, amount })).toBe(false)
    for (const patch of [{ id: 'invalid' }, { recordedAt: -1 }, { recordedAt: 4102444800001 }, { uptimeMs: -1 }, { uptimeMs: 0.5 }]) {
      expect(isLedgerEntry({ ...entry, ...patch })).toBe(false)
    }
    expect(isLedgerEntry(null)).toBe(false)
  })
})

it('changes Beijing calendar day exactly at UTC 16:00', () => {
  const midnight = Date.parse('2026-10-28T16:00:00Z')
  expect(ledgerDay(midnight) - ledgerDay(midnight - 1)).toBe(1)
  expect(ledgerDay(midnight + 86399999)).toBe(ledgerDay(midnight))
})
