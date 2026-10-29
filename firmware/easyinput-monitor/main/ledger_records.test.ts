import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'

it('runs the actual ledger and measurement C code against isolated synthetic storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-record-tests-'))
  try {
    const source = resolve('firmware/easyinput-monitor/main')
    const voice = readFileSync(join(source, 'voice_chat.c'), 'utf8')
    const extractFunction = (name: string): string => {
      const start = voice.search(new RegExp(`static (?:void|bool|int64_t) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing input function ${name}`)
      return voice.slice(start, voice.indexOf('\n}\n', start) + 3)
    }
    const enums = ['job_t', 'ui_mode_t', 'prompt_action_t'].map(name => {
      const end = voice.indexOf(`} ${name};`) + `} ${name};`.length
      return voice.slice(voice.lastIndexOf('typedef enum {', end), end)
    }).join('\n')
    const timerEvents = readFileSync(join(source, 'timers.h'), 'utf8').match(/typedef enum \{[\s\S]*?\} timer_event_t;/)?.[0]
    if (!timerEvents) throw new Error('Missing timer event enum')
    writeFileSync(join(root, 'input.inc'), `
#include "voice_prompts.h"
#define LONG_US 1200000
#define SETUP_LONG_US 3000000
#define PROMPT_SEQUENCE_CAPACITY 128
#define STOPWATCH_RESULT_CAPACITY 8
${enums}
${timerEvents}
static job_t job;
static ui_mode_t mode;
static prompt_action_t prompt_action;
static bool send_when_saved, prompt_playing, mark_all_read_confirming, realtime_active, setup_waiting, volume_announce_pending;
static bool key_held[9], key_long_handled[9], key_consumed[9];
static int64_t key_down[9], settings_commit_at, retry_at, alarm_fired_at_us, setup_deadline, input_timestamp;
static char hold_id[65], discarded_id[65];
static int alarm_draft, timer_draft, last_prompt;
static unsigned diag_s5_events, diag_s6_down_events, diag_s6_up_events, diag_s6_actions, diag_s7_events, diag_last_key_mode;
static bool stt_busy, stt_pending, stt_s6_pressed, stt_s7_pressed, stt_text_session;
static bool stt_text_result_pending, stt_text_failed, stt_engine_started, stt_round_started, stt_end_announced, stt_terminal_received;
static int64_t stt_delivery_deadline;
static int stt_stops, text_stops;
static unsigned deferred_timer_events;
static uint32_t stopwatch_results[STOPWATCH_RESULT_CAPACITY];
static unsigned stopwatch_result_head, stopwatch_result_count;
static bool stopwatch_start_pending, stopwatch_busy_pending, stopwatch_active;
static int64_t stopwatch_started_at;
static int prompt_length;
static bool timers_stopwatch_active(void) { return stopwatch_active; }
static void timers_start_stopwatch(int64_t now) { stopwatch_active=true; stopwatch_started_at=now; }
static uint32_t timers_stop_stopwatch(int64_t now) { stopwatch_active=false; return (uint32_t)((now-stopwatch_started_at)/1000000); }
typedef struct { bool capturing; } stt_snapshot_t;
static bool stt_capturing;
static bool xiaozhi_stt_busy(void) { return stt_busy; }
static void xiaozhi_dialogue_stop(void) { stt_stops++; stt_capturing=false; }
static void xiaozhi_stt_stop(void) { text_stops++; stt_capturing=false; }
static void xiaozhi_stt_get_snapshot(stt_snapshot_t *s) { *s=(stt_snapshot_t){.capturing=stt_capturing}; }
static bool xiaozhi_stt_pending(void *t) { (void)t; return stt_pending; }
static int diag_last_key, stopped, released, uploads, setup_calls, volume_changes, stop_error, discard_error;
static unsigned speaker_volume;
static bool ordinary_recording;
static void stop_prompt(void) { prompt_playing = false; prompt_action = PROMPT_ACTION_NONE; }
static void start_prompt(int p, prompt_action_t a) { last_prompt = p; prompt_playing = true; prompt_action = a; }
static void stt_feedback(const int *ids, int n) { if (n) start_prompt(ids[0], PROMPT_ACTION_NONE); }
static void append_prompt(int *ids, int *n, int p) { ids[(*n)++] = p; }
static void append_number(int *ids, int *n, int p) { ids[(*n)++] = p; }
static void start_prompt_sequence(const int *ids, int n, prompt_action_t a) { if (n) start_prompt(ids[0], a); }
static void stop_message_playback(void) { if (mode == MODE_PLAYING) mode = MODE_IDLE; }
static int audio_record_stop(void) { stopped++; return stop_error; }
static int voice_outbox_discard(const char *id) { strcpy(discarded_id, id); return discard_error; }
static void release_audio(void) { released++; }
static void finish_job(void) { job = JOB_IDLE; }
static void upload_begin(void) { uploads++; job = JOB_UP_BEGIN; }
static void play_previous_message(void) {}
static void *earliest_unread(void) { return NULL; }
static void play_message(void *p) { (void)p; }
static void begin_alarm_setting(void) {}
static void begin_timer_setting(void) {}
static void cancel_countdown(bool p) { (void)p; }
static bool network_fresh(int64_t t) { (void)t; return true; }
static void mark_all_unread_read(void) {}
static bool timers_set_alarm_minute(int n) { (void)n; return true; }
static int timers_countdown_seconds(void) { return 60; }
static int audio_play_beep(uint16_t ms, bool strong) { (void)ms; (void)strong; return 0; }
static void network_setup_begin(void) { setup_calls++; }
typedef struct { unsigned volume; bool recording, speaker_playing; } audio_snapshot_t;
static void audio_get_snapshot(audio_snapshot_t *a) { *a = (audio_snapshot_t){.volume = speaker_volume, .recording = ordinary_recording}; }
static int audio_set_volume(uint8_t v) { speaker_volume=v; volume_changes++; return 0; }
static void announce_alarm_draft(void) {}
static void announce_timer_draft(void) {}
static void announce_volume(void) {}
static bool uploading(void) { return job == JOB_UP_BEGIN || job == JOB_UP_CHUNK || job == JOB_UP_COMMIT; }
static bool on_long_key(int key);
${['toggle_stopwatch', 'begin_recording_with_prompt', 'begin_dialogue', 'begin_transcription', 'cancel_recording', 'on_short_key', 'key_long_threshold', 'on_stt_key', 'on_key', 'on_long_key', 'on_rotate', 'append_duration', 'handle_timer_events'].map(extractFunction).join('\n')}
static void reset_input(void) {
  mode = MODE_IDLE; job = JOB_IDLE; stop_prompt();
  stt_busy = stt_pending = stt_capturing = false;
  stt_s6_pressed = stt_s7_pressed = stt_text_session = stt_text_result_pending = stt_text_failed = stt_engine_started = false;
  stt_stops = text_stops = 0; stt_delivery_deadline = 0;
  deferred_timer_events = 0;
  stopwatch_active=stopwatch_start_pending=stopwatch_busy_pending=false;
  stopwatch_result_head=stopwatch_result_count=0;
  stt_round_started = stt_end_announced = stt_terminal_received = false;
  memset(key_down, 0, sizeof key_down); memset(key_held, 0, sizeof key_held);
  memset(key_long_handled, 0, sizeof key_long_handled); memset(key_consumed, 0, sizeof key_consumed);
  hold_id[0] = discarded_id[0] = 0;
  stopped = released = uploads = setup_calls = volume_changes = stop_error = discard_error = 0;
  realtime_active = send_when_saved = mark_all_read_confirming = ordinary_recording = setup_waiting = volume_announce_pending = false;
  input_timestamp=0; speaker_volume=20;
}
static void press_key(int key, int64_t duration) {
  on_key(key, true); monotonic_us += duration; on_key(key, false);
}
static void test_inputs(void) {
  // Keep a real persisted measurement while exercising the new input routing.
  // S7/S8 must not create or alter any health or ledger data.
  sizes[0] = sizes[1] = 0; ledger_records_init(); health_records_init();
  health_edit_t old_health; health_edit_begin(&old_health, HEALTH_MOTHER_HIGH);
  health_edit_refine(&old_health); health_edit_rotate(&old_health, 9); assert(health_edit_save(&old_health));
  const size_t history_bytes=sizes[0]; unsigned char original_health[8192]; memcpy(original_health,disk[0],history_bytes);
  reset_input(); press_key(6, 50000);
  assert(mode == MODE_STT && stt_text_session && prompt_action == PROMPT_ACTION_START_STT);
  press_key(7, 50000); assert(mode == MODE_STT && prompt_action == PROMPT_ACTION_START_STT);
  assert(health_pending_count() == 1 && ledger_pending_count() == 0);
  reset_input(); press_key(7, 50000); press_key(7, 3000000);
  assert(mode == MODE_IDLE && !prompt_playing && setup_calls == 0);
  assert(sizes[0] == history_bytes && !memcmp(disk[0],original_health,history_bytes));
  int latest; assert(health_record_get(HEALTH_MOTHER_HIGH,&latest) && latest == 139);
  reset_input(); mode=MODE_SETTING_ALARM; alarm_draft=600; last_prompt=PROMPT_ALARM_PREFIX;
  press_key(7,50000); assert(mode==MODE_SETTING_ALARM && alarm_draft==600 && last_prompt==PROMPT_ALARM_PREFIX);
  reset_input(); mode=MODE_RECORDING; send_when_saved=true; press_key(7,3000000);
  assert(mode==MODE_RECORDING && send_when_saved && stopped==0 && !prompt_playing);

  reset_input(); press_key(4, 50000); assert(prompt_action == PROMPT_ACTION_START_RECORDING);
  press_key(4, 3000000);
  assert(last_prompt == PROMPT_RECORD_CANCELLED && mode == MODE_IDLE);
  reset_input(); mode = MODE_RECORDING; press_key(4, 50000);
  assert(send_when_saved && stopped == 1 && released == 0);
  reset_input(); mode = MODE_RECORDING; press_key(4, 3000000);
  assert(mode == MODE_IDLE && !send_when_saved && stopped == 1 && released == 1 && uploads == 0);
  reset_input(); mode = MODE_RECORDING; stop_error = 1; press_key(4, 3000000);
  assert(mode == MODE_RECORDING && !send_when_saved && released == 0 && last_prompt == PROMPT_RECORD_CANCEL_FAILED);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft");
  press_key(4, 3000000);
  assert(hold_id[0] == 0 && strcmp(discarded_id, "synthetic-current-draft") == 0 && uploads == 0);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft"); discard_error=1;
  press_key(4,3000000); assert(!strcmp(hold_id,"synthetic-current-draft") && last_prompt==PROMPT_RECORD_CANCEL_FAILED);
  assert(mode==MODE_RECORD_READY && released==0 && uploads==0);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft");
  press_key(4, 50000); assert(hold_id[0] == 0 && uploads == 1 && send_when_saved);
  // A short/long press outside the current unsent slot never discards an upload.
  reset_input(); job=JOB_UP_CHUNK; mode=MODE_IDLE; on_long_key(4);
  assert(job==JOB_UP_CHUNK && !discarded_id[0] && !released && !uploads);
  reset_input(); job=JOB_CACHE; mode=MODE_RECORD_READY; press_key(4,3000000);
  assert(job==JOB_IDLE && mode==MODE_IDLE && released==1 && uploads==0);

  reset_input(); realtime_active=true; press_key(6,50000);
  assert(!stt_text_session && realtime_active && last_prompt==PROMPT_TRANSCRIPT_FAILURE);
  reset_input(); on_rotate(1); assert(volume_changes==1 && speaker_volume==30);
  on_rotate(-5); assert(speaker_volume==10); on_rotate(20); assert(speaker_volume==100);
  reset_input(); ordinary_recording=true; mode=MODE_RECORDING; on_rotate(1);
  assert(volume_announce_pending && speaker_volume==30 && !prompt_playing);
  reset_input(); press_key(8,3000000); assert(setup_calls==1 && setup_waiting);

  // Conversation controls neither alter legacy records nor resurrect a held key.
  reset_input(); mode=MODE_STT; stt_busy=stt_capturing=true;
  press_key(6,50000); press_key(4,50000); press_key(7,50000);
  assert(stt_stops==0 && text_stops==0 && health_pending_count()==1);
  on_rotate(1); assert(volume_changes==1 && speaker_volume==30 && !prompt_playing);
  reset_input(); mode=MODE_STT; stt_busy=true;
  on_key(6,true); monotonic_us+=50000; mode=MODE_IDLE; stt_busy=false;
  on_key(6,false); assert(mode==MODE_IDLE && !stt_text_session);
  reset_input(); mode=MODE_STT; stt_busy=true;
  on_key(8,true); monotonic_us+=3000000; mode=MODE_IDLE; stt_busy=false;
  on_key(8,false); assert(setup_calls==0 && prompt_action==PROMPT_ACTION_NONE);
  // Timers wait until the conversation exits before any speaker prompt.
  reset_input(); mode=MODE_STT; stt_busy=true;
  handle_timer_events(TIMER_EVENT_ALARM,monotonic_us);
  assert(deferred_timer_events==TIMER_EVENT_ALARM && !prompt_playing && mode==MODE_STT);
  stt_busy=false; mode=MODE_IDLE; handle_timer_events(TIMER_EVENT_NONE,monotonic_us);
  assert(!deferred_timer_events && prompt_playing && last_prompt==PROMPT_ALARM_DUE);
  reset_input(); mode=MODE_STT; stt_busy=true; stt_text_session=true;
  handle_timer_events(TIMER_EVENT_DONE|TIMER_EVENT_MINUTE,monotonic_us);
  assert(deferred_timer_events==TIMER_EVENT_DONE && !prompt_playing && mode==MODE_STT);
  stt_busy=false; mode=MODE_IDLE; handle_timer_events(TIMER_EVENT_NONE,monotonic_us);
  assert(!deferred_timer_events && last_prompt==PROMPT_COUNTDOWN_DONE);
  health_records_init(); assert(health_pending_count()==1 && health_record_get(HEALTH_MOTHER_HIGH,&latest) && latest==139);
  assert(sizes[0]==history_bytes && !memcmp(disk[0],original_health,history_bytes));
  puts("synthetic input routing and long press checks passed");
}
`)
    writeFileSync(join(root, 'nvs.h'), `#pragma once
#include <stddef.h>
#include <stdint.h>
typedef int esp_err_t;
typedef int nvs_handle_t;
#define ESP_OK 0
#define ESP_ERR_NVS_NOT_FOUND 2
#define NVS_READWRITE 0
int nvs_open(const char *, int, nvs_handle_t *);
int nvs_set_blob(nvs_handle_t, const char *, const void *, size_t);
int nvs_get_blob(nvs_handle_t, const char *, void *, size_t *);
int nvs_get_u16(nvs_handle_t, const char *, uint16_t *);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
`)
    writeFileSync(join(root, 'esp_timer.h'), '#pragma once\n#include <stdint.h>\nint64_t esp_timer_get_time(void);\n')
    writeFileSync(join(root, 'esp_random.h'), '#pragma once\n#include <stddef.h>\nvoid esp_fill_random(void *, size_t);\n')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "nvs.h"
#include "health_records.h"
#include "ledger_records.h"
static unsigned char disk[2][8192], staged[2][8192];
static size_t sizes[2], staged_sizes[2];
static int fail_commit;
static unsigned serial;
static time_t clock_seconds;
static int64_t monotonic_us = 12345000;
int nvs_open(const char *name, int mode, nvs_handle_t *h) { (void)mode; *h = strcmp(name, "ledger") == 0; return 0; }
int nvs_set_blob(int h, const char *key, const void *data, size_t n) { (void)key; assert(n <= sizeof disk[h]); memcpy(staged[h], data, n); staged_sizes[h] = n; return 0; }
int nvs_get_blob(int h, const char *key, void *data, size_t *n) { (void)key; if (!sizes[h]) return 2; assert(*n >= sizes[h]); *n = sizes[h]; memcpy(data, disk[h], *n); return 0; }
int nvs_get_u16(int h, const char *key, uint16_t *v) { (void)h; (void)key; (void)v; return 2; }
int nvs_commit(int h) { if (fail_commit) return 1; memcpy(disk[h], staged[h], staged_sizes[h]); sizes[h] = staged_sizes[h]; return 0; }
void nvs_close(int h) { (void)h; }
void esp_fill_random(void *p, size_t n) { memset(p, 0, n); memcpy(p, &(unsigned){++serial}, sizeof serial); }
int64_t esp_timer_get_time(void) { return monotonic_us; }
time_t mock_time(time_t *p) { if (p) *p = clock_seconds; return clock_seconds; }
#include "input.inc"
int main(void) {
  ledger_records_init(); health_records_init();
  ledger_edit_t e; ledger_pending_t pending, saved;
  ledger_edit_begin(&e);
  assert(e.active && !e.ones && e.high == 0 && e.digit == 0);
  ledger_edit_rotate(&e, 27);
  assert(e.high == 27 && ledger_edit_amount(&e) == 270 && !ledger_edit_save(&e));
  assert(ledger_pending_count() == 0);
  e.ones = true; ledger_edit_rotate(&e, 3);
  assert(ledger_edit_amount(&e) == 273 && ledger_edit_save(&e) && !e.active);
  assert(ledger_pending_oldest(&pending) && pending.amount == 273 && pending.recorded_at_ms == 0 && pending.uptime_ms == 12345);
  saved = pending;
  ledger_records_init(); assert(ledger_pending_count() == 1);
  assert(ledger_pending_oldest(&pending) && strcmp(pending.id, saved.id) == 0);
  ledger_edit_begin(&e); ledger_edit_rotate(&e, 15); ledger_edit_cancel(&e);
  assert(!e.active && !ledger_edit_save(&e) && ledger_pending_count() == 1);
  ledger_edit_begin(&e); e.ones = true;
  assert(!ledger_edit_save(&e) && e.active);
  ledger_edit_rotate(&e, 1); fail_commit = 1;
  assert(!ledger_edit_save(&e) && ledger_pending_count() == 1);
  assert(!ledger_pending_ack(saved.id) && ledger_pending_count() == 1);
  fail_commit = 0;
  ledger_records_init(); assert(ledger_pending_count() == 1);
  assert(!ledger_pending_ack("wrong-id") && ledger_pending_ack(saved.id));
  ledger_records_init(); assert(ledger_pending_count() == 0);
  clock_seconds = 1793145600;
  for (int i = 0; i < LEDGER_PENDING_CAPACITY; i++) {
    ledger_edit_begin(&e); ledger_edit_rotate(&e, INT_MAX);
    assert(e.high == 99); ledger_edit_rotate(&e, INT_MIN); assert(e.high == 0);
    ledger_edit_rotate(&e, 99); e.ones = true; ledger_edit_rotate(&e, INT_MAX);
    assert(e.digit == 9 && ledger_edit_amount(&e) == 999 && ledger_edit_save(&e));
  }
  assert(ledger_pending_oldest(&pending) && pending.recorded_at_ms == 1793145600000LL);
  saved = pending;
  ledger_edit_begin(&e); e.ones = true; ledger_edit_rotate(&e, 1);
  assert(!ledger_edit_save(&e) && ledger_pending_count() == LEDGER_PENDING_CAPACITY);
  ledger_records_init(); assert(ledger_pending_count() == LEDGER_PENDING_CAPACITY);
  assert(ledger_pending_oldest(&pending) && strcmp(saved.id, pending.id) == 0);

  health_edit_t h; health_pending_t hp; int latest;
  health_edit_begin(&h, HEALTH_MOTHER_HIGH); assert(h.value == 130);
  health_edit_rotate(&h, 1); assert(h.value == 140 && !health_edit_save(&h));
  assert(health_pending_count() == 0);
  health_edit_refine(&h); health_edit_rotate(&h, -1);
  assert(h.value == 139 && health_edit_save(&h));
  health_records_init(); assert(health_record_get(HEALTH_MOTHER_HIGH, &latest) && latest == 139);
  health_edit_begin(&h, HEALTH_MOTHER_HIGH); health_edit_refine(&h);
  assert(health_edit_save(&h) && health_pending_count() == 2);
  health_edit_begin(&h, HEALTH_MOTHER_HIGH); health_edit_rotate(&h, -1); health_edit_cancel(&h);
  assert(!health_edit_save(&h) && health_pending_count() == 2);
  assert(health_record_get(HEALTH_MOTHER_HIGH, &latest) && latest == 139);
  health_edit_begin(&h, HEALTH_FATHER_GLUCOSE); assert(h.value == 75);
  health_edit_rotate(&h, 1); assert(h.value == 85);
  health_edit_refine(&h); health_edit_rotate(&h, 1); assert(h.value == 86);
  fail_commit = 1; assert(!health_edit_save(&h) && health_pending_count() == 2);
  fail_commit = 0; assert(!health_record_get(HEALTH_FATHER_GLUCOSE, &latest));
  assert(health_pending_oldest(&hp) && hp.value == 139);
  assert(ledger_pending_count() == LEDGER_PENDING_CAPACITY);
  // An acknowledged entry still contributes to the durable daily summary.
  while (ledger_pending_oldest(&pending)) assert(ledger_pending_ack(pending.id));
  ledger_summary_t summary;
  assert(ledger_summary_get(&summary) && summary.latest == 999 && summary.totals[0] == 64 * 999 && summary.unknown == 1);
  summary.complete = true;
  assert(ledger_summary_apply(&summary));
  ledger_records_init(); assert(ledger_summary_get(&summary) && summary.complete && summary.totals[0] == 64 * 999);
  const int64_t day = summary.day;
  clock_seconds += 86400;
  assert(ledger_summary_get(&summary) && summary.day == day + 1 && summary.totals[0] == 0 && summary.totals[1] == 64 * 999);
  summary.totals[0] = 7; fail_commit = 1;
  assert(!ledger_summary_apply(&summary)); fail_commit = 0;
  assert(ledger_summary_get(&summary) && summary.totals[0] == 0);
  ledger_edit_begin(&e); e.ones = true; ledger_edit_rotate(&e, 5); assert(ledger_edit_save(&e));
  assert(!ledger_summary_apply(&summary));
  assert(ledger_pending_oldest(&pending) && ledger_pending_ack(pending.id));
  ledger_records_init(); assert(ledger_summary_get(&summary) && summary.latest == 5 && summary.totals[0] == 5 && summary.totals[1] == 64 * 999);
  clock_seconds = 0; assert(ledger_summary_get(&summary) && !summary.complete);

  // Load the exact legacy v1 layout, keeping all pending records and requiring cloud backfill.
  typedef struct { uint32_t version, head, count; ledger_pending_t pending[64]; } legacy_t;
  legacy_t legacy = {.version = 1, .head = 63, .count = 1};
  legacy.pending[63] = pending; legacy.pending[63].amount = 42;
  memcpy(disk[1], &legacy, sizeof legacy); sizes[1] = sizeof legacy;
  ledger_records_init(); assert(ledger_pending_count() == 1 && ledger_summary_get(&summary) && summary.latest == 42 && !summary.complete);
  assert(ledger_pending_oldest(&pending) && pending.amount == 42 && ledger_pending_ack(pending.id));
  ledger_records_init(); assert(ledger_summary_get(&summary) && summary.latest == 42);
  puts("synthetic ledger and measurement storage checks passed");
  test_inputs();
}
`)
    execFileSync('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Dtime=mock_time', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable', '-I', root, '-I', source,
      join(source, 'ledger_records.c'), join(source, 'health_records.c'), join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('storage checks passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
