import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('plays actual PCM ring-buffer code across wrap, underrun, EOF, cancellation and I2S errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-pcm-tests-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'audio.c'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp(`(?:static )?(?:esp_err_t|bool) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing PCM function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const constants = ['AUDIO_BLOCK_FRAMES', 'AUDIO_IO_TIMEOUT_MS', 'PCM_BUFFER_FRAMES', 'TONE_DRAIN_US']
      .map(name => source.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    writeFileSync(join(root, 'esp_err.h'), `#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_ARG 1
#define ESP_ERR_INVALID_STATE 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_TIMEOUT 4
`)
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "audio.h"
${constants}
#define portMAX_DELAY (-1)
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
typedef void *i2s_chan_handle_t;
static int audio_mutex = 1;
static audio_snapshot_t state = {.ready=true,.volume=50};
static i2s_chan_handle_t microphone_channel, speaker_channel;
static bool microphone_enabled, speaker_enabled, pcm_active, pcm_finished;
static int16_t *pcm_buffer;
static size_t pcm_head, pcm_size;
static int16_t speaker_samples[AUDIO_BLOCK_FRAMES * 2];
static const uint8_t *voice_buffer;
static int64_t voice_until_us, tone_drain_until_us, clock_us;
static int16_t delivered[(PCM_BUFFER_FRAMES + 1000) * 2];
static size_t delivered_samples;
static bool fail_alloc, partial_write;
static int start_error, write_error, stop_error, gates;
static void xSemaphoreTake(int m,int t) { (void)m;(void)t; }
static void xSemaphoreGive(int m) { (void)m; }
static int64_t esp_timer_get_time(void) { return clock_us; }
static int safe_audio_pins(bool m) { (void)m;return ESP_OK; }
static int i2s_channel_disable(i2s_chan_handle_t c) { (void)c;return stop_error; }
static int i2s_del_channel(i2s_chan_handle_t c) { (void)c;return stop_error; }
static void *heap_caps_malloc(size_t n,int caps) { assert(caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));return fail_alloc?NULL:malloc(n); }
static int lights_with_shared_power(int (*operation)(void *),void *arg) { gates++;return operation(arg); }
static int i2s_channel_write(i2s_chan_handle_t c,const void *data,size_t n,size_t *written,int timeout) {
  assert(c && timeout==AUDIO_IO_TIMEOUT_MS && n<=sizeof(speaker_samples));
  *written=partial_write?n/2:n;
  if(!write_error && !partial_write) {
    assert(delivered_samples+n/2<=sizeof(delivered)/sizeof(*delivered));
    memcpy(delivered+delivered_samples,data,n);delivered_samples+=n/2;
  }
  clock_us+=(int64_t)(n/4)*1000000/AUDIO_SAMPLE_RATE;
  return write_error;
}
${extract('stop_channel')}
static int start_channel(bool microphone) {
  assert(!microphone);int err=stop_channel(false);if(err)return err;
  if(start_error)return start_error;speaker_channel=(void *)1;speaker_enabled=true;return ESP_OK;
}
${['pcm_playback_step', 'start_pcm', 'audio_pcm_start', 'audio_pcm_write', 'audio_pcm_finish', 'audio_stop_speaker'].map(extract).join('\n')}
static void reset(void) {
  stop_error=0;assert(audio_stop_speaker()==ESP_OK);
  delivered_samples=0;state.voice_completed=false;state.speaker_error=0;
  write_error=start_error=0;partial_write=false;
}
int main(void) {
  int16_t values[PCM_BUFFER_FRAMES], tail[400];
  for(size_t i=0;i<PCM_BUFFER_FRAMES;i++)values[i]=(int16_t)((int)(i%20000)-10000);
  for(size_t i=0;i<400;i++)tail[i]=(int16_t)(22000+(int)i);
  assert(audio_pcm_write(values,1)==ESP_ERR_INVALID_STATE);
  assert(audio_pcm_finish()==ESP_ERR_INVALID_STATE);
  assert(audio_pcm_write(NULL,1)==ESP_ERR_INVALID_ARG);
  assert(audio_pcm_write(values,PCM_BUFFER_FRAMES+1)==ESP_ERR_INVALID_ARG);
  state.recording=true;assert(audio_pcm_start()==ESP_ERR_INVALID_STATE);state.recording=false;
  fail_alloc=true;assert(audio_pcm_start()==ESP_ERR_NO_MEM);fail_alloc=false;
  start_error=37;assert(audio_pcm_start()==37 && !state.speaker_playing);reset();
  assert(audio_pcm_start()==ESP_OK && gates>0 && !state.voice_completed);
  assert(audio_pcm_start()==ESP_ERR_INVALID_STATE);
  assert(audio_pcm_write(values,PCM_BUFFER_FRAMES-100)==ESP_OK);
  assert(pcm_playback_step() && pcm_head==AUDIO_BLOCK_FRAMES);
  size_t before=pcm_size;assert(audio_pcm_write(tail,400)==ESP_ERR_NO_MEM && pcm_size==before);
  // This write crosses the ring's physical end; old queued samples stay intact.
  assert(audio_pcm_write(tail,200)==ESP_OK);
  assert(audio_pcm_finish()==ESP_OK && audio_pcm_finish()==ESP_OK);
  assert(audio_pcm_write(tail,1)==ESP_ERR_INVALID_STATE);
  while(pcm_size)assert(pcm_playback_step());
  assert(delivered_samples==(PCM_BUFFER_FRAMES-100+200)*2 && state.speaker_playing && !state.voice_completed);
  for(size_t i=0;i<delivered_samples/2;i++) {
    int16_t expected=(i<PCM_BUFFER_FRAMES-100?values[i]:tail[i-(PCM_BUFFER_FRAMES-100)])/2;
    assert(delivered[i*2]==expected && delivered[i*2+1]==expected);
  }
  clock_us=tone_drain_until_us-1;assert(!pcm_playback_step() && state.speaker_playing);
  clock_us++;assert(!pcm_playback_step() && !state.speaker_playing && state.voice_completed);
  // Underrun is not EOF and does not stop future writes.
  reset();assert(audio_pcm_start()==ESP_OK && audio_pcm_write(tail,20)==ESP_OK);
  assert(pcm_playback_step());clock_us+=TONE_DRAIN_US*2;
  assert(!pcm_playback_step() && state.speaker_playing && !state.voice_completed);
  assert(audio_pcm_write(tail,30)==ESP_OK && pcm_playback_step());
  assert(audio_stop_speaker()==ESP_OK && !pcm_active && !pcm_size && !state.voice_completed);
  // Empty replies can finish; a stopped stream cannot accept stale PCM.
  assert(audio_pcm_write(tail,1)==ESP_ERR_INVALID_STATE);
  assert(audio_pcm_start()==ESP_OK && audio_pcm_finish()==ESP_OK);
  assert(!pcm_playback_step() && state.voice_completed && !state.speaker_playing);
  // Failed/partial DMA writes never claim successful completion.
  reset();assert(audio_pcm_start()==ESP_OK && audio_pcm_write(tail,10)==ESP_OK);
  partial_write=true;assert(pcm_playback_step() && state.speaker_error==ESP_ERR_TIMEOUT && !state.voice_completed && !state.speaker_playing);
  reset();assert(audio_pcm_start()==ESP_OK && audio_pcm_write(tail,10)==ESP_OK);
  write_error=51;assert(pcm_playback_step() && state.speaker_error==51 && !state.voice_completed);
  reset();assert(audio_pcm_start()==ESP_OK && audio_pcm_finish()==ESP_OK);stop_error=62;
  assert(!pcm_playback_step() && state.speaker_error==62 && !state.voice_completed);
  stop_error=0;assert(audio_stop_speaker()==ESP_OK);free(pcm_buffer);
  puts("PCM streaming checks passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir, join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('PCM streaming checks passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('lets a waiting audio snapshot run between active I/O blocks without sleeping a tick', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-audio-scheduling-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'audio.c'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp(`(?:static )?void ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing audio function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const constants = ['AUDIO_BLOCK_FRAMES', 'AUDIO_IO_TIMEOUT_MS', 'MIC_WARMUP_US', 'MIC_STALL_US',
      'TONE_FADE_FRAMES', 'LIVE_FRAME_FRAMES', 'LIVE_FRAME_BYTES', 'TONE_DRAIN_US']
      .map(name => source.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    writeFileSync(join(root, 'esp_err.h'), `#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_TIMEOUT 4
`)
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <math.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "audio.h"
${constants}
#define portMAX_DELAY (-1)
// Model the project's 100 Hz tick. Active I/O must not add this 10 ms sleep.
#define pdMS_TO_TICKS(ms) ((ms) / 10)
static int audio_mutex = 1;
static audio_snapshot_t state, peer_snapshot;
static bool lock_held, peer_running, peer_pending;
static unsigned iterations, iteration_limit, peer_runs, yields, delays, delayed_ticks;
static int read_error, stops;
static jmp_buf completed;
static int microphone_channel = 1, speaker_channel = 2;
static bool mic_stop_requested, pcm_active, pcm_did_io;
static int microphone_stop_error;
static uint8_t *record_buffer;
static size_t record_capacity;
static const uint8_t *voice_buffer;
static size_t voice_length, voice_available;
static uint32_t voice_frame, tone_frame, tone_target_frames;
static int64_t record_deadline_us, microphone_last_data_us, microphone_started_us, tone_drain_until_us;
static int32_t microphone_samples[AUDIO_BLOCK_FRAMES * 2];
static int16_t speaker_samples[AUDIO_BLOCK_FRAMES * 2], live_chunk[LIVE_FRAME_FRAMES];
static size_t live_chunk_frames;
static audio_microphone_sink_t live_sink;
static float tone_frequency;
static uint8_t tone_volume;

static void xSemaphoreTake(int mutex, int timeout) {
  assert(mutex == audio_mutex && timeout == portMAX_DELAY && !lock_held);
  if (!peer_running) {
    if (iterations == iteration_limit) longjmp(completed, 1);
    // A release alone does not schedule an equal-priority waiter. The real
    // task must provide a scheduling point before taking the mutex again.
    if (iterations && peer_pending) longjmp(completed, 2);
    iterations++;
  }
  lock_held = true;
}
static void xSemaphoreGive(int mutex) {
  assert(mutex == audio_mutex && lock_held);
  lock_held = false;
  if (!peer_running) peer_pending = true;
}
static void schedule_peer(void) {
  assert(!lock_held && peer_pending);
  peer_running = true;
  audio_get_snapshot(&peer_snapshot);
  peer_running = false;
  peer_pending = false;
  peer_runs++;
}
void taskYIELD(void) {
  yields++;
  schedule_peer();
}
static void vTaskDelay(int ticks) {
  assert(ticks > 0);
  delays++;
  delayed_ticks += ticks;
  schedule_peer();
}
static int64_t esp_timer_get_time(void) { return 200000; }
static void finish_live_capture(void) { assert(lock_held); live_sink = NULL; live_chunk_frames = 0; }
static int stop_channel(bool microphone) {
  assert(lock_held); stops++;
  if (microphone) state.microphone_active = false;
  else state.speaker_playing = false;
  return ESP_OK;
}
static int i2s_channel_read(int channel, void *data, size_t size, size_t *bytes, int timeout) {
  assert(lock_held && channel == microphone_channel && timeout == AUDIO_IO_TIMEOUT_MS);
  memset(data, 0, size); *bytes = read_error ? 0 : size;
  return read_error;
}
static int i2s_channel_write(int channel, const void *data, size_t size, size_t *written, int timeout) {
  assert(lock_held && channel == speaker_channel && data && timeout == AUDIO_IO_TIMEOUT_MS);
  *written = size; return ESP_OK;
}
static void update_microphone(size_t frames, int64_t now) { assert(lock_held && frames && now > 0); }
static uint8_t mulaw_encode(int value) { return (uint8_t)value; }
static int16_t mulaw_decode(uint8_t value) { return value; }
static bool pcm_playback_step(void) { assert(lock_held); return pcm_did_io; }
${extract('audio_get_snapshot')}
${extract('audio_task')}

static void run_blocks(bool microphone, bool pcm, int error, unsigned blocks) {
  state = (audio_snapshot_t){.ready = true, .microphone_active = microphone};
  peer_snapshot = (audio_snapshot_t){0};
  lock_held = peer_running = peer_pending = false;
  iterations = peer_runs = yields = delays = delayed_ticks = 0;
  iteration_limit = blocks; read_error = error; stops = 0;
  pcm_active = pcm_did_io = pcm;
  const int reason = setjmp(completed);
  if (!reason) audio_task(NULL);
  // Old give/immediate-retake behavior exits with reason 2, before the
  // snapshot caller can make progress. No host thread timing is involved.
  assert(reason == 1 && iterations == blocks && peer_runs == blocks);
  assert(!lock_held && !peer_pending && peer_snapshot.ready);
}
int main(void) {
  run_blocks(true, false, ESP_OK, 4);
  assert(yields == 4 && delays == 0 && delayed_ticks == 0 && peer_snapshot.microphone_active);
  run_blocks(false, true, ESP_OK, 4);
  assert(yields == 4 && delays == 0 && delayed_ticks == 0);
  run_blocks(true, false, 29, 1);
  assert(yields == 1 && delays == 0 && stops == 1 && state.microphone_error == 29);
  assert(!peer_snapshot.microphone_active);
  run_blocks(false, false, ESP_OK, 4);
  assert(yields == 0 && delays == 4 && delayed_ticks == 4 * (pdMS_TO_TICKS(10) + 1));
  puts("Audio scheduling checks passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir, join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('Audio scheduling checks passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
