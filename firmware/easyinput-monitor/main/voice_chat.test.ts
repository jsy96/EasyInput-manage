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
#include "timers.h"
#define LONG_US 1200000LL
#define SETUP_LONG_US 3000000LL
#define ACK_TIMEOUT_US 12000000LL
#define SETTINGS_COMMIT_US 3000000LL
#define PROMPT_SEQUENCE_CAPACITY 128
${enums}
typedef struct { bool active, fine; } health_edit_t;
typedef struct { bool active; } ledger_edit_t;
typedef struct { bool speaker_playing, recording; unsigned volume; } audio_snapshot_t;
static job_t job;
static ui_mode_t mode;
static prompt_action_t prompt_action;
static health_edit_t health_edit;
static ledger_edit_t ledger_edit;
static bool realtime_active, mark_all_read_confirming, send_when_saved;
static bool timer_stop_keys[9], alarm_music_active, stopwatch_beep_active, stopwatch_active;
static unsigned deferred_timer_events;
static bool realtime_enabled,realtime_start_pending,realtime_ready,realtime_cancelled,realtime_stop_pending;
static unsigned diag_realtime_stops,realtime_starts,realtime_stop_sends,live_stops;
static bool countdown_active;
static int snapshot_lock;
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
static void send_realtime_stop(void) { realtime_stop_pending=true;realtime_stop_sends++; }
static int audio_live_stop(void) { live_stops++;return 0; }
static void start_realtime(void) { realtime_starts++;realtime_active=true; }
static void cancel_realtime_for_work(void);
bool timers_countdown_active(void) { return countdown_active; }
bool timers_stopwatch_active(void) { return stopwatch_active; }
static bool voice_stop_keys[9], stt_stop_handled, stt_round_started, stt_end_announced, stt_terminal_received;
static bool stt_text_session, stt_text_result_pending, stt_text_failed, stt_engine_started;
static int64_t stt_delivery_deadline;
static unsigned received_texts, acked_texts, queued_texts;
static unsigned prior_texts, delivery_results;
static bool delivery_success, delivery_network;
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
static unsigned stopwatch_toggles;
static int64_t stopwatch_toggled_at;
static void toggle_stopwatch(int64_t now) { stopwatch_toggles++; stopwatch_toggled_at=now; stopwatch_active=!stopwatch_active; }
bool xiaozhi_stt_busy(void) { return worker_busy; }
void xiaozhi_stt_get_snapshot(stt_snapshot_t *s) { *s=(stt_snapshot_t){.busy=worker_busy,.capturing=capturing,.received_texts=received_texts,.acked_texts=acked_texts,.queued_texts=queued_texts,.session_queued_texts=received_texts-acked_texts}; }
esp_err_t xiaozhi_dialogue_start(void) { starts++; if(start_error) return start_error; worker_busy=capturing=true; return ESP_OK; }
void xiaozhi_dialogue_stop(void) { stops++; capturing=speaker_playing=false; }
esp_err_t xiaozhi_stt_start(void) { text_starts++; if(start_error) return start_error; worker_busy=capturing=true; prior_texts=queued_texts; received_texts=acked_texts=0; return ESP_OK; }
void xiaozhi_stt_delivery_result(bool success,bool network_ready) { delivery_results++; delivery_success=success; delivery_network=network_ready; }
void xiaozhi_stt_stop(void) { text_stops++; capturing=false; }
bool xiaozhi_stt_pending(stt_text_t *text) { if(text && queued_texts) { strcpy(text->id,prior_texts ? "prior-pending" : "pending"); strcpy(text->text,"recognized sentence"); } return queued_texts>0; }
bool xiaozhi_stt_ack(const char *id) { (void)id; if(!queued_texts) return false; queued_texts--; if(prior_texts) prior_texts--; else acked_texts++; return true; }
bool xiaozhi_stt_poll(stt_event_t *e) { if(!queued_count) return false; *e=queued[0]; memmove(queued,queued+1,(size_t)--queued_count*sizeof(*queued)); return true; }
static void push(stt_event_kind_t k) { assert(queued_count<20); queued[queued_count++]=(stt_event_t){.kind=k}; }
static int notification_stops;
static int audio_stop_notification(void) { notification_stops++;return ESP_OK; }
static int audio_stop_speaker(void) { if(speaker_playing) interrupted++; speaker_playing=false; return ESP_OK; }
static void audio_get_snapshot(audio_snapshot_t *s) { *s=(audio_snapshot_t){.speaker_playing=speaker_playing,.volume=20}; }
const uint8_t *voice_prompt_data(int id,size_t *n) { static uint8_t data; requested_prompt=id; *n=1; return &data; }
static int audio_play_voice_loop(const uint8_t *p,size_t n,uint32_t ms) { assert(ms==60000); (void)p;(void)n;speaker_playing=true;return ESP_OK; }
static int audio_play_voice(const uint8_t *p,size_t n) { (void)p; (void)n; assert(!capturing); assert(played_count<100); played[played_count++]=requested_prompt; speaker_playing=true; return ESP_OK; }
static void health_edit_cancel(health_edit_t *e) { e->active=false; }
static void ledger_edit_cancel(ledger_edit_t *e) { e->active=false; }
static void health_edit_refine(health_edit_t *e) { e->fine=true; }
static void stop_message_playback(void) { if(mode==MODE_PLAYING) mode=MODE_IDLE; }
static void finish_job(void) { job=JOB_IDLE; }
static bool recording_busy(void) { return mode==MODE_RECORDING; }
static void stop_recording_stream(void) { record_stops++; mode=MODE_RECORD_READY; }
static void start_prompt(int, prompt_action_t);
static void stop_prompt(void);
static void cancel_recording_stream(void) { stop_prompt(); record_stops++; mode=MODE_IDLE; start_prompt(PROMPT_RECORD_CANCELLED,PROMPT_ACTION_NONE); }
static bool uploading(void) { return job==JOB_UP_BEGIN || job==JOB_UP_CHUNK || job==JOB_UP_COMMIT; }
static void announce_recent_health(bool pressure) { (void)pressure; }
static void release_audio(void) {}
static int voice_outbox_discard(const char *id) { (void)id; return ESP_OK; }
static int audio_record_stop(void) { record_stops++; return ESP_OK; }
static void cancel_countdown(bool p) { (void)p; }
static void start_recording(void) { ordinary_recordings++; mode=MODE_RECORDING; }
static void upload_begin(void) { job=JOB_UP_BEGIN; }
static void stop_prompt(void);
typedef struct { char id[65]; bool read; } message_t;
static message_t messages[3],*last_message;
static int message_count;
static char cursor_id[65];
#undef strlcpy
#define strlcpy(dst,src,n) snprintf(dst,n,"%s",src)
${['find_message', 'earliest_unread', 'previous_message_before', 'set_cursor'].map(name => {
  const start = source.indexOf('static message_t *' + name + '(') >= 0 ? source.indexOf('static message_t *' + name + '(') : source.indexOf('static void ' + name + '(')
  return source.slice(start, source.indexOf('\n}\n', start) + 3)
}).join('\n')}
static void play_message(message_t *p) { last_message=p;if(p)set_cursor(p); }
${extract('play_previous_message')}
static void begin_alarm_setting(void) {}
static void begin_timer_setting(void) {}

