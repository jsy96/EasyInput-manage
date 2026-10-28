import { describe, expect, it } from 'vitest'
import { healthCsv, ledgerCsv, voiceZip, voiceZipBatches } from './downloads'
import type { HealthRecord } from '@shared/health'

describe('history downloads', () => {
  it('exports every ledger entry in save order with integer CNY and explicit unknown times', () => {
    const base = { id: 'a'.repeat(32), amount: 273, recordedAt: null, uptimeMs: 1, receivedAt: 1793145600000, sequence: 1 }
    const csv = ledgerCsv([{ ...base, id: 'b'.repeat(32), sequence: 2, recordedAt: 1793145600000 }, base])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"273","元（人民币）"')
    expect(csv).toContain('"","未知（设备时钟未校准）"')
    expect(csv).toContain('2026-10-28T00:00:00.000Z')
    expect(csv.indexOf(base.id)).toBeLessThan(csv.indexOf('b'.repeat(32)))
    expect(csv.split('\r\n')).toHaveLength(4)
  })
  it('exports every measurement including repeated values and unknown measurement times', () => {
    const base: HealthRecord = { id: 'a'.repeat(32), kind: 'father_glucose', value: 75, measuredAt: null, uptimeMs: 123, receivedAt: 1793145600000, sequence: 1 }
    const csv = healthCsv([{ ...base, id: 'b'.repeat(32), kind: 'mother_high', value: 130, sequence: 2 }, base, { ...base, id: 'c'.repeat(32), measuredAt: 1793145600000, sequence: 3 }])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"爸爸","血糖","7.5","mmol/L"')
    expect(csv).toContain('"妈妈","收缩压（高压）","130","mmHg"')
    expect(csv).toContain('未知（设备时钟未校准）')
    expect(csv.split('\r\n')).toHaveLength(5)
    expect(csv.indexOf(base.id)).toBeLessThan(csv.indexOf('b'.repeat(32)))
  })
  it('builds ZIP local entries, UTF-8 paths, checksums and central directory offsets', async () => {
    const zip = await voiceZip([{ name: '001_开发板.wav', blob: new Blob(['123456789']) }, { name: '002.wav', blob: new Blob(['audio']) }])
    const bytes = await zip.arrayBuffer(), view = new DataView(bytes), end = bytes.byteLength - 22
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(6, true)).toBe(0x800)
    expect(view.getUint32(14, true)).toBe(0xcbf43926)
    const nameSize = view.getUint16(26, true)
    expect(new TextDecoder().decode(bytes.slice(30, 30 + nameSize))).toBe('001_开发板.wav')
    expect(new TextDecoder().decode(bytes.slice(30 + nameSize, 30 + nameSize + 9))).toBe('123456789')
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)
    const central = view.getUint32(end + 16, true)
    expect(view.getUint32(central, true)).toBe(0x02014b50)
    expect(view.getUint32(central + 42, true)).toBe(0)
    expect(view.getUint32(central + 46 + nameSize + 42, true)).toBe(30 + nameSize + 9)
  })
})

it('partitions all 5000 voices into bounded ZIP batches without duplicates', () => {
  const messages = Array.from({ length: 5000 }, (_, i) => ({ id: `synthetic-${i}`, sender: 'board', name: 'Synthetic test', samples: 160000, created: i + 1, read: false }))
  const batches = voiceZipBatches(messages)
  expect(batches).toHaveLength(50)
  expect(batches.every(batch => batch.length === 100)).toBe(true)
  expect(batches.flat()).toEqual(messages)
  expect(voiceZipBatches(messages.slice(0, 101)).map(batch => batch.length)).toEqual([100, 1])
})
