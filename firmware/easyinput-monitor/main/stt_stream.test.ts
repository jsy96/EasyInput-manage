import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves ten minutes of numbered samples through wraparound, delayed sends, overflow, and the final partial frame', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-stream-'))
  try {
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "stt_stream.h"
static uint8_t sample(size_t offset) { return (uint8_t)((offset * 13 + offset / 251) % 256); }
static void check(const uint8_t *data, size_t offset, size_t length) {
  for (size_t i = 0; i < length; i++) assert(data[i] == sample(offset + i));
}
int main(void) {
  // Deliberately not a multiple of either 20 ms capture or 60 ms transport.
  uint8_t storage[8191], input[640], frame[1920], replay[1920];
  stt_stream_t s; stt_stream_init(&s, storage, sizeof storage);
  size_t sent = 0, produced = 0;
  const size_t total = 16000 * 2 * 600 + 218;
  for (size_t iteration = 0; produced < total; iteration++) {
    size_t n = total - produced; if (n > sizeof input) n = sizeof input;
    for (size_t i = 0; i < n; i++) input[i] = sample(produced + i);
    assert(stt_stream_write(&s, input, n)); produced += n;
    // Network sometimes stalls; the next call drains queued frames in order.
    if (iteration % 11 >= 4) {
      while (s.size >= sizeof frame) {
        assert(stt_stream_peek(&s, frame, sizeof frame) == sizeof frame);
        check(frame, sent, sizeof frame);
        // Failed/delayed transmission must not consume or replace this frame.
        assert(stt_stream_peek(&s, replay, sizeof replay) == sizeof replay);
        assert(!memcmp(frame, replay, sizeof frame));
        assert(stt_stream_consume(&s, sizeof frame)); sent += sizeof frame;
      }
    }
  }
  while (s.size) {
    size_t n = stt_stream_peek(&s, frame, sizeof frame); assert(n);
    check(frame, sent, n); assert(stt_stream_consume(&s, n)); sent += n;
  }
  assert(sent == total && s.accepted == total && s.consumed == total && !s.overflow);
  assert(!stt_stream_consume(&s, 1));
  stt_stream_init(&s, storage, sizeof storage);
  memset(input, 7, sizeof input);
  while (s.capacity - s.size >= sizeof input) assert(stt_stream_write(&s, input, sizeof input));
  size_t prior = s.size; uint64_t accepted = s.accepted;
  assert(!stt_stream_write(&s, input, sizeof input));
  assert(s.size == prior && s.accepted == accepted && s.overflow);
  while (s.size) {
    size_t n = stt_stream_peek(&s, frame, sizeof frame);
    for (size_t i = 0; i < n; i++) assert(frame[i] == 7);
    assert(stt_stream_consume(&s, n));
  }
  stt_stream_init(&s, storage, sizeof storage);
  assert(!s.overflow && !s.accepted && !s.consumed && !s.size);
  assert(stt_stream_write(&s, NULL, 0));
  puts("stream continuity passed");
}
`)
    const source = resolve('firmware/easyinput-monitor/main')
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', source,
      join(source, 'stt_stream.c'), join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('stream continuity passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('flushes a final short microphone block once before detaching the stream', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-tail-'))
  try {
    const audio = readFileSync(resolve('firmware/easyinput-monitor/main/audio.c'), 'utf8')
    const start = audio.indexOf('static void finish_live_capture(void)')
    if (start < 0) throw new Error('Missing final microphone block flush')
    const flush = audio.slice(start, audio.indexOf('\n}\n', start) + 3)
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
static int16_t live_chunk[320];
static size_t live_chunk_frames, received, calls;
static void check(const uint8_t *data, size_t length) {
  const int16_t *samples = (const int16_t *)data;
  assert(length == 137 * sizeof(int16_t));
  for (int i = 0; i < 137; i++) assert(samples[i] == i * 3);
  calls++; received += length;
}
static void (*live_sink)(const uint8_t *, size_t) = check;
${flush}
int main(void) {
  for (int i = 0; i < 137; i++) live_chunk[i] = i * 3;
  live_chunk_frames = 137;
  finish_live_capture();
  assert(calls == 1 && received == 274 && !live_sink && !live_chunk_frames);
  finish_live_capture(); assert(calls == 1);
  live_sink = check;
  finish_live_capture(); assert(calls == 1 && !live_sink);
  puts("microphone tail passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('microphone tail passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
