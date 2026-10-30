import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs real alarm persistence, feedback, stopwatch and five-light priorities with a controlled clock', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-timers-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const voice = readFileSync(join(sourceDir, 'voice_chat.c'), 'utf8')
    const extract = (source: string, name: string): string => {
      const start = source.search(new RegExp(`(?:static )?(?:void|bool|int64_t|size_t|voice_chat_wifi_state_t) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const enums = ['job_t', 'ui_mode_t', 'prompt_action_t'].map(name => {
      const end = voice.indexOf(`} ${name};`) + `} ${name};`.length
      return voice.slice(voice.lastIndexOf('typedef enum {', end), end)
    }).join('\n')
    const constants = ['SLOW_BLINK_ON_US', 'SLOW_BLINK_PERIOD_US', 'FLASH_ON_US', 'FLASH_PERIOD_US',
      'ALARM_FLASH_US', 'NETWORK_FRESH_US', 'STOPWATCH_RESULT_CAPACITY', 'PROMPT_SEQUENCE_CAPACITY', 'SETUP_LONG_US']
      .map(name => voice.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    const wifiType = readFileSync(join(sourceDir, 'voice_chat.h'), 'utf8')
      .match(/typedef enum \{[^}]+\} voice_chat_wifi_state_t;/)?.[0]
    if (!wifiType) throw new Error('Missing Wi-Fi state type')
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\nconst char *esp_err_to_name(int);\n')
    writeFileSync(join(root, 'esp_log.h'), '#pragma once\nvoid capture_log(const char *, const char *, ...);\n#define ESP_LOGE(...) capture_log(__VA_ARGS__)\n')
    writeFileSync(join(root, 'nvs.h'), `#pragma once
#include <stdint.h>
#define NVS_READONLY 0
#define NVS_READWRITE 1
typedef int nvs_handle_t;
int nvs_open(const char *, int, nvs_handle_t *);
int nvs_get_u16(nvs_handle_t, const char *, uint16_t *);
int nvs_set_u16(nvs_handle_t, const char *, uint16_t);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
`)
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "timers.h"
#include "esp_err.h"
#include "voice_prompts.h"
#include "nvs.h"
static uint16_t stored_alarm=1440,staged_alarm;
static unsigned commits,set_calls,closes;
static int fail_open,fail_set,fail_commit;
static char last_log[256];
const char *esp_err_to_name(int error) { (void)error;return "TEST_NVS_ERROR"; }
void capture_log(const char *tag,const char *format,...) {
  (void)tag;va_list args;va_start(args,format);vsnprintf(last_log,sizeof(last_log),format,args);va_end(args);
}
static time_t wall_time;
time_t mock_time(time_t *t) { if(t) *t=wall_time; return wall_time; }
int nvs_open(const char *n,int mode,nvs_handle_t *h) {
  assert(!strcmp(n,"schedule"));if(fail_open)return fail_open;
  if(mode==NVS_READWRITE)staged_alarm=stored_alarm;*h=1;return 0;
}
int nvs_get_u16(nvs_handle_t h,const char *key,uint16_t *v) { (void)h;(void)key;*v=stored_alarm;return 0; }
int nvs_set_u16(nvs_handle_t h,const char *key,uint16_t v) {
  (void)h;assert(!strcmp(key,"alarm"));set_calls++;if(fail_set)return fail_set;staged_alarm=v;return 0;
}
int nvs_commit(nvs_handle_t h) { (void)h;commits++;if(fail_commit)return fail_commit;stored_alarm=staged_alarm;return 0; }
void nvs_close(nvs_handle_t h) { (void)h;closes++; }
${constants}
${enums}
${wifiType}
static char wifi_state[16]="disconnected";
static bool wifi_reconfiguring,state_lock;
#define portENTER_CRITICAL(lock) do { assert(!*(lock));*(lock)=true; } while(0)
#define portEXIT_CRITICAL(lock) do { assert(*(lock));*(lock)=false; } while(0)
${extract(readFileSync(join(sourceDir, 'main.c'), 'utf8'), 'get_voice_wifi_state')}
static voice_chat_wifi_state_t (*wifi_status)(void);
#define LIGHT_PIXEL_COUNT 5
typedef struct { int rgb,brightness; bool on; } light_pixel_t;
typedef struct { bool ready; int status_brightness; light_pixel_t pixels[5]; } lights_snapshot_t;
static lights_snapshot_t light_state={.ready=true};
static char pushed_modes[5][8];
static bool lights_push_pending;
static bool (*cloud_online)(void);
static void lights_get_snapshot(lights_snapshot_t *s) { *s=light_state; }
static int lights_set_pixel(int i,const light_pixel_t *p) {
  assert(i>=0 && i<5 && p->brightness==1 && (p->rgb==0 || p->rgb==0xff0000));
  light_state.pixels[i]=*p;return 0;
}
static void queue_light_modes(const char *const modes[5]) { (void)modes; }
#undef strlcpy
#define strlcpy test_strlcpy
static size_t test_strlcpy(char *dst,const char *src,size_t n) { size_t len=strlen(src);if(n)snprintf(dst,n,"%s",src);return len; }
typedef struct { bool recording,speaker_playing; } audio_snapshot_t;
static audio_snapshot_t audio_state;
static void audio_get_snapshot(audio_snapshot_t *s) { *s=audio_state; }
static bool worker_busy,pending_text,unread,uploading_now,realtime_active,mark_all_read_confirming,stream_complete;
static job_t job;
static ui_mode_t mode;
static int64_t alarm_fired_at_us,receiving_until_us,last_network_at;
static int64_t settings_commit_at,setup_deadline;
static int alarm_draft,timer_draft;
static bool setup_waiting;
static uint32_t stopwatch_results[STOPWATCH_RESULT_CAPACITY];
static unsigned stopwatch_result_head,stopwatch_result_count,deferred_timer_events;
static bool stopwatch_start_pending,stopwatch_busy_pending,prompt_playing,stopwatch_beep_active;
static int prompt_length,spoken[128],spoken_count,beeps;
static bool xiaozhi_stt_busy(void) { return worker_busy; }
static bool xiaozhi_stt_pending(void *p) { (void)p;return pending_text; }
static void *earliest_unread(void) { return unread ? &unread : NULL; }
static bool recording_busy(void) { return mode==MODE_RECORDING; }
static bool recording_capturing(void) { return mode==MODE_RECORDING; }
static bool uploading(void) { return uploading_now; }
static unsigned voice_outbox_count(void) { return 0; }
static void append_prompt(int *ids,int *n,int p) { assert(*n<128);ids[(*n)++]=p; }
${extract(readFileSync(join(sourceDir, 'voice_prompts.c'), 'utf8'), 'voice_prompt_number')}
${extract(voice, 'append_number')}
static void start_prompt_sequence(const int *ids,int n,prompt_action_t action) {
  (void)action;assert(!worker_busy && !audio_state.recording && !realtime_active);
  memcpy(spoken,ids,(size_t)n*sizeof(*ids));spoken_count=n;prompt_length=n;
}
static void start_prompt(int p,prompt_action_t a) { start_prompt_sequence(&p,1,a); }
static int audio_play_beep(uint16_t ms,bool strong) { (void)ms;(void)strong;beeps++;return 0; }
static int audio_play_notification(uint16_t ms) { assert(ms==1000);beeps++;return 0; }
static int64_t esp_timer_get_time(void) { return 1; }
static void cancel_realtime_for_work(void) { realtime_active=false; }
static void stop_message_playback(void) {}
static void cancel_countdown(bool prompt) { (void)prompt;timers_cancel_countdown(); }
static void stop_prompt(void) { prompt_length=spoken_count=0;prompt_playing=false; }
static void mark_all_unread_read(void) {}
static void cancel_recording(void) {}
static void network_setup_begin(void) {}
${['network_fresh', 'on_long_key', 'commit_settings', 'toggle_stopwatch', 'append_duration', 'handle_timer_events', 'refresh_lights'].map(name => extract(voice, name)).join('\n')}
static void speech_done(void) { prompt_length=spoken_count=0;prompt_playing=false; }
static void assert_modes(const char *a,const char *b,const char *c,const char *d,const char *e) {
  const char *wanted[]={a,b,c,d,e};
  for(int i=0;i<5;i++) assert(!strcmp(pushed_modes[i],wanted[i]));
}
int main(void) {
  timers_init();unsigned before=commits;
  timers_start_stopwatch(0);assert(timers_stopwatch_active());
  assert(!(timers_poll(59999999)&TIMER_EVENT_STOPWATCH_MINUTE));
  assert(timers_poll(60000000)&TIMER_EVENT_STOPWATCH_MINUTE);
  assert(!(timers_poll(60000001)&TIMER_EVENT_STOPWATCH_MINUTE));
  assert(timers_poll(180000000)&TIMER_EVENT_STOPWATCH_MINUTE);
  assert(!(timers_poll(180000001)&TIMER_EVENT_STOPWATCH_MINUTE));
  timers_start_stopwatch(0);
  assert(timers_stopwatch_seconds(999999)==0 && timers_stopwatch_seconds(1000000)==1);
  assert(timers_stop_stopwatch(59999999)==59 && !timers_stopwatch_active());
  assert(timers_stopwatch_seconds(999000000)==59 && commits==before);
  timers_start_stopwatch(2000000);assert(timers_stopwatch_seconds(1999999)==0);
  assert(timers_stop_stopwatch(3605999999LL)==3603);
  timers_start_stopwatch(0);
  assert(timers_stopwatch_seconds(((int64_t)UINT32_MAX+1)*1000000)==UINT32_MAX);
  timers_init();assert(!timers_stopwatch_active() && !timers_stopwatch_seconds(0));
  timers_start_countdown(2);timers_poll(0);timers_start_stopwatch(0);
  timers_poll(61000000);assert(timers_countdown_seconds()==59 && timers_stopwatch_seconds(61000000)==61);
  timers_stop_stopwatch(61000000);assert(timers_countdown_active());
  timers_cancel_countdown();timers_start_stopwatch(62000000);
  assert(timers_set_alarm_minute(720));timers_init();
  assert(timers_alarm_minute()==720 && !timers_stopwatch_active());

  struct tm alarm_time={.tm_year=126,.tm_mon=9,.tm_mday=29,.tm_hour=12};
  wall_time=mktime(&alarm_time);
  int64_t alarm_poll_us=1000000000;
  assert(timers_poll(alarm_poll_us)&TIMER_EVENT_ALARM);
  const char *stages[]={"nvs_open","nvs_set_u16","nvs_commit"};
  int *failures[]={&fail_open,&fail_set,&fail_commit};
  for(unsigned stage=0;stage<3;stage++) {
    *failures[stage]=0x1101;
    const unsigned old_sets=set_calls,old_commits=commits,old_closes=closes;
    last_log[0]=0;
    assert(!timers_set_alarm_minute(780));
    assert(timers_alarm_minute()==720 && stored_alarm==720);
    assert(strstr(last_log,stages[stage]) && strstr(last_log,"TEST_NVS_ERROR") && strstr(last_log,"0x1101"));
    assert(set_calls==old_sets+(stage>0) && commits==old_commits+(stage>1) && closes==old_closes+(stage>0));
    alarm_poll_us+=1000000;assert(!(timers_poll(alarm_poll_us)&TIMER_EVENT_ALARM));
    assert(!timers_set_alarm_minute(-1));
    assert(timers_alarm_minute()==720 && stored_alarm==720);
    alarm_poll_us+=1000000;assert(!(timers_poll(alarm_poll_us)&TIMER_EVENT_ALARM));

    mode=MODE_SETTING_ALARM;alarm_draft=780;settings_commit_at=1;
    commit_settings(1);
    assert(mode==MODE_IDLE && !settings_commit_at && spoken_count==1 && spoken[0]==PROMPT_TRANSCRIPT_FAILURE);
    assert(timers_alarm_minute()==720 && stored_alarm==720);speech_done();
    alarm_fired_at_us=123;deferred_timer_events=TIMER_EVENT_ALARM|TIMER_EVENT_DONE;
    assert(on_long_key(2));
    assert(mode==MODE_IDLE && spoken_count==1 && spoken[0]==PROMPT_TRANSCRIPT_FAILURE);
    assert(alarm_fired_at_us==123 && deferred_timer_events==(TIMER_EVENT_ALARM|TIMER_EVENT_DONE));
    assert(timers_alarm_minute()==720 && stored_alarm==720);speech_done();
    alarm_poll_us+=1000000;assert(!(timers_poll(alarm_poll_us)&TIMER_EVENT_ALARM));
    *failures[stage]=0;
  }
  assert(timers_set_alarm_minute(780) && timers_alarm_minute()==780 && stored_alarm==780);
  assert(timers_set_alarm_minute(720));
  alarm_poll_us+=1000000;assert(timers_poll(alarm_poll_us)&TIMER_EVENT_ALARM);
  mode=MODE_SETTING_ALARM;alarm_draft=780;settings_commit_at=1;
  commit_settings(1);
  const int alarm_set[]={PROMPT_ALARM_PREFIX,PROMPT_SET_SUFFIX};
  assert(spoken_count==2 && !memcmp(spoken,alarm_set,sizeof(alarm_set)));
  assert(timers_alarm_minute()==780 && stored_alarm==780);speech_done();
  timers_init();assert(timers_alarm_minute()==780);
  assert(on_long_key(2) && spoken_count==1 && spoken[0]==PROMPT_ALARM_CANCEL);
  assert(timers_alarm_minute()==-1 && stored_alarm==1440 && !alarm_fired_at_us && deferred_timer_events==TIMER_EVENT_DONE);
  speech_done();deferred_timer_events=0;timers_init();assert(timers_alarm_minute()==-1);

  assert(timers_set_alarm_minute(-1));refresh_lights(10000000);
  assert_modes("off","off","off","off","off");
  wifi_status=get_voice_wifi_state;
  refresh_lights(10000000);assert(!strcmp(pushed_modes[4],"off"));
  assert(timers_set_alarm_minute(720));refresh_lights(10000000);
  assert_modes("off","solid","off","off","off");
  timers_start_stopwatch(0);refresh_lights(10000000);
  assert_modes("off","flash","off","off","off");assert(light_state.pixels[1].on);
  refresh_lights(10499999);assert(light_state.pixels[1].on);
  refresh_lights(10500000);assert(!light_state.pixels[1].on);
  alarm_fired_at_us=10000000;refresh_lights(10000000);
  assert_modes("off","blink","off","off","off");
  refresh_lights(70000000);assert(!strcmp(pushed_modes[1],"flash"));
  timers_stop_stopwatch(70000000);timers_start_countdown(1);refresh_lights(70000000);
  assert(!strcmp(pushed_modes[1],"flash"));timers_cancel_countdown();
  refresh_lights(70000000);assert(!strcmp(pushed_modes[1],"solid"));
  unread=true;refresh_lights(70000000);assert(!strcmp(pushed_modes[0],"solid"));
  receiving_until_us=70000000+SLOW_BLINK_PERIOD_US;refresh_lights(70000000);assert(!strcmp(pushed_modes[0],"blink"));
  refresh_lights(71999999);assert(!strcmp(pushed_modes[0],"blink"));
  refresh_lights(72000000);assert(!strcmp(pushed_modes[0],"solid"));
  unread=false;job=JOB_PLAYING;stream_complete=false;refresh_lights(73000000);
  assert(!strcmp(pushed_modes[0],"blink"));stream_complete=true;refresh_lights(73000000);
  assert(!strcmp(pushed_modes[0],"off"));job=JOB_IDLE;
  pending_text=true;mode=MODE_STT;refresh_lights(75000000);assert(!strcmp(pushed_modes[2],"solid"));
  mode=MODE_IDLE;refresh_lights(75000000);assert(!strcmp(pushed_modes[2],"blink"));
  pending_text=false;realtime_active=true;last_network_at=75000000;
  strcpy(wifi_state,"connecting");refresh_lights(76000000);
  assert_modes("off","solid","off","blink","blink");
  refresh_lights(76499999);assert(light_state.pixels[3].on && light_state.pixels[4].on);
  refresh_lights(76500000);assert(!light_state.pixels[3].on && !light_state.pixels[4].on);
  refresh_lights(77999999);assert(!light_state.pixels[3].on && !light_state.pixels[4].on);
  refresh_lights(78000000);assert(light_state.pixels[3].on && light_state.pixels[4].on);
  strcpy(wifi_state,"connected");refresh_lights(78500000);
  assert(!strcmp(pushed_modes[4],"solid") && light_state.pixels[4].on);
  refresh_lights(82999999);assert(network_fresh(82999999) && !strcmp(pushed_modes[4],"solid"));
  refresh_lights(83000000);assert(!network_fresh(83000000) && !strcmp(pushed_modes[4],"solid"));
  strcpy(wifi_state,"connecting");refresh_lights(83000001);assert(!strcmp(pushed_modes[4],"blink"));
  wifi_reconfiguring=true;refresh_lights(83000002);assert(!strcmp(pushed_modes[4],"off"));
  strcpy(wifi_state,"disconnected");wifi_reconfiguring=false;last_network_at=83000000;
  refresh_lights(83000003);assert(network_fresh(83000003) && !strcmp(pushed_modes[4],"off"));

  receiving_until_us=86000000;alarm_fired_at_us=84000000;pending_text=true;
  strcpy(wifi_state,"connecting");refresh_lights(84000000);
  assert_modes("blink","blink","blink","blink","blink");
  for(int i=0;i<5;i++)assert(light_state.pixels[i].on);
  refresh_lights(84499999);for(int i=0;i<5;i++)assert(light_state.pixels[i].on);
  refresh_lights(84500000);for(int i=0;i<5;i++)assert(!light_state.pixels[i].on);
  refresh_lights(85999999);for(int i=0;i<5;i++)assert(!light_state.pixels[i].on);
  refresh_lights(86000000);for(int i=1;i<5;i++)assert(light_state.pixels[i].on);
  receiving_until_us=0;pending_text=false;

  realtime_active=false;last_network_at=0;timers_start_stopwatch(0);
  int old_beeps=beeps;audio_state.speaker_playing=true;
  handle_timer_events(TIMER_EVENT_STOPWATCH_MINUTE,60000000);
  assert(beeps==old_beeps+1 && stopwatch_beep_active);
  audio_state.speaker_playing=false;
  toggle_stopwatch(65000000);assert(stopwatch_result_count==1 && !timers_stopwatch_active());
  audio_state.recording=true;handle_timer_events(TIMER_EVENT_ALARM,90000000);
  assert(stopwatch_result_count==1 && deferred_timer_events==TIMER_EVENT_ALARM && alarm_fired_at_us==90000000 && !spoken_count);
  audio_state.recording=false;worker_busy=true;handle_timer_events(0,90000001);assert(!spoken_count);
  worker_busy=false;realtime_active=true;handle_timer_events(0,90000002);assert(!spoken_count);
  realtime_active=false;audio_state.speaker_playing=true;handle_timer_events(0,90000003);assert(!spoken_count);
  audio_state.speaker_playing=false;mode=MODE_PLAYING;job=JOB_DOWNLOAD;
  handle_timer_events(0,90000004);assert(!spoken_count && stopwatch_result_count==1);
  job=JOB_PLAYING;handle_timer_events(0,90000004);assert(!spoken_count);
  mode=MODE_IDLE;handle_timer_events(0,90000004);assert(!spoken_count);
  job=JOB_IDLE;handle_timer_events(0,90000004);
  assert(spoken_count==1 && spoken[0]==PROMPT_ALARM_DUE && stopwatch_result_count==1);
  handle_timer_events(0,90000005);assert(stopwatch_result_count==1);speech_done();
  handle_timer_events(0,90000006);
  const int duration[]={PROMPT_STOPWATCH_TOTAL,PROMPT_DIGIT_1,PROMPT_MINUTES,PROMPT_DIGIT_5,PROMPT_SECONDS};
  assert(spoken_count==5 && !memcmp(spoken,duration,sizeof(duration)) && !stopwatch_result_count);speech_done();
  int ids[128],n=0;append_duration(ids,&n,3601);
  const int hour[]={PROMPT_DIGIT_1,PROMPT_HOURS,PROMPT_DIGIT_1,PROMPT_SECONDS};
  assert(n==4 && !memcmp(ids,hour,sizeof(hour)));n=0;append_duration(ids,&n,0);
  assert(n==2 && ids[0]==PROMPT_DIGIT_0 && ids[1]==PROMPT_SECONDS);
  for(unsigned i=0;i<STOPWATCH_RESULT_CAPACITY;i++) { toggle_stopwatch(100000000);toggle_stopwatch(101000000); }
  assert(stopwatch_result_count==STOPWATCH_RESULT_CAPACITY);toggle_stopwatch(102000000);
  assert(!timers_stopwatch_active() && stopwatch_busy_pending);
  for(unsigned i=0;i<STOPWATCH_RESULT_CAPACITY;i++) { handle_timer_events(0,103000000);assert(spoken[0]==PROMPT_STOPWATCH_TOTAL);speech_done(); }
  handle_timer_events(0,103000000);assert(spoken[0]==PROMPT_STOPWATCH_BUSY);speech_done();
  toggle_stopwatch(104000000);handle_timer_events(0,104000000);
  assert(spoken[0]==PROMPT_STOPWATCH_START && timers_stopwatch_active());
  puts("stopwatch and five-light checks passed");
}
`)
    execFileSync('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Dtime=mock_time', '-Wall', '-Wextra', '-Werror',
      '-Wno-unused-function', '-Wno-unused-variable', '-I', root, '-I', sourceDir,
      join(sourceDir, 'timers.c'), join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('stopwatch and five-light checks passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
