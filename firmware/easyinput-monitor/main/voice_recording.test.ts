import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs the real bounded capture ring past 20 seconds, retains retries and flushes an odd PCM tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-recording-')), sourceDir = resolve('firmware/easyinput-monitor/main')
  try {
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "voice_recording.h"
int main(void) {
  uint8_t storage[8192], packet[VOICE_RECORDING_BATCH], retry[VOICE_RECORDING_BATCH];
  int16_t pcm[320]; for(int i=0;i<320;i++) pcm[i]=i%2 ? -1000 : 1000;
  voice_recording_t r; voice_recording_init(&r,storage,sizeof storage);
  // Sixty seconds with bounded memory and retained application-level ACKs.
  for(int block=0;block<3000;block++) {
    assert(voice_recording_pcm(&r,(uint8_t*)pcm,sizeof pcm));
    size_t n=voice_recording_packet(&r,packet,sizeof packet);
    if(n) {
      assert(n%768==0 && n<=VOICE_RECORDING_BATCH);
      assert(voice_recording_packet(&r,retry,sizeof retry)==n && !memcmp(packet,retry,n));
      assert(!voice_recording_ack(&r,r.acknowledged+n+1));
      assert(voice_recording_ack(&r,r.acknowledged+n));
      assert(!voice_recording_ack(&r,r.acknowledged));
    }
    assert(r.size<sizeof storage && !r.failed);
  }
  assert(r.accepted==480000 && !r.stopped);
  // A PCM pair may straddle callback boundaries. A lone final sample is retained.
  int16_t half=32767; assert(voice_recording_pcm(&r,(uint8_t*)&half,2));
  assert(r.has_half && r.accepted==480000);
  voice_recording_stop(&r); voice_recording_stop(&r);
  assert(r.accepted==480001 && !r.has_half);
  size_t n=voice_recording_packet(&r,packet,sizeof packet); assert(n && packet[n-1]==128);
  assert(voice_recording_ack(&r,r.acknowledged+n));
  assert(r.acknowledged==480001 && r.size==0 && voice_recording_packet(&r,packet,sizeof packet)==0);
  assert(!voice_recording_pcm(&r,(uint8_t*)pcm,sizeof pcm));
  // Never silently overwrite unacknowledged audio on overflow.
  voice_recording_init(&r,storage,160);
  assert(voice_recording_pcm(&r,(uint8_t*)pcm,sizeof pcm));
  memcpy(retry,storage,160);
  assert(!voice_recording_pcm(&r,(uint8_t*)pcm,sizeof pcm) && r.failed && r.accepted==160);
  assert(!memcmp(retry,storage,160));
  voice_recording_stop(&r); assert(voice_recording_packet(&r,packet,sizeof packet)==160);
  assert(voice_recording_ack(&r,160));
  voice_recording_init(&r,storage,sizeof storage);
  half=1000; assert(voice_recording_pcm(&r,(uint8_t*)&half,2)); half=-1000;
  assert(voice_recording_pcm(&r,(uint8_t*)&half,2)); voice_recording_stop(&r);
  assert(voice_recording_packet(&r,packet,sizeof packet)==1 && packet[0]==255);
  int16_t out[4]; uint8_t encoded[]={255,128}; voice_recording_decode(encoded,2,out);
  assert(out[0]==0 && out[1]==0 && out[2]==32124 && out[3]==32124);
  puts("bounded long recording, retained retry, tail and overflow passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', sourceDir, join(sourceDir, 'voice_recording.c'), join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('tail and overflow passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('runs actual S5 controller begin/append/stop/finish/retry/cancel and bounded long playback in C', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-recording-controller-')), sourceDir = resolve('firmware/easyinput-monitor/main')
  try {
    const source = readFileSync(join(sourceDir, 'voice_chat.c'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp('static (?:void|bool|size_t) ' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error(`Missing ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const enums = ['job_t', 'ui_mode_t', 'prompt_action_t'].map(name => {
      const end = source.indexOf('} ' + name + ';') + ('} ' + name + ';').length
      return source.slice(source.lastIndexOf('typedef enum {', end), end)
    }).join('\n')
    const recordingGlobals = source.slice(source.indexOf('typedef enum { REC_IDLE'), source.indexOf('static bool recording_busy'))
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "voice_recording.h"
#define ESP_OK 0
#define ESP_ERR_NO_MEM 1
#define MALLOC_CAP_SPIRAM 0
#define MALLOC_CAP_8BIT 0
#define CHUNK 768
#define STREAM_WINDOW 24
#define PREBUFFER 9216
#define VOICE_SILENCE_US 60000000LL
#define VOICE_SESSION_US 3600000000LL
#define portMUX_INITIALIZER_UNLOCKED false
typedef bool portMUX_TYPE;
#define portENTER_CRITICAL(lock) do { assert(!*(lock)); *(lock)=true; } while(0)
#define portEXIT_CRITICAL(lock) do { assert(*(lock)); *(lock)=false; } while(0)
typedef int esp_err_t;
${enums}
${recordingGlobals}
static ui_mode_t mode;
static job_t job;
static uint32_t sequence;
static int64_t clock_us=1000000, sync_at;
static bool online=true, capture, stream_started, stream_complete;
static int network_via=1, last_prompt, capture_starts, capture_stops, requests;
static uint8_t *audio_data;
static size_t audio_size;
static bool speaker_started, speaker_finished, speaker_full;
static size_t speaker_frames;
static int stream_requests;
static void (*capture_sink)(const uint8_t*,size_t);
static int16_t tail=32767;
static bool append_tail;
// A tiny structural JSON double: the real controller selects every operation,
// request ID, exact byte offset, and state transition under test.
typedef struct cJSON { char valuestring[9000]; double valuedouble; int kind; struct cJSON *fields[8]; char names[8][24]; int count; } cJSON;
static cJSON *new_frame(const char *op) { cJSON *v=calloc(1,sizeof(*v)); strcpy(v->valuestring,op); return v; }
static void cJSON_AddStringToObject(cJSON *v,const char *k,const char *s) { int i=v->count++; assert(i<8); strcpy(v->names[i],k); v->fields[i]=calloc(1,sizeof(*v)); v->fields[i]->kind=1; strcpy(v->fields[i]->valuestring,s); }
static void cJSON_AddNumberToObject(cJSON *v,const char *k,double n) { cJSON_AddStringToObject(v,k,""); v->fields[v->count-1]->kind=2; v->fields[v->count-1]->valuedouble=n; }
static void cJSON_AddBoolToObject(cJSON *v,const char *k,bool b) { cJSON_AddNumberToObject(v,k,b); v->fields[v->count-1]->kind=3; }
static cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *v,const char *k) { for(int i=0;i<v->count;i++) if(!strcmp(v->names[i],k)) return v->fields[i]; return NULL; }
static bool cJSON_IsString(const cJSON *v) { return v && v->kind==1; }
static bool cJSON_IsNumber(const cJSON *v) { return v && v->kind==2; }
static bool cJSON_IsTrue(const cJSON *v) { return v && v->kind==3 && v->valuedouble==1; }
static void cJSON_Delete(cJSON *v) { if(!v)return; for(int i=0;i<v->count;i++) free(v->fields[i]); free(v); }
static char *cJSON_PrintUnformatted(cJSON *v) {
  char *out=calloc(1,10000); size_t n=(size_t)sprintf(out,"%s",v->valuestring);
  for(int i=0;i<v->count;i++) n+=(size_t)sprintf(out+n,"|%s=%s:%.0f",v->names[i],v->fields[i]->valuestring,v->fields[i]->valuedouble);
  return out;
}
static int mbedtls_base64_encode(unsigned char *out,size_t capacity,size_t *length,const uint8_t *in,size_t n) {
  assert(capacity>n); for(size_t i=0;i<n;i++)out[i]='A'+in[i]%26; *length=n; return 0;
}
static void *heap_caps_malloc(size_t n,int caps) { (void)caps; return malloc(n); }
static uint32_t esp_random(void) { static uint32_t r; return ++r; }
static int64_t esp_timer_get_time(void) { return clock_us; }
static bool network_fresh(int64_t now) { (void)now; return online; }
static bool cloud_state(void) { return online; }
static bool (*cloud_online)(void)=cloud_state;
static bool immediate(const char *line) { assert(line && *line); requests++; return online; }
static bool (*send_immediate_line)(const char*)=immediate;
static bool uploading(void) { return false; }
static bool realtime_active;
static void finish_job(void) { job=JOB_IDLE; }
static void stop_prompt(void) {}
static void start_prompt(int p,prompt_action_t action) { (void)action; last_prompt=p; }
#define PROMPT_OFFLINE 1
#define PROMPT_SAVE_FAILED 2
#define PROMPT_SEND_OK 3
#define PROMPT_RECORD_CANCELLED 4
static bool vad;
typedef struct { bool live_sink_active, vad; int microphone_error; } audio_snapshot_t;
static void audio_get_snapshot(audio_snapshot_t *v) { *v=(audio_snapshot_t){.live_sink_active=capture,.vad=vad}; }
static int audio_live_start(void (*sink)(const uint8_t*,size_t)) { capture_starts++; capture=true; capture_sink=sink; return 0; }
static int audio_live_stop(void) { capture_stops++; if(append_tail) capture_sink((uint8_t*)&tail,2); capture=false; return 0; }
static int audio_pcm_start(void) { assert(!speaker_started); speaker_started=true; return 0; }
static int audio_pcm_write(const int16_t *p,size_t n) { assert(p && n<=CHUNK*2); if(speaker_full)return ESP_ERR_NO_MEM; speaker_frames+=n; return 0; }
static int audio_pcm_finish(void) { speaker_finished=true; return 0; }
static void request_stream(void) { stream_requests++; }
${['json_uint', 'recording_sink', 'recording_reset', 'recording_request', 'stop_recording_stream', 'start_recording', 'recording_step', 'recording_receive', 'advance_stream_playback'].map(extract).join('\n')}
static bool recording_busy(void) { return recording_stage!=REC_IDLE; }
`)
    // Add forward declarations before extracted functions (their real file has the helpers above them).
    let harness = readFileSync(join(root, 'test.c'), 'utf8')
    harness = harness.replace('static bool json_uint(', 'static bool recording_busy(void);\nstatic bool json_uint(')
    harness += `
static void ack(const char *state,uint32_t offset,bool interrupted) {
  cJSON *v=new_frame("record.ack"); cJSON_AddStringToObject(v,"id",recording_id);
  cJSON_AddStringToObject(v,"state",state); cJSON_AddNumberToObject(v,"offset",offset); cJSON_AddBoolToObject(v,"interrupted",interrupted);
  char req[32]; strcpy(req,recording_req);
  assert(recording_receive(v,"record.ack",req)); cJSON_Delete(v);
}
int main(void) {
  online=false; start_recording(); assert(recording_stage==REC_IDLE && !capture && last_prompt==PROMPT_OFFLINE);
  online=true; start_recording(); assert(recording_stage==REC_BEGIN && !capture);
  recording_step(clock_us); assert(requests==1);
  ack("recording",0,false); assert(capture && recording_stage==REC_CAPTURE);
  int16_t pcm[320]={0};
  for(int i=0;i<1500;i++) {
    clock_us+=20000; capture_sink((uint8_t*)pcm,sizeof pcm); recording_step(clock_us);
    if(recording_line) ack("recording",recording.acknowledged+recording.inflight,false);
  }
  assert(recording.accepted==240000 && capture && last_prompt!=PROMPT_SEND_OK);
  // Lose an ACK: retries are byte-identical and the ring is not consumed.
  for(int i=0;i<8;i++) capture_sink((uint8_t*)pcm,sizeof pcm);
  recording_step(clock_us); assert(recording_line);
  char *retry=malloc(strlen(recording_line)+1); strcpy(retry,recording_line);
  const size_t retained=recording.size; clock_us+=1000000; recording_step(clock_us);
  assert(!strcmp(retry,recording_line) && retained==recording.size); free(retry);
  cJSON *wrong=new_frame("record.ack"); assert(!recording_receive(wrong,"record.ack","wrong-request")); cJSON_Delete(wrong);
  const uint32_t end=recording.acknowledged+recording.inflight;
  ack("recording",end+1,false); assert(recording_line && recording.size==retained);
  // Stop flushes the audio-task tail even with an append still unacknowledged.
  append_tail=true; stop_recording_stream(); append_tail=false;
  assert(!capture && recording_stage==REC_DRAIN && recording.accepted==241281 && recording.stopped);
  ack("recording",end,false);
  for(int i=0;recording_stage!=REC_FINISH;i++) {
    assert(i<10); recording_step(++clock_us);
    if(recording_stage==REC_DRAIN && recording_line) ack("recording",recording.acknowledged+recording.inflight,false);
  }
  assert(last_prompt!=PROMPT_SEND_OK && recording.acknowledged==241281);
  ack("finished",241281,false); assert(recording_stage==REC_IDLE && last_prompt==PROMPT_SEND_OK);
  // Interrupted finish never reports full success.
  start_recording(); ack("recording",0,false); capture_sink((uint8_t*)pcm,sizeof pcm);
  recording_interrupted=true; stop_recording_stream(); recording_step(++clock_us);
  ack("recording",160,false); recording_step(++clock_us); ack("finished",160,true);
  assert(last_prompt==PROMPT_SAVE_FAILED);
  // A second press before begin ACK cancels without opening the microphone.
  int starts=capture_starts; start_recording(); stop_recording_stream();
  ack("cancelled",0,false); assert(capture_starts==starts);
  start_recording(); ack("recording",0,false); clock_us+=30000000; recording_step(clock_us);
  assert(!capture && !recording_busy() && last_prompt==PROMPT_OFFLINE);
  // Silence timeout uses capture start, not cloud ACKs; it flushes and saves
  // its final sample through the normal drain/finish path.
  start_recording(); ack("recording",0,false);
  const int64_t capture_at=clock_us;
  capture_sink((uint8_t*)pcm,sizeof pcm);
  for(int i=1;i<=60;i++) {
    clock_us=capture_at+(int64_t)i*1000000-1;
    capture_sink((uint8_t*)pcm,sizeof pcm); recording_step(clock_us);
    if(recording_line) ack("recording",recording.acknowledged+recording.inflight,false);
    assert(capture);
  }
  const uint32_t silence_samples=recording.accepted;
  clock_us=capture_at+VOICE_SILENCE_US; append_tail=true;
  recording_step(clock_us); append_tail=false;
  assert(!capture && recording.stopped && !recording_interrupted && recording.accepted==silence_samples+1);
  if(recording_line) ack("recording",recording.acknowledged+recording.inflight,false);
  recording_step(++clock_us); ack("finished",silence_samples+1,false);
  assert(last_prompt==PROMPT_SEND_OK && !recording_busy());
  // New sessions reset the idle clock. Voice resets it; noisy continuous VAD
  // cannot extend the absolute one-hour cap. Keep cloud progress healthy.
  start_recording(); ack("recording",0,false); vad=true;
  const int64_t noisy_at=clock_us;
  for(int i=1;i<3600;i++) {
    clock_us=noisy_at+(int64_t)i*1000000;
    recording_progress_at=clock_us; recording_step(clock_us); assert(capture);
  }
  clock_us=noisy_at+VOICE_SESSION_US-1; recording_progress_at=clock_us;
  recording_step(clock_us); assert(capture);
  clock_us++; recording_step(clock_us); assert(!capture && !recording_interrupted);
  ack("finished",0,false); vad=false;
  // A voiced frame grants a new full 60-second silence window.
  start_recording(); ack("recording",0,false);
  clock_us+=59000000; recording_progress_at=clock_us; vad=true;
  recording_step(clock_us); assert(capture); vad=false;
  clock_us+=VOICE_SILENCE_US-1; recording_progress_at=clock_us;
  recording_step(clock_us); assert(capture);
  clock_us++; recording_step(clock_us); assert(!capture);
  ack("finished",0,false);
  // Long playback feeds a constant 18 KiB window, retries speaker backpressure,
  // and finishes only after the final input window has drained.
  audio_data=malloc(STREAM_WINDOW*CHUNK); memset(audio_data,255,STREAM_WINDOW*CHUNK);
  audio_size=400017; stream_started=stream_complete=false; playback_read=playback_buffered=0;
  for(size_t offset=0;offset<audio_size;) {
    playback_buffered=audio_size-offset<STREAM_WINDOW*CHUNK ? audio_size-offset : STREAM_WINDOW*CHUNK;
    playback_read=0; playback_window_done=true; stream_complete=offset+playback_buffered==audio_size;
    speaker_full=true; assert(advance_stream_playback() && playback_read==0);
    speaker_full=false;
    size_t window=playback_buffered;
    for(int i=0;i<STREAM_WINDOW+1 && playback_window_done;i++) assert(advance_stream_playback());
    if(stream_complete) assert(speaker_finished);
    offset+=window;
  }
  assert(speaker_frames==audio_size*2 && speaker_finished && playback_finish_sent);
  free(audio_data);
  puts("S5 durable session and bounded long playback passed");
}
`
    writeFileSync(join(root, 'test.c'), harness)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable', '-I', sourceDir, join(sourceDir, 'voice_recording.c'), join(root, 'test.c'), '-o', join(root, 'test')])
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('S5 durable session and bounded long playback passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
