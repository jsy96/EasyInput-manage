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
    writeFileSync(join(root, 'input.inc'), `
#include "voice_prompts.h"
#define LONG_US 1200000
#define SETUP_LONG_US 3000000
${enums}
static job_t job;
static ui_mode_t mode;
static prompt_action_t prompt_action;
static health_edit_t health_edit;
static ledger_edit_t ledger_edit;
static bool send_when_saved, prompt_playing, mark_all_read_confirming, realtime_active, setup_waiting, volume_announce_pending;
static bool key_held[9], key_long_handled[9], key_consumed[9];
static int64_t key_down[9], settings_commit_at, retry_at, alarm_fired_at_us, setup_deadline;
static char hold_id[65], discarded_id[65];
static int alarm_draft, timer_draft, last_prompt;
static unsigned next_pressure, next_glucose, diag_s5_events, diag_s6_down_events, diag_s6_up_events, diag_s6_actions, diag_s7_events, diag_last_key_mode;
static int diag_last_key, stopped, released, uploads, setup_calls, volume_changes, stop_error, discard_error;
static void stop_prompt(void) { prompt_playing = false; prompt_action = PROMPT_ACTION_NONE; }
static void start_prompt(int p, prompt_action_t a) { last_prompt = p; prompt_playing = true; prompt_action = a; }
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
static void network_setup_begin(void) { setup_calls++; }
typedef struct { unsigned volume; bool recording; } audio_snapshot_t;
static void audio_get_snapshot(audio_snapshot_t *a) { *a = (audio_snapshot_t){.volume = 20}; }
static int audio_set_volume(uint8_t v) { (void)v; volume_changes++; return 0; }
static void announce_alarm_draft(void) {}
static void announce_timer_draft(void) {}
static void announce_volume(void) {}
static bool on_long_key(int key);
${['begin_recording_with_prompt', 'append_health_value', 'begin_health_record', 'commit_health_record', 'begin_ledger_record',
      'confirm_ledger_record', 'cancel_recording', 'on_short_key', 'key_long_threshold', 'on_key', 'on_long_key', 'on_rotate'].map(extractFunction).join('\n')}
static void reset_input(void) {
  mode = MODE_IDLE; job = JOB_IDLE; stop_prompt();
  health_edit_cancel(&health_edit); ledger_edit_cancel(&ledger_edit);
  memset(key_down, 0, sizeof key_down); memset(key_held, 0, sizeof key_held);
  memset(key_long_handled, 0, sizeof key_long_handled); memset(key_consumed, 0, sizeof key_consumed);
  hold_id[0] = discarded_id[0] = 0;
  stopped = released = uploads = setup_calls = volume_changes = stop_error = discard_error = 0;
  realtime_active = send_when_saved = mark_all_read_confirming = false;
}
static void press_key(int key, int64_t duration) {
  on_key(key, true); monotonic_us += duration; on_key(key, false);
}
static void test_inputs(void) {
  sizes[0] = sizes[1] = 0; ledger_records_init(); health_records_init();
  reset_input(); press_key(5, 50000);
  assert(mode == MODE_SETTING_LEDGER && ledger_edit.active && ledger_edit.high == 0);
  on_rotate(27); press_key(8, 50000);
  assert(ledger_edit.ones && ledger_pending_count() == 0);
  on_rotate(3); press_key(8, 50000);
  ledger_pending_t r; assert(ledger_pending_oldest(&r) && r.amount == 273 && !ledger_edit.active);
  reset_input(); press_key(5, 50000); press_key(8, 3000000);
  assert(!ledger_edit.active && setup_calls == 0 && ledger_pending_count() == 1);
  reset_input(); next_pressure = 0; press_key(6, 50000); on_rotate(1);
  assert(health_edit.value == 140 && health_pending_count() == 0);
  press_key(8, 50000); assert(health_edit.fine); on_rotate(1); press_key(8, 50000);
  int latest; assert(health_record_get(HEALTH_MOTHER_HIGH, &latest) && latest == 141);
  assert(health_pending_count() == 1 && !health_edit.active && volume_changes == 0);
  reset_input(); press_key(7, 50000); press_key(8, 3000000);
  assert(!health_edit.active && setup_calls == 0 && health_pending_count() == 1);
  reset_input(); press_key(4, 50000); assert(prompt_action == PROMPT_ACTION_START_RECORDING);
  press_key(4, 3000000);
  assert(prompt_action == PROMPT_ACTION_NONE && last_prompt == PROMPT_RECORD_CANCELLED);
  reset_input(); mode = MODE_RECORDING; press_key(4, 50000);
  assert(send_when_saved && stopped == 1 && released == 0);
  reset_input(); mode = MODE_RECORDING; press_key(4, 3000000);
  assert(mode == MODE_IDLE && !send_when_saved && stopped == 1 && released == 1 && uploads == 0);
  reset_input(); mode = MODE_RECORDING; stop_error = 1; press_key(4, 3000000);
  assert(mode == MODE_RECORDING && !send_when_saved && released == 0 && last_prompt == PROMPT_RECORD_CANCEL_FAILED);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft");
  press_key(4, 3000000);
  assert(hold_id[0] == 0 && strcmp(discarded_id, "synthetic-current-draft") == 0 && uploads == 0);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft");
  press_key(4, 50000); assert(hold_id[0] == 0 && uploads == 1 && send_when_saved);
  reset_input(); mode = MODE_RECORDING; press_key(5, 50000); assert(!ledger_edit.active);
  reset_input(); realtime_active = true; press_key(5, 50000); assert(ledger_edit.active);
  press_key(6, 50000); assert(health_edit.active);
  reset_input(); press_key(8, 3000000); assert(setup_calls == 1);
  reset_input(); press_key(5, 50000); on_key(8, true); monotonic_us += 10000;
  press_key(6, 50000); on_key(8, false);
  assert(health_edit.active && !health_edit.fine);
  reset_input(); mode = MODE_RECORD_READY; strcpy(hold_id, "synthetic-current-draft");
  on_key(4, true); monotonic_us += 3000000; key_long_handled[4] = on_long_key(4); on_key(4, false);
  assert(uploads == 0 && !send_when_saved && mode == MODE_IDLE);
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
  puts("synthetic ledger and measurement storage checks passed");
  test_inputs();
}
`)
    execFileSync('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Dtime=mock_time', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', source,
      join(source, 'ledger_records.c'), join(source, 'health_records.c'), join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('storage checks passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
