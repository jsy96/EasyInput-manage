import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs actual S7 transcript delivery, S6 conversation and immediate S5 controls in C', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-dialogue-controller-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'voice_chat.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp('static (?:void|bool|int64_t) ' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error('Missing controller function ' + name)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const enums = ['job_t', 'ui_mode_t', 'prompt_action_t'].map(name => {
      const end = source.indexOf('} ' + name + ';') + ('} ' + name + ';').length
      return source.slice(source.lastIndexOf('typedef enum {', end), end)
    }).join('\n')
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n')
    writeFileSync(join(root, 'controller.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "voice_prompts.h"
#include "xiaozhi_stt.h"
#define LONG_US 1200000LL
#define SETUP_LONG_US 3000000LL
#define ACK_TIMEOUT_US 12000000LL
#define SETTINGS_COMMIT_US 3000000LL
#define PROMPT_SEQUENCE_CAPACITY 128
${enums}
typedef struct { bool active, fine; } health_edit_t;
typedef struct { bool active; } ledger_edit_t;
typedef struct { bool speaker_playing; unsigned volume; } audio_snapshot_t;
static job_t job;
static ui_mode_t mode;
static prompt_action_t prompt_action;
static health_edit_t health_edit;
static ledger_edit_t ledger_edit;
static bool realtime_active, mark_all_read_confirming, send_when_saved;
static bool stt_s6_pressed, stt_s7_pressed, stt_round_started, stt_end_announced, stt_terminal_received;
static bool stt_text_session, stt_text_result_pending, stt_text_failed;
static int64_t stt_delivery_deadline;
static unsigned received_texts, acked_texts, queued_texts;
static char text_request_id[40], text_inflight_id[33];
static uint32_t sequence;
static int text_sends;
static bool network_available;
typedef struct { char op[24], req[40], id[33], text[100]; bool require_display; } cJSON;
static cJSON outgoing_text;
static cJSON *new_frame(const char *op) { memset(&outgoing_text,0,sizeof outgoing_text); strcpy(outgoing_text.op,op); return &outgoing_text; }
static void cJSON_AddStringToObject(cJSON *v,const char *key,const char *text) {
  if(!strcmp(key,"req")) strcpy(v->req,text);
  else if(!strcmp(key,"id")) strcpy(v->id,text);
  else if(!strcmp(key,"text")) strcpy(v->text,text);
}
static void cJSON_AddBoolToObject(cJSON *v,const char *key,bool b) { assert(!strcmp(key,"require_display")); v->require_display=b; }
static void send_frame(cJSON *v) { assert(!strcmp(v->op,"text.put") && v->require_display && v->req[0] && v->id[0] && v->text[0]); text_sends++; }
static bool network_fresh(int64_t now) { (void)now; return network_available; }
static bool prompt_playing, key_held[9], key_long_handled[9], key_consumed[9];
static int prompt_ids[PROMPT_SEQUENCE_CAPACITY], prompt_length, prompt_position;
static int64_t key_down[9], input_timestamp, settings_commit_at, retry_at, text_retry_at, clock_us = 1000000;
static char hold_id[65];
static unsigned diag_s5_events, diag_s6_down_events, diag_s6_up_events, diag_s6_actions, diag_s7_events, diag_last_key_mode;
static int diag_last_key, ordinary_recordings, record_stops, starts, stops, start_error, text_starts, text_stops;
static bool worker_busy, capturing, speaker_playing;
static int played[100], played_count, requested_prompt, interrupted;
static stt_event_t queued[20];
static int queued_count;
static int64_t esp_timer_get_time(void) { return clock_us; }
bool xiaozhi_stt_busy(void) { return worker_busy; }
void xiaozhi_stt_get_snapshot(stt_snapshot_t *s) { *s=(stt_snapshot_t){.busy=worker_busy,.capturing=capturing,.received_texts=received_texts,.acked_texts=acked_texts,.queued_texts=queued_texts}; }
esp_err_t xiaozhi_dialogue_start(void) { starts++; if(start_error) return start_error; worker_busy=capturing=true; return ESP_OK; }
void xiaozhi_dialogue_stop(void) { stops++; capturing=speaker_playing=false; }
esp_err_t xiaozhi_stt_start(void) { text_starts++; if(start_error) return start_error; worker_busy=capturing=true; received_texts=acked_texts=queued_texts=0; return ESP_OK; }
void xiaozhi_stt_stop(void) { text_stops++; capturing=false; }
bool xiaozhi_stt_pending(stt_text_t *text) { if(text && queued_texts) { strcpy(text->id,"pending"); strcpy(text->text,"recognized sentence"); } return queued_texts>0; }
bool xiaozhi_stt_ack(const char *id) { (void)id; if(!queued_texts) return false; queued_texts--; acked_texts++; return true; }
bool xiaozhi_stt_poll(stt_event_t *e) { if(!queued_count) return false; *e=queued[0]; memmove(queued,queued+1,(size_t)--queued_count*sizeof(*queued)); return true; }
static void push(stt_event_kind_t k) { assert(queued_count<20); queued[queued_count++]=(stt_event_t){.kind=k}; }
static int audio_stop_speaker(void) { if(speaker_playing) interrupted++; speaker_playing=false; return ESP_OK; }
static void audio_get_snapshot(audio_snapshot_t *s) { *s=(audio_snapshot_t){.speaker_playing=speaker_playing,.volume=20}; }
const uint8_t *voice_prompt_data(int id,size_t *n) { static uint8_t data; requested_prompt=id; *n=1; return &data; }
static int audio_play_voice(const uint8_t *p,size_t n) { (void)p; (void)n; assert(!capturing); assert(played_count<100); played[played_count++]=requested_prompt; speaker_playing=true; return ESP_OK; }
static void health_edit_cancel(health_edit_t *e) { e->active=false; }
static void ledger_edit_cancel(ledger_edit_t *e) { e->active=false; }
static void health_edit_refine(health_edit_t *e) { e->fine=true; }
static void stop_message_playback(void) { if(mode==MODE_PLAYING) mode=MODE_IDLE; }
static void finish_job(void) { job=JOB_IDLE; }
static bool uploading(void) { return job==JOB_UP_BEGIN || job==JOB_UP_CHUNK || job==JOB_UP_COMMIT; }
static void announce_recent_health(bool pressure) { (void)pressure; }
static void release_audio(void) {}
static int voice_outbox_discard(const char *id) { (void)id; return ESP_OK; }
static int audio_record_stop(void) { record_stops++; return ESP_OK; }
static void cancel_countdown(bool p) { (void)p; }
static void start_recording(void) { ordinary_recordings++; mode=MODE_RECORDING; }
static void upload_begin(void) { job=JOB_UP_BEGIN; }
static void play_previous_message(void) {}
static void *earliest_unread(void) { return NULL; }
static void play_message(void *p) { (void)p; }
static void begin_alarm_setting(void) {}
static void begin_timer_setting(void) {}

static void commit_health_record(void) { health_edit.active=false; mode=MODE_IDLE; }
static void confirm_ledger_record(void) { assert(!"removed ledger input must not execute"); }
static bool on_long_key(int key);
${['sync_text', 'stop_prompt', 'append_prompt', 'start_prompt_sequence', 'start_prompt', 'stt_feedback', 'handle_stt_event', 'poll_stt_events', 'poll_text_result', 'handle_text_receipt', 'cancel_recording', 'begin_recording_with_prompt', 'begin_dialogue', 'begin_transcription', 'on_short_key', 'key_long_threshold', 'on_stt_key', 'on_key', 'prompt_task_step'].map(extract).join('\n')}
static bool on_long_key(int key) { if(key!=4) return false; cancel_recording(); return true; }
static void reset(void) {
  job=JOB_IDLE; mode=MODE_IDLE; prompt_action=PROMPT_ACTION_NONE;
  prompt_length=prompt_position=played_count=queued_count=interrupted=0;
  ordinary_recordings=record_stops=starts=stops=start_error=text_starts=text_stops=0;
  worker_busy=capturing=speaker_playing=prompt_playing=false;
  stt_s6_pressed=stt_s7_pressed=stt_round_started=stt_end_announced=stt_terminal_received=false;
  stt_text_session=stt_text_result_pending=stt_text_failed=false; stt_delivery_deadline=0;
  received_texts=acked_texts=queued_texts=0; text_request_id[0]=text_inflight_id[0]=0;
  text_sends=0; text_retry_at=0; network_available=true;
  realtime_active=mark_all_read_confirming=send_when_saved=false;
  memset(key_down,0,sizeof key_down); memset(key_held,0,sizeof key_held);
  memset(key_long_handled,0,sizeof key_long_handled); memset(key_consumed,0,sizeof key_consumed);
  health_edit.active=ledger_edit.active=false; hold_id[0]=0;
}
static void finish_prompts(void) { for(int i=0;prompt_length || prompt_playing;i++) { assert(i<100); speaker_playing=false; prompt_task_step(++clock_us); } }
static int count_played(int id) { int n=0; for(int i=0;i<played_count;i++) if(played[i]==id) n++; return n; }
static void press(int key,int64_t duration) { on_key(key,true); clock_us+=duration; on_key(key,false); }
static void begin(void) {
  const int previous_starts=starts; press(5,50000);
  assert(prompt_action==PROMPT_ACTION_START_STT && !ledger_edit.active);
  finish_prompts(); assert(starts==previous_starts+1 && capturing && worker_busy && mode==MODE_STT);
}
int main(void) {
  // Each S5 release is immediately an ordinary recording action; no double-click mode.
  reset(); press(4,50000); assert(prompt_action==PROMPT_ACTION_START_RECORDING);
  finish_prompts(); assert(ordinary_recordings==1 && mode==MODE_RECORDING);
  clock_us+=100000; press(4,50000); assert(record_stops==1 && send_when_saved && starts==0);
  reset(); press(4,50000); press(4,50000); finish_prompts();
  assert(ordinary_recordings==0 && starts==0 && record_stops==0 && mode==MODE_IDLE);
  reset(); press(4,50000); prompt_task_step(++clock_us); assert(speaker_playing);
  press(4,50000); finish_prompts(); assert(ordinary_recordings==0 && starts==0 && mode==MODE_IDLE);
  reset(); press(4,50000); press(4,SETUP_LONG_US); finish_prompts();
  assert(ordinary_recordings==0 && starts==0 && count_played(PROMPT_RECORD_CANCELLED)==1);

  // S6 stops capture/playback locally while the network worker is still busy.
  reset(); begin(); speaker_playing=true; press(5,50000);
  assert(stops==1 && !capturing && !speaker_playing && worker_busy);
  assert(prompt_action==PROMPT_ACTION_STT_ENDED); finish_prompts();
  assert(count_played(PROMPT_DIALOGUE_ENDED)==1);
  worker_busy=false; push(STT_CANCELLED); poll_stt_events();
  assert(mode==MODE_IDLE && count_played(PROMPT_DIALOGUE_ENDED)==1);
  begin(); assert(count_played(PROMPT_DIALOGUE_START)==2);

  // TTS pauses and progress do not announce an ended session.
  reset(); begin(); capturing=false; push(STT_CAPTURE_STOPPED); push(STT_WAIT); poll_stt_events();
  assert(mode==MODE_STT && !prompt_length && !prompt_playing && !stt_end_announced);
  capturing=true; push(STT_DONE); poll_stt_events(); assert(text_retry_at==0 && !prompt_length);
  for(int key=0;key<9;key++) if(key!=5) { press(key,SETUP_LONG_US); }
  assert(stops==0 && ordinary_recordings==0 && mode==MODE_STT);

  // A terminal event between S6 press and release cannot start a new session.
  reset(); begin(); on_key(5,true); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events();
  clock_us+=50000; on_key(5,false); finish_prompts();
  assert(starts==1 && stops==0 && mode==MODE_IDLE);
  assert(count_played(PROMPT_DIALOGUE_ENDED)==1 && count_played(PROMPT_DIALOGUE_FAILED)==1);
  push(STT_FAILED); push(STT_CAPTURE_STOPPED); poll_stt_events(); finish_prompts();
  assert(count_played(PROMPT_DIALOGUE_FAILED)==1);
  // Other keys held through a terminal event are consumed on release as well.
  reset(); begin(); on_key(4,true); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events();
  clock_us+=50000; on_key(4,false); finish_prompts(); assert(ordinary_recordings==0);

  reset(); begin(); on_key(6,true); press(5,50000); finish_prompts();
  worker_busy=false; push(STT_CANCELLED); poll_stt_events(); clock_us+=50000; on_key(6,false);
  assert(text_starts==0 && mode==MODE_IDLE);
  reset(); begin(); on_key(4,true); press(5,50000); finish_prompts();
  worker_busy=false; push(STT_CANCELLED); poll_stt_events(); clock_us+=50000; on_key(4,false);
  assert(ordinary_recordings==0 && mode==MODE_IDLE);

  // Rapid S6 presses cancel the connection before the microphone starts.
  reset(); press(5,50000); press(5,50000); finish_prompts();
  assert(starts==0 && stops==1 && !capturing && mode==MODE_IDLE);
  reset(); press(5,50000); prompt_task_step(++clock_us); assert(speaker_playing);
  press(5,50000); finish_prompts(); assert(starts==0 && count_played(PROMPT_DIALOGUE_ENDED)==1);
  // A rejected start ends with one failure cue and is recoverable on S6.
  reset(); start_error=-1; press(5,50000); finish_prompts();
  assert(starts==1 && !capturing && mode==MODE_IDLE && count_played(PROMPT_DIALOGUE_FAILED)==1);
  start_error=0; begin();

  // A webpage capture, unsent recording or active upload cannot be stolen by S6.
  reset(); realtime_active=true; press(5,50000); finish_prompts(); assert(starts==0 && realtime_active && !ledger_edit.active);
  reset(); mode=MODE_RECORD_READY; strcpy(hold_id,"held-recording"); press(5,50000); finish_prompts();
  assert(starts==0 && !strcmp(hold_id,"held-recording"));
  reset(); job=JOB_UP_BEGIN; press(5,50000); finish_prompts(); assert(starts==0 && job==JOB_UP_BEGIN);
  reset(); capturing=true; start_prompt(PROMPT_DIALOGUE_FAILED,PROMPT_ACTION_NONE);
  assert(!prompt_length && !speaker_playing);
  // Execute the real sender during live S7; preserve its retry boundary and S6 isolation.
  reset(); press(6,50000); finish_prompts(); received_texts=queued_texts=1;
  sync_text(clock_us); assert(text_sends==1 && capturing && worker_busy);
  sync_text(clock_us+ACK_TIMEOUT_US-1); assert(text_sends==1);
  sync_text(clock_us+ACK_TIMEOUT_US); assert(text_sends==2);
  handle_text_receipt("text.ack",text_request_id,text_inflight_id,false); assert(queued_texts==1);
  handle_text_receipt("text.displayed",NULL,text_inflight_id,false); assert(acked_texts==1 && !queued_texts);
  sync_text(clock_us+2*ACK_TIMEOUT_US); assert(text_sends==2);
  reset(); begin(); queued_texts=1; sync_text(clock_us); assert(text_sends==0);
  reset(); queued_texts=1; network_available=false; sync_text(clock_us); assert(text_sends==0);

  // S7 starts on release and remains in one continuous transcript session.
  reset(); press(6,50000); assert(prompt_action==PROMPT_ACTION_START_STT && stt_text_session);
  finish_prompts(); assert(text_starts==1 && starts==0 && capturing);
  received_texts=queued_texts=2;
  strcpy(text_inflight_id,"first"); strcpy(text_request_id,"text-1");
  assert(handle_text_receipt("text.ack","text-1","first",false));
  assert(acked_texts==0 && queued_texts==2); // Cloud storage alone is insufficient.
  handle_text_receipt("text.displayed",NULL,"wrong",true); assert(acked_texts==0);
  handle_text_receipt("text.ack","wrong","first",true); assert(acked_texts==0);
  handle_text_receipt("text.displayed",NULL,"first",false); assert(acked_texts==1 && queued_texts==1);
  handle_text_receipt("text.displayed",NULL,"first",true); assert(acked_texts==1); // Duplicate receipt.
  strcpy(text_inflight_id,"second"); strcpy(text_request_id,"text-2");
  handle_text_receipt("text.ack","text-2","second",true); assert(acked_texts==2 && !queued_texts);
  press(5,50000); press(7,50000); assert(text_stops==0 && stops==0 && capturing);
  poll_text_result(clock_us); assert(count_played(PROMPT_TRANSCRIPT_SUCCESS)==0);
  press(6,50000); assert(text_stops==1 && !capturing && worker_busy);
  finish_prompts(); assert(mode==MODE_STT && stt_text_result_pending);
  press(6,50000); assert(text_stops==1 && text_starts==1); // Drain cannot restart.
  worker_busy=false; push(STT_FINISHED); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  assert(mode==MODE_IDLE && count_played(PROMPT_TRANSCRIPT_SUCCESS)==1 && count_played(PROMPT_TRANSCRIPT_FAILURE)==0);
  push(STT_FINISHED); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_SUCCESS)==1);

  // Partial delivery waits for the bounded post-terminal receipt window.
  reset(); press(6,50000); finish_prompts(); received_texts=2; acked_texts=1; queued_texts=1;
  press(6,50000); finish_prompts(); worker_busy=false; push(STT_FINISHED); poll_stt_events();
  poll_text_result(stt_delivery_deadline-1); assert(!prompt_length && mode==MODE_STT);
  poll_text_result(stt_delivery_deadline); finish_prompts();
  assert(mode==MODE_IDLE && queued_texts==1 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1);
  strcpy(text_inflight_id,"late"); strcpy(text_request_id,"text-3");
  handle_text_receipt("text.displayed",NULL,"late",true); poll_text_result(++clock_us); finish_prompts();
  assert(!queued_texts && count_played(PROMPT_TRANSCRIPT_SUCCESS)==0); // No late contradictory announcement.

  // Empty recognition and transport failure never become a successful result.
  reset(); press(6,50000); finish_prompts(); press(6,50000); finish_prompts();
  worker_busy=false; push(STT_EMPTY); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && mode==MODE_IDLE);
  reset(); press(6,50000); finish_prompts(); received_texts=acked_texts=1;
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && count_played(PROMPT_TRANSCRIPT_SUCCESS)==0);

  // Quick cancellation never starts capture, and held keys cannot reopen a round.
  reset(); press(6,50000); press(6,50000); poll_text_result(clock_us); finish_prompts();
  assert(text_starts==0 && text_stops==0 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && mode==MODE_IDLE);
  reset(); press(6,50000); finish_prompts(); on_key(6,true);
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  clock_us+=50000; on_key(6,false); finish_prompts(); assert(text_starts==1 && mode==MODE_IDLE);
  reset(); press(6,50000); finish_prompts(); on_key(6,true);
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); poll_text_result(clock_us); finish_prompts();
  begin(); on_key(6,false); assert(stops==0 && worker_busy && capturing); // Old S7 release cannot stop new S6.
  reset(); press(7,50000); assert(mode==MODE_IDLE && !prompt_length && text_starts==0);
  for(int state=0;state<3;state++) {
    reset(); realtime_active=state==0; if(state==1) strcpy(hold_id,"saved"); if(state==2) queued_texts=1;
    press(6,50000); finish_prompts(); assert(text_starts==0 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1);
  }
  reset(); begin(); queued_texts=1; strcpy(text_inflight_id,"old"); strcpy(text_request_id,"text-4");
  handle_text_receipt("text.displayed",NULL,"old",true); assert(queued_texts==1 && acked_texts==0);
  puts("actual S7 transcript, S6 conversation and immediate S5 controls passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable', '-I', root, '-I', sourceDir, join(root, 'controller.c'), '-o', join(root, 'controller')])
    expect(execFileSync(join(root, 'controller'), { encoding: 'utf8' })).toContain('actual S7 transcript, S6 conversation and immediate S5 controls passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15000)