static void commit_health_record(void) { health_edit.active=false; mode=MODE_IDLE; }
static void confirm_ledger_record(void) { assert(!"removed ledger input must not execute"); }
static bool on_long_key(int key);
${['stop_realtime', 'cancel_realtime_for_work', 'board_busy', 'apply_realtime_setting', 'sync_text', 'stop_prompt', 'append_prompt', 'start_prompt_sequence', 'start_prompt', 'stt_feedback', 'handle_stt_event', 'poll_stt_events', 'poll_text_result', 'handle_text_receipt', 'begin_recording_with_prompt', 'begin_dialogue', 'begin_transcription', 'on_short_key', 'key_long_threshold', 'stop_voice_session', 'on_voice_key', 'on_key', 'prompt_task_step'].map(extract).join('\n')}
static bool on_long_key(int key) { (void)key; return false; }
static void reset(void) {
  job=JOB_IDLE; mode=MODE_IDLE; prompt_action=PROMPT_ACTION_NONE;
  prompt_length=prompt_position=played_count=queued_count=interrupted=0;
  ordinary_recordings=record_stops=starts=stops=start_error=text_starts=text_stops=0;
  worker_busy=capturing=speaker_playing=prompt_playing=false;
  memset(voice_stop_keys,0,sizeof voice_stop_keys);
  memset(timer_stop_keys,0,sizeof timer_stop_keys);
  alarm_music_active=stopwatch_beep_active=stopwatch_active=false; deferred_timer_events=0;
  realtime_enabled=realtime_start_pending=realtime_ready=realtime_cancelled=realtime_stop_pending=false;
  realtime_starts=realtime_stop_sends=live_stops=0;countdown_active=false;
  cursor_id[0]=0;message_count=0;last_message=NULL;
  stt_stop_handled=stt_round_started=stt_end_announced=stt_terminal_received=false;
  stt_text_session=stt_text_result_pending=stt_text_failed=false; stt_delivery_deadline=0;
  stt_engine_started=delivery_success=delivery_network=false; prior_texts=delivery_results=0;
  received_texts=acked_texts=queued_texts=0; text_request_id[0]=text_inflight_id[0]=0;
  text_sends=0; text_retry_at=0; network_available=true;
  stopwatch_toggles=0; stopwatch_toggled_at=0; input_timestamp=0;
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
  // Cancelling pending or active capture is latched until the cloud confirms false.
  reset(); realtime_enabled=realtime_start_pending=true;cancel_realtime_for_work();
  assert(realtime_cancelled && !realtime_enabled && !realtime_start_pending && realtime_stop_sends==1 && !live_stops);
  apply_realtime_setting(true);assert(!realtime_active && !realtime_starts && realtime_stop_sends==2);
  apply_realtime_setting(false);realtime_stop_pending=false;apply_realtime_setting(true);
  assert(realtime_active && realtime_starts==1);cancel_realtime_for_work();
  assert(!realtime_active && live_stops==1);
  for(int state=0;state<6;state++) {
    reset();
    if(state==0)job=JOB_DOWNLOAD;else if(state==1)job=JOB_UP_BEGIN;
    else if(state==2)stopwatch_active=true;else if(state==3)countdown_active=true;
    else if(state==4)worker_busy=true;else mode=MODE_SETTING_ALARM;
    apply_realtime_setting(true);assert(!realtime_active && !realtime_starts && realtime_cancelled && realtime_stop_sends==1);
  }
  reset(); message_count=3;
  for(int i=0;i<3;i++){snprintf(messages[i].id,65,"message-%d",i);messages[i].read=true;}
  set_cursor(&messages[0]);press(1,50000);assert(!cursor_id[0] && !last_message);
  press(0,50000);assert(last_message==&messages[2]);press(0,50000);assert(last_message==&messages[1]);

  // Outside a board voice session S8 keeps its independent stopwatch behavior.
  reset(); mode=MODE_COUNTDOWN; on_key(7,false); assert(!stopwatch_toggles);
  on_key(7,true); on_key(7,true); input_timestamp=clock_us+2300000;
  on_key(7,false); on_key(7,false);
  assert(stopwatch_toggles==1 && stopwatch_toggled_at==input_timestamp && mode==MODE_COUNTDOWN);
  reset(); begin(); press(7,50000);
  assert(stopwatch_toggles==0 && !capturing && stops==1 && mode==MODE_STT);
  reset(); realtime_active=true; press(7,50000);
  assert(stopwatch_toggles==1 && !realtime_active);
  // Each S5 release is immediately an ordinary recording action; no double-click mode.
  reset(); press(4,50000); assert(prompt_action==PROMPT_ACTION_START_RECORDING);
  finish_prompts(); assert(ordinary_recordings==1 && mode==MODE_RECORDING);
  clock_us+=100000; press(4,50000); assert(record_stops==1 && mode==MODE_RECORD_READY && starts==0);
  reset(); press(4,50000); press(4,50000); finish_prompts();
  assert(ordinary_recordings==0 && starts==0 && record_stops==0 && mode==MODE_IDLE);
  reset(); press(4,50000); prompt_task_step(++clock_us); assert(speaker_playing);
  press(4,50000); finish_prompts(); assert(ordinary_recordings==0 && starts==0 && mode==MODE_IDLE);
  reset(); press(4,50000); press(4,SETUP_LONG_US); finish_prompts();
  assert(ordinary_recordings==0 && starts==0 && count_played(PROMPT_RECORD_CANCELLED)==0 && mode==MODE_IDLE);

  // S8 stops at the first DOWN for every physical key and consumes its release.
  for(int key=0;key<9;key++) {
    reset(); press(7,50000); assert(stopwatch_active && stopwatch_toggles==1);
    input_timestamp=clock_us+60000000; on_key(key,true);
    assert(!stopwatch_active && stopwatch_toggles==2 && stopwatch_toggled_at==input_timestamp);
    on_key(key,true); on_key(key,false); on_key(key,false);
    assert(stopwatch_toggles==2 && !starts && !text_starts && !ordinary_recordings);
  }
  // A queued voice session overlapping S8 must stop on the same key DOWN.
  for(int feature=4;feature<=6;feature++) {
    reset();press(feature,50000);finish_prompts();stopwatch_active=true;
    on_key(0,true);assert(!stopwatch_active && !capturing);
    assert(feature==4 ? record_stops==1 : feature==5 ? stops==1 : text_stops==1);
    on_key(0,false);assert(!timer_stop_keys[0] && !voice_stop_keys[0]);
    assert(starts+text_starts== (feature==4 ? 0 : 1));
  }
  reset(); mode=MODE_PLAYING;job=JOB_PLAYING;speaker_playing=stopwatch_active=stopwatch_beep_active=true;
  int old_notification_stops=notification_stops;on_key(1,true);
  assert(!stopwatch_active && speaker_playing && job==JOB_PLAYING && notification_stops==old_notification_stops+1 && !interrupted);
  on_key(1,false);
  reset(); alarm_music_active=speaker_playing=true; on_key(0,true);
  assert(!alarm_music_active && !speaker_playing); on_key(0,false);

  // All nine physical keys stop at DOWN; repeated DOWN/held/release cannot
  // cancel saving, toggle S8, open setup, or start a different voice mode.
  for(int key=0;key<9;key++) {
    reset(); press(4,50000); finish_prompts(); on_key(key,true);
    assert(record_stops==1 && mode==MODE_RECORD_READY);
    on_key(key,true); clock_us+=SETUP_LONG_US; on_key(key,false);
    assert(record_stops==1 && ordinary_recordings==1 && !starts && !text_starts && !stopwatch_toggles);
    for(int feature=5;feature<=6;feature++) {
      reset(); press(feature,50000); finish_prompts(); speaker_playing=feature==5;
      on_key(key,true); assert(!capturing && (feature==5 ? stops==1 : text_stops==1));
      on_key(key,true); clock_us+=SETUP_LONG_US; on_key(key,false);
      assert(!stopwatch_toggles && !ordinary_recordings && starts+text_starts==1);
    }
    // A key during either start cue cancels before any audio is captured.
    for(int feature=4;feature<=6;feature++) {
      reset(); press(feature,50000); on_key(key,true); on_key(key,false);
      poll_text_result(clock_us); finish_prompts();
      assert(!ordinary_recordings && !starts && !text_starts && !stopwatch_toggles);
    }
  }

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
  press(0,SETUP_LONG_US);
  assert(stops==1 && ordinary_recordings==0 && mode==MODE_STT);

  // A terminal event between S6 press and release cannot start a new session.
  reset(); begin(); on_key(5,true); worker_busy=capturing=false; push(STT_FAILED); poll_stt_events();
  clock_us+=50000; on_key(5,false); finish_prompts();
  assert(starts==1 && stops==1 && mode==MODE_IDLE);
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

  // Board work cancels webpage capture, while an unsent recording or upload remains protected.
  reset(); realtime_active=true; press(5,50000); finish_prompts(); assert(starts==1 && !realtime_active && !ledger_edit.active);
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
  press(5,50000); press(7,50000); assert(text_stops==1 && stops==0 && !capturing);
  poll_text_result(clock_us); assert(count_played(PROMPT_TRANSCRIPT_SUCCESS)==0);
  press(6,50000); assert(text_stops==1 && !capturing && worker_busy);
  finish_prompts(); assert(mode==MODE_STT && stt_text_result_pending);
  press(6,50000); assert(text_stops==1 && text_starts==1); // Drain cannot restart.
  worker_busy=false; push(STT_FINISHED); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(mode==MODE_IDLE && count_played(PROMPT_TRANSCRIPT_SUCCESS)==1 && count_played(PROMPT_TRANSCRIPT_FAILURE)==0);
  push(STT_FINISHED); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_SUCCESS)==1);

  reset(); press(6,50000); finish_prompts(); capturing=false;
  push(STT_CAPTURE_STOPPED); push(STT_CAPTURE_STOPPED); poll_stt_events(); finish_prompts();
  assert(stt_stop_handled && count_played(PROMPT_STT_WAIT)==1);
  received_texts=acked_texts=1; worker_busy=false; push(STT_FINISHED);
  poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
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
  worker_busy=false; push(STT_EMPTY); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && mode==MODE_IDLE);
  reset(); press(6,50000); finish_prompts(); received_texts=acked_texts=1;
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && count_played(PROMPT_TRANSCRIPT_SUCCESS)==0);

  // Quick cancellation never starts capture, and held keys cannot reopen a round.
  reset(); press(6,50000); press(6,50000); poll_text_result(clock_us); finish_prompts();
  assert(text_starts==0 && text_stops==0 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && mode==MODE_IDLE && delivery_results==0);
  reset(); press(6,50000); finish_prompts(); on_key(6,true);
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  clock_us+=50000; on_key(6,false); finish_prompts(); assert(text_starts==1 && mode==MODE_IDLE);
  reset(); press(6,50000); finish_prompts(); on_key(6,true);
  worker_busy=capturing=false; push(STT_FAILED); poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  begin(); on_key(6,false); assert(stops==0 && worker_busy && capturing); // Old S7 release cannot stop new S6.
  reset(); press(7,50000); assert(mode==MODE_IDLE && !prompt_length && text_starts==0);
  reset(); realtime_active=true; press(6,50000); finish_prompts();
  assert(text_starts==1 && !realtime_active && capturing);
  reset(); strcpy(hold_id,"saved"); press(6,50000); finish_prompts();
  assert(text_starts==0 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1);
  // Retained text is retried without blocking another S7 or counting old ACKs.
  reset(); queued_texts=1; press(6,50000); finish_prompts();
  assert(text_starts==1 && capturing && queued_texts==1 && prior_texts==1);
  sync_text(clock_us); char old_text_id[33], old_text_req[40];
  strcpy(old_text_id,text_inflight_id); strcpy(old_text_req,text_request_id);
  handle_text_receipt("text.displayed",NULL,text_inflight_id,true);
  assert(queued_texts==0 && acked_texts==0 && received_texts==0);
  received_texts=queued_texts=1; sync_text(clock_us);
  assert(strcmp(old_text_id,text_inflight_id)!=0);
  handle_text_receipt("text.displayed",NULL,old_text_id,true);
  handle_text_receipt("text.ack",old_text_req,old_text_id,true);
  assert(acked_texts==0 && queued_texts==1);
  handle_text_receipt("text.displayed",NULL,text_inflight_id,true);
  assert(acked_texts==1 && !queued_texts);
  press(6,50000); finish_prompts(); worker_busy=false; push(STT_FINISHED);
  poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_SUCCESS)==1 && delivery_success && delivery_results==1);
  // An old late receipt cannot turn an empty new recognition into success.
  reset(); queued_texts=1; press(6,50000); finish_prompts(); sync_text(clock_us);
  handle_text_receipt("text.displayed",NULL,text_inflight_id,true);
  press(6,50000); finish_prompts(); worker_busy=false; push(STT_EMPTY);
  poll_stt_events(); finish_prompts(); poll_text_result(clock_us); finish_prompts();
  assert(count_played(PROMPT_TRANSCRIPT_FAILURE)==1 && acked_texts==0 && !delivery_success);
  // A display timeout keeps its text but the following round can start again.
  reset(); press(6,50000); finish_prompts(); received_texts=queued_texts=1;
  press(6,50000); finish_prompts(); worker_busy=false; push(STT_FINISHED); poll_stt_events();
  clock_us+=ACK_TIMEOUT_US; network_available=false; poll_text_result(clock_us); finish_prompts();
  assert(mode==MODE_IDLE && queued_texts==1 && delivery_results==1 && !delivery_success && !delivery_network);
  press(6,50000); finish_prompts();
  assert(text_starts==2 && capturing && queued_texts==1 && prior_texts==1);
  // A rejected engine start records its own error without rewriting prior diagnostics.
  reset(); start_error=-1; press(6,50000); finish_prompts();
  poll_text_result(clock_us); finish_prompts();
  assert(mode==MODE_IDLE && delivery_results==0 && count_played(PROMPT_TRANSCRIPT_FAILURE)==1);
  start_error=0; press(6,50000); finish_prompts(); assert(text_starts==2 && capturing);
  reset(); begin(); queued_texts=1; strcpy(text_inflight_id,"old"); strcpy(text_request_id,"text-4");
  handle_text_receipt("text.displayed",NULL,"old",true); assert(queued_texts==1 && acked_texts==0);
  puts("actual S7 transcript, S6 conversation and immediate S5 controls passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable', '-I', root, '-I', sourceDir, join(root, 'controller.c'), '-o', join(root, 'controller')])
    expect(execFileSync(join(root, 'controller'), { encoding: 'utf8' })).toContain('actual S7 transcript, S6 conversation and immediate S5 controls passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 15000)

it('accepts delayed recent probes once while rejecting expired, unknown and duplicate pongs', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-probe-window-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/voice_chat.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp(`static (?:void|bool) ${name}\\([^;]*?\\)\\n\\{`))
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define CHAT_PROTOCOL 2
#define RETRY_US 3000000
#define PROBE_WINDOW_SIZE 4
#define NETWORK_FRESH_US 8000000LL
#undef strlcpy
#define strlcpy(dst,src,n) snprintf(dst,n,"%s",src)
static char probe_id[24];
static struct { char id[24];int64_t sent_at; } probe_window[PROBE_WINDOW_SIZE];
static unsigned probe_window_next,sequence,sends;
static int64_t probe_at;
static void send_line(const char *line) { assert(strstr(line,"ping"));sends++; }
${extract('probe')}
${extract('accept_probe_pong')}
int main(void) {
  probe(1000000);probe(4000000);probe(7000000);
  assert(sends==3 && probe_at==10000000);
  assert(accept_probe_pong("net-1",8000000)); // Seven seconds old, though newer probes exist.
  assert(!accept_probe_pong("net-1",8000001));
  assert(!accept_probe_pong("net-2",12000000)); // Exact freshness boundary expires.
  assert(!accept_probe_pong("net-unknown",8000000));
  assert(accept_probe_pong("net-3",9000000));
  for(int i=0;i<5;i++)probe(10000000+i*3000000);
  assert(!accept_probe_pong("net-4",22000001)); // Evicted by the fixed-size ring.
  assert(accept_probe_pong("net-8",22000001));
  puts("recent probe window passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('recent probe window passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
