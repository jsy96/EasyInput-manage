import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs actual STT controller lifecycle, microphone-off feedback and S5 recovery in C', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-voice-lifecycle-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'voice_chat.c'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp('static (?:void|bool|int64_t) ' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error('Missing controller function ' + name)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const enums = ['job_t', 'ui_mode_t', 'prompt_action_t'].map(name => {
      const end = source.indexOf('} ' + name + ';') + ('} ' + name + ';').length
      return source.slice(source.lastIndexOf('typedef enum {', end), end)
    }).join('\n')
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n')
    writeFileSync(join(root, 'test.c'), [
      '#include <assert.h>', '#include <stdbool.h>', '#include <stdint.h>', '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>',
      '#include "voice_prompts.h"', '#include "xiaozhi_stt.h"',
      '#define LONG_US 1200000', '#define SETUP_LONG_US 3000000', '#define DOUBLE_CLICK_US 400000LL',
      '#define SETTINGS_COMMIT_US 3000000LL', '#define PROMPT_SEQUENCE_CAPACITY 128', '#define ACK_TIMEOUT_US 12000000LL',
      enums,
      'typedef struct { bool active; } health_edit_t;', 'typedef struct { bool active; } ledger_edit_t;',
      'typedef struct { bool speaker_playing; unsigned volume; } audio_snapshot_t;', 'typedef struct { int unused; } cJSON;',
      'static job_t job; static ui_mode_t mode; static prompt_action_t prompt_action;',
      'static health_edit_t health_edit; static ledger_edit_t ledger_edit;',
      'static bool realtime_active, mark_all_read_confirming, send_when_saved, text_sent_announce_pending;',
      'static bool stt_s5_pressed, stt_cancel_failed, stt_cancel_announce_pending;',
      'static bool stt_round_started, stt_start_attempted, stt_end_announced, stt_terminal_received, stt_awaiting_ack;',
      'static bool prompt_playing, key_held[9], key_long_handled[9], key_consumed[9], second_click;',
      'static int prompt_ids[PROMPT_SEQUENCE_CAPACITY], prompt_length, prompt_position, pending_click = -1;',
      'static int64_t key_down[9], input_timestamp, click_deadline, settings_commit_at, retry_at, text_retry_at, clock_us = 1000000;',
      'static char hold_id[65], text_request_id[40], text_inflight_id[33];',
      'static unsigned sequence, diag_s5_events, diag_s6_down_events, diag_s6_up_events, diag_s6_actions, diag_s7_events, diag_last_key_mode;',
      'static int diag_last_key, ordinary_recordings, starts, stops, cancels, start_error, cancel_error;',
      'static bool worker_busy, capturing, speaker_playing, text_pending;',
      'static int played[100], played_count, requested_prompt, interrupted;',
      'static stt_event_t queued[20]; static int queued_count;',
      'static int64_t esp_timer_get_time(void) { return clock_us; }',
      'bool xiaozhi_stt_busy(void) { return worker_busy; }',
      'void xiaozhi_stt_get_snapshot(stt_snapshot_t *s) { *s = (stt_snapshot_t){.busy=worker_busy,.capturing=capturing}; }',
      'esp_err_t xiaozhi_stt_start(void) { starts++; if(start_error) return start_error; worker_busy=capturing=true; return ESP_OK; }',
      'void xiaozhi_stt_stop(void) { stops++; capturing=false; }',
      'bool xiaozhi_stt_cancel(void) { cancels++; capturing=false; text_pending=false; return !cancel_error; }',
      'bool xiaozhi_stt_poll(stt_event_t *e) { if(!queued_count) return false; *e=queued[0]; memmove(queued,queued+1,(size_t)--queued_count*sizeof(*queued)); return true; }',
      'bool xiaozhi_stt_pending(stt_text_t *t) { if(t && text_pending) { strcpy(t->id,"tail-id"); strcpy(t->text,"final speech"); } return text_pending; }',
      'static void push(stt_event_kind_t k) { assert(queued_count<20); queued[queued_count++]=(stt_event_t){.kind=k}; }',
      'static int audio_stop_speaker(void) { if(speaker_playing) interrupted++; speaker_playing=false; return ESP_OK; }',
      'static void audio_get_snapshot(audio_snapshot_t *s) { *s=(audio_snapshot_t){.speaker_playing=speaker_playing,.volume=20}; }',
      'const uint8_t *voice_prompt_data(int id, size_t *n) { static uint8_t data; requested_prompt=id; *n=1; return &data; }',
      'static int audio_play_voice(const uint8_t *p, size_t n) { (void)p; (void)n; assert(!capturing); assert(played_count<100); played[played_count++]=requested_prompt; speaker_playing=true; return ESP_OK; }',
      'static void health_edit_cancel(health_edit_t *e) { e->active=false; }', 'static void ledger_edit_cancel(ledger_edit_t *e) { e->active=false; }',
      'static void stop_message_playback(void) {}', 'static void finish_job(void) { job=JOB_IDLE; }', 'static bool uploading(void) { return false; }',
      'static void announce_ledger(void) {}', 'static void announce_recent_health(bool x) { (void)x; }', 'static void release_audio(void) {}',
      'static int voice_outbox_discard(const char *id) { (void)id; return ESP_OK; }', 'static int audio_record_stop(void) { return ESP_OK; }',
      'static void cancel_countdown(bool p) { (void)p; }', 'static void on_short_key(int key) { if(key==4) ordinary_recordings++; }',
      'static void start_recording(void) { ordinary_recordings++; }', 'static bool on_long_key(int key);',
      'static bool network_fresh(int64_t now) { (void)now; return true; }', 'static cJSON frame; static int text_sends;',
      'static cJSON *new_frame(const char *op) { assert(!strcmp(op,"text.put")); return &frame; }',
      'static void cJSON_AddStringToObject(cJSON *f,const char *k,const char *v) { (void)f; (void)k; (void)v; }',
      '#undef strlcpy', '#define strlcpy voice_test_strlcpy',
      'static size_t strlcpy(char *d,const char *s,size_t n) { size_t l=strlen(s); if(n) { size_t used=l<n-1?l:n-1; memcpy(d,s,used); d[used]=0; } return l; }',
      'static void send_frame(cJSON *f) { (void)f; text_sends++; }',
      ...['stop_prompt', 'append_prompt', 'start_prompt_sequence', 'start_prompt', 'stt_feedback', 'handle_stt_event', 'poll_stt_events', 'cancel_recording', 'on_double_key', 'poll_click', 'key_long_threshold', 'on_stt_key', 'on_key', 'prompt_task_step', 'sync_text'].map(extract),
      'static bool on_long_key(int key) { if(key!=4) return false; cancel_recording(); return true; }',
      'static void reset(void) {',
      'job=JOB_IDLE; mode=MODE_IDLE; prompt_action=PROMPT_ACTION_NONE; prompt_length=prompt_position=played_count=queued_count=interrupted=0;',
      'ordinary_recordings=starts=stops=cancels=start_error=cancel_error=text_sends=0; worker_busy=capturing=speaker_playing=prompt_playing=text_pending=false;',
      'stt_s5_pressed=stt_cancel_failed=stt_cancel_announce_pending=false;',
      'stt_round_started=stt_start_attempted=stt_end_announced=stt_terminal_received=stt_awaiting_ack=false;',
      'realtime_active=mark_all_read_confirming=send_when_saved=text_sent_announce_pending=second_click=false;',
      'memset(key_down,0,sizeof key_down); memset(key_held,0,sizeof key_held); memset(key_long_handled,0,sizeof key_long_handled); memset(key_consumed,0,sizeof key_consumed);',
      'pending_click=-1; health_edit.active=ledger_edit.active=false; hold_id[0]=text_request_id[0]=text_inflight_id[0]=0; text_retry_at=0; }',
      'static void finish_prompts(void) { for(int i=0;prompt_length || prompt_playing;i++) { assert(i<100); speaker_playing=false; prompt_task_step(++clock_us); } }',
      'static int count_played(int id) { int n=0; for(int i=0;i<played_count;i++) if(played[i]==id) n++; return n; }',
      'static void short_s5(void) { on_key(4,true); clock_us+=50000; on_key(4,false); clock_us+=DOUBLE_CLICK_US+1; poll_click(clock_us); }',
      'static void begin(void) {',
      'on_key(4,true); clock_us+=50000; on_key(4,false); clock_us+=200000; on_key(4,true); clock_us+=50000; on_key(4,false);',
      'assert(prompt_action==PROMPT_ACTION_START_STT && !stt_s5_pressed && stops==0); finish_prompts();',
      'assert(capturing && worker_busy && mode==MODE_STT); assert(count_played(PROMPT_STT_START)>=1); }',
      'int main(void) {',
      '// Stop feedback is audible while the worker still drains final results.',
      'reset(); begin(); short_s5(); assert(stops==1 && worker_busy && !capturing && prompt_action==PROMPT_ACTION_STT_ENDED);',
      'assert(mode==MODE_STT && ordinary_recordings==0); push(STT_CAPTURE_STOPPED); push(STT_WAIT); poll_stt_events();',
      'start_prompt(PROMPT_VOLUME_10,PROMPT_ACTION_NONE); assert(prompt_action==PROMPT_ACTION_STT_ENDED);',
      'finish_prompts(); assert(count_played(PROMPT_STT_ENDED)==1 && mode==MODE_STT);',
      '// Repeated late transcript notifications still schedule durable delivery.',
      'text_pending=true; text_retry_at=clock_us+999; push(STT_DONE); poll_stt_events(); sync_text(clock_us);',
      'assert(text_sends==1 && worker_busy && mode==MODE_STT); push(STT_DONE); poll_stt_events(); sync_text(clock_us); assert(text_sends==2);',
      'worker_busy=false; push(STT_FINISHED); poll_stt_events(); assert(mode==MODE_IDLE && count_played(PROMPT_STT_ENDED)==1);',
      'short_s5(); assert(ordinary_recordings==1);',
      '// Failure before next press retains an acknowledgement and does not interrupt cues.',
      'reset(); begin(); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events();',
      'assert(stt_awaiting_ack && prompt_ids[0]==PROMPT_STT_ENDED && prompt_ids[1]==PROMPT_STT_FAILED);',
      'prompt_task_step(++clock_us); assert(speaker_playing); short_s5(); assert(!stt_awaiting_ack && !interrupted && ordinary_recordings==0);',
      'finish_prompts(); assert(mode==MODE_IDLE && count_played(PROMPT_STT_ENDED)==1 && count_played(PROMPT_STT_FAILED)==1);',
      'push(STT_CAPTURE_STOPPED); push(STT_FAILED); poll_stt_events(); finish_prompts(); assert(count_played(PROMPT_STT_ENDED)==1 && count_played(PROMPT_STT_FAILED)==1);',
      '// Acknowledgement remains after both failure cues have finished.',
      'reset(); begin(); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); finish_prompts();',
      'assert(stt_awaiting_ack && mode==MODE_IDLE); short_s5(); assert(ordinary_recordings==0 && !stt_awaiting_ack);',
      '// Terminal feedback appends to an already playing end cue.',
      'reset(); begin(); capturing=false; push(STT_CAPTURE_STOPPED); poll_stt_events(); prompt_task_step(++clock_us);',
      'worker_busy=false; push(STT_EMPTY); poll_stt_events(); assert(!interrupted && prompt_ids[0]==PROMPT_STT_ENDED && prompt_ids[1]==PROMPT_STT_EMPTY);',
      'finish_prompts(); assert(count_played(PROMPT_STT_ENDED)==1 && count_played(PROMPT_STT_EMPTY)==1);',
      '// Long S5 cancels and confirms stopped capture before worker termination.',
      'reset(); begin(); on_key(4,true); clock_us+=SETUP_LONG_US+1; on_key(4,false);',
      'assert(cancels==1 && stops==0 && worker_busy && !capturing && ordinary_recordings==0);',
      'prompt_task_step(++clock_us); worker_busy=false; push(STT_CANCELLED); push(STT_CAPTURE_STOPPED); poll_stt_events();',
      'finish_prompts(); assert(count_played(PROMPT_STT_ENDED)==1 && count_played(PROMPT_RECORD_CANCELLED)==1);',
      '// Terminal between down/up is consumed too.',
      'reset(); begin(); on_key(4,true); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events();',
      'clock_us+=50000; on_key(4,false); poll_click(clock_us+DOUBLE_CLICK_US+1); assert(ordinary_recordings==0 && !stt_awaiting_ack);',
      '// Synchronous start failure follows the heard start cue with one end cue.',
      'reset(); start_error=-1; on_double_key(4); finish_prompts(); assert(starts==1 && !capturing && count_played(PROMPT_STT_START)==1);',
      'assert(count_played(PROMPT_STT_ENDED)==1 && count_played(PROMPT_STT_FAILED)==1); short_s5(); assert(ordinary_recordings==0);',
      '// Cancelling before any start playback does not announce a nonexistent session.',
      'reset(); on_double_key(4); short_s5(); finish_prompts(); assert(starts==0 && count_played(PROMPT_STT_START)==0 && count_played(PROMPT_STT_ENDED)==0);',
      '// Cancelling during the heard start cue does announce its end.',
      'reset(); on_double_key(4); prompt_task_step(++clock_us); short_s5(); finish_prompts();',
      'assert(starts==0 && count_played(PROMPT_STT_START)==1 && count_played(PROMPT_STT_ENDED)==1);',
      '// Busy=false alone never authorizes playback while capture remains live.',
      'reset(); capturing=true; start_prompt(PROMPT_STT_FAILED,PROMPT_ACTION_NONE); assert(!prompt_length && !speaker_playing);',
      '// Snapshot fallback covers missing capture-stop notifications.',
      'reset(); begin(); capturing=false; poll_stt_events(); finish_prompts(); assert(count_played(PROMPT_STT_ENDED)==1 && worker_busy);',
      'worker_busy=false; push(STT_FINISHED); poll_stt_events(); assert(mode==MODE_IDLE);',
      '// A fresh double click resets per-round feedback flags.',
      'begin(); short_s5(); finish_prompts(); worker_busy=false; push(STT_FINISHED); poll_stt_events(); assert(count_played(PROMPT_STT_ENDED)==2);',
      'puts("actual STT lifecycle and microphone-off feedback passed"); return 0; }',
    ].join('\n'))
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable', '-I', root, '-I', sourceDir, join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('actual STT lifecycle and microphone-off feedback passed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
