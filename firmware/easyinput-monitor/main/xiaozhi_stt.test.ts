import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs actual streaming STT UTF-8, FIFO, receive and stop boundaries against isolated host storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-tests-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp(`(?:static )?(?:void|bool|int) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing STT function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "xiaozhi_stt.h"
#include "stt_stream.h"
#define PCM_BYTES 1048576
#define STT_JSON_BYTES 16384
#define TEXT_QUEUE_CAPACITY 128
#define TEXT_BATCH_MAX ((STT_JSON_BYTES + 999) / 1000)
#define WEBSOCKET_EVENT_DATA 1
#define WEBSOCKET_EVENT_ERROR 2
#define WEBSOCKET_EVENT_DISCONNECTED 3
#define ESP_FAIL -1
#define ESP_ERR_INVALID_RESPONSE 0x108
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define portMAX_DELAY 0
#define pdTRUE 1
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef const char *esp_event_base_t;
typedef struct { int esp_tls_last_esp_err, esp_tls_stack_err, esp_tls_cert_verify_flags, esp_transport_sock_errno, esp_ws_handshake_status_code, error_type; } ws_errors_t;
typedef struct { int payload_offset, op_code, payload_len, data_len; bool fin; const char *data_ptr; ws_errors_t error_handle; int close_status_code; } esp_websocket_event_data_t;
typedef struct { char json[STT_JSON_BYTES]; } incoming_t;
typedef struct { size_t offset, length; } text_slice_t;
typedef struct { bool microphone_active; int microphone_error; } audio_snapshot_t;
typedef struct cJSON { const char *valuestring; struct cJSON *type, *text; } cJSON;
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *j, const char *key) { return !j ? NULL : !strcmp(key,"type") ? j->type : j->text; }
static bool cJSON_IsString(const cJSON *j) { return j && j->valuestring; }
static int guard=1, microphone_guard=2, capture_lock;
static bool capturing, cancelled, stop_requested, stop_intent, busy, storage_ready = true;
static bool transport_failed, capacity_failed, pending_durable;
static stt_snapshot_t diagnostics;
static void set_stage(const char *stage) { (void)stage; }
static void log_failure(const char *stage, int code) { (void)stage; (void)code; }
static uint8_t data[PCM_BYTES];
static stt_stream_t stream;
static stt_text_t pending, queue_storage[TEXT_QUEUE_CAPACITY], *text_queue = queue_storage, durable;
static size_t text_head, text_count;
static int persist_calls, persist_fail;
static bool persist_text(const stt_text_t *t) { persist_calls++; if(persist_fail) return false; if(t) durable=*t; else memset(&durable,0,sizeof(durable)); return true; }
static void xSemaphoreTake(int q, int wait) { (void)q; (void)wait; }
static void xSemaphoreGive(int q) { (void)q; }
static void esp_fill_random(void *p, size_t n) { static unsigned value; unsigned char *b=p; for(size_t i=0;i<n;i++) b[i]=(unsigned char)++value; }
static char ws_json[STT_JSON_BYTES];
static size_t ws_used, ws_expected, ws_frame_start;
static bool ws_accepting, ws_binary;
static int incoming=1, notifications=2, queued, progress_count, notification_resets;
static bool incoming_full;
static incoming_t last;
static stt_event_t last_event;
#undef strlcpy
#define strlcpy stt_test_strlcpy
static size_t strlcpy(char *dst, const char *src, size_t n) { size_t size=strlen(src); if(n) { size_t used=size<n-1?size:n-1; memcpy(dst,src,used); dst[used]=0; } return size; }
static int xQueueSend(int q, const void *event, int wait) { (void)wait; if(q==incoming) { if(incoming_full) return 0; last=*(const incoming_t *)event; queued++; return 1; } if(progress_count==8) return 0; last_event=*(const stt_event_t *)event; progress_count++; return 1; }
static void xQueueReset(int q) { if(q==notifications) { notification_resets++; progress_count=0; } }
${['notify', 'stream_error', 'capacity_error', 'capacity_exhausted', 'stream_failed', 'sink', 'microphone_healthy', 'capture_running', 'persist_pending_head', 'ws_event', 'utf8_next', 'unicode_space', 'valid_text', 'text_slices', 'enqueue_text', 'receive_message', 'xiaozhi_stt_ack', 'xiaozhi_stt_get_snapshot'].map(extract).join('\n')}
static unsigned stopped;
static bool stop_capture(void) {
  assert(stop_intent && !stop_requested);
  // Simulate the scheduler gap while hardware is already off but capture_closed
  // has not yet been published: this is intentional teardown, not a mic fault.
  const audio_snapshot_t off={0}; assert(microphone_healthy(&off));
  sink((const uint8_t *)"tail",4);
  capturing=false; stopped++; return true;
}
${extract('xiaozhi_stt_stop')}
static void reset(void) {
  memset(&pending,0,sizeof(pending)); memset(queue_storage,0,sizeof(queue_storage));
  text_head=text_count=0; persist_calls=persist_fail=0;
  busy=cancelled=stop_requested=stop_intent=pending_durable=false;
  transport_failed=capacity_failed=false;
  progress_count=notification_resets=0;
  memset(&diagnostics,0,sizeof(diagnostics));
  capturing=true; stt_stream_init(&stream,data,sizeof(data));
}
static void fragment(int opcode,int total,int offset,const char *p,int n) {
  esp_websocket_event_data_t e={.op_code=opcode,.payload_len=total,.payload_offset=offset,.data_ptr=p,.data_len=n,.fin=true};
  ws_event(NULL,NULL,WEBSOCKET_EVENT_DATA,&e);
}
static void receive(const char *type,const char *text) {
  cJSON t={.valuestring=type}, v={.valuestring=text}, j={.type=&t,.text=text?&v:NULL}; bool had=false;
  assert(receive_message(&j,&had));
  assert(had==(!strcmp(type,"stt") && text && text[0]));
}
int main(void) {
  reset();
  assert(valid_text("你好，273元")); assert(valid_text("\\xf0\\x9f\\x98\\x80"));
  assert(!valid_text(" \\t\\n\\r")); assert(!valid_text("\\xe3\\x80\\x80"));
  assert(!valid_text("\\xed\\xa0\\x80")); assert(!valid_text("\\xc0\\x80"));
  assert(!valid_text("\\xf4\\x90\\x80\\x80")); assert(!valid_text("\\xe4\\xb8")); assert(!valid_text("a\\x01"));
  char text[STT_JSON_BYTES];
  for(int i=0;i<1000;i++) memcpy(text+i*3,"字",3);
  text[3000]=0; assert(valid_text(text));
  memset(text,'a',1001); text[1001]=0; assert(!valid_text(text));
  for(int i=0;i<500;i++) memcpy(text+i*4,"\\xf0\\x9f\\x98\\x80",4);
  text[2000]=0; assert(valid_text(text)); text[2000]='a'; text[2001]=0; assert(!valid_text(text));
  text_slice_t slices[TEXT_BATCH_MAX];
  assert(text_slices(text,slices)==2 && slices[0].length==2000 && slices[1].length==1);
  for(int i=0;i<2100;i++) memcpy(text+i*3,"字",3);
  text[6300]=0; assert(text_slices(text,slices)==3);
  assert(slices[0].length==3000 && slices[1].length==3000 && slices[2].length==300);
  assert(enqueue_text(text) && text_count==2 && strlen(pending.text)==3000);
  char rejoined[6400]; strcpy(rejoined,pending.text); strcat(rejoined,text_queue[0].text); strcat(rejoined,text_queue[1].text); assert(!strcmp(rejoined,text));
  assert(text_slices("bad\\xed\\xa0\\x80",slices)==-1);
  const size_t before=text_count; assert(!enqueue_text("bad\\xed\\xa0\\x80") && text_count==before);

  reset(); busy=true;
  receive("stt","第一句"); receive("tts",NULL); receive("llm","assistant reply");
  receive("stt","第二句"); receive("tts",NULL); receive("stt","第三句");
  receive("stt","");
  stt_snapshot_t snapshot; xiaozhi_stt_get_snapshot(&snapshot);
  assert(snapshot.received_texts==3 && snapshot.acked_texts==0 && snapshot.queued_texts==3);
  assert(busy && capturing && text_count==2 && !strcmp(pending.text,"第一句"));
  const stt_text_t first=pending, second=text_queue[text_head];
  assert(persist_calls==0 && !pending_durable); // No Flash writes while capturing.
  capturing=false; assert(persist_pending_head() && pending_durable);
  assert(!xiaozhi_stt_ack("wrong-id") && !strcmp(pending.text,"第一句"));
  persist_fail=1; assert(!xiaozhi_stt_ack(first.id));
  xiaozhi_stt_get_snapshot(&snapshot); assert(snapshot.acked_texts==0 && snapshot.queued_texts==3);
  assert(text_count==2 && !strcmp(pending.id,first.id) && !strcmp(durable.id,first.id));
  persist_fail=0; assert(xiaozhi_stt_ack(first.id));
  assert(text_count==1 && !strcmp(pending.id,second.id) && !strcmp(durable.id,second.id));
  assert(xiaozhi_stt_ack(pending.id)); assert(!strcmp(pending.text,"第三句") && text_count==0);
  assert(xiaozhi_stt_ack(pending.id) && !pending.id[0] && !durable.id[0]);
  xiaozhi_stt_get_snapshot(&snapshot);
  assert(snapshot.received_texts==3 && snapshot.acked_texts==3 && snapshot.queued_texts==0);
  assert(busy && !capturing); // Caller stopped capture; ACKs do not change busy.
  reset(); busy=true; receive("stt","live");
  assert(xiaozhi_stt_ack(pending.id) && persist_calls==0 && busy && capturing);

  reset(); assert(enqueue_text("first"));
  for(int i=0;i<TEXT_QUEUE_CAPACITY;i++) assert(enqueue_text("queued"));
  const stt_text_t head=pending, oldest=text_queue[text_head];
  assert(!enqueue_text("overflow") && text_count==TEXT_QUEUE_CAPACITY && capacity_exhausted());
  assert(!memcmp(&head,&pending,sizeof(head)) && !memcmp(&oldest,&text_queue[text_head],sizeof(oldest)));
  reset(); capturing=false; persist_fail=1; assert(!enqueue_text("save failure") && !pending.id[0] && text_count==0);

  reset();
  fragment(1,7,0,"{\\\"a\\\":",5); assert(!queued);
  fragment(0,7,5,"1}",2); assert(queued==1 && !strcmp(last.json,"{\\\"a\\\":1}"));
  fragment(2,7,0,"ignored",7); assert(queued==1);
  fragment(0,7,0,"ignored",7); assert(queued==1 && !stream_failed());
  fragment(1,STT_JSON_BYTES,0,"x",1); assert(queued==1 && capacity_exhausted());
  reset(); fragment(1,7,0,"{",1); fragment(0,7,2,"xxxxx",5); assert(stream_failed() && !ws_accepting);
  reset(); fragment(1,2,0,"{}",2); assert(queued==2 && !strcmp(last.json,"{}"));
  esp_websocket_event_data_t first_frame={.op_code=1,.payload_len=5,.data_len=5,.data_ptr="{\\\"a\\\":",.fin=false};
  ws_event(NULL,NULL,WEBSOCKET_EVENT_DATA,&first_frame); assert(queued==2);
  fragment(9,1,0,"x",1); fragment(0,2,0,"1}",2); assert(queued==3 && !stream_failed());
  incoming_full=true; fragment(1,2,0,"{}",2); assert(capacity_exhausted()); incoming_full=false;

  reset(); stt_stream_init(&stream,data,8); sink((const uint8_t *)"abc",3);
  sink((const uint8_t *)"123456",6); assert(stream.size==3 && stream.accepted==3 && stream_failed());
  capturing=false; sink((const uint8_t *)"x",1); assert(stream.size==3);
  reset(); busy=true; sink((const uint8_t *)"head",4);
  xiaozhi_stt_stop(); assert(stopped==1 && stop_requested && !capturing && stream.size==8);
  char output[8]; assert(stt_stream_peek(&stream,(uint8_t *)output,8)==8 && !memcmp(output,"headtail",8));
  xiaozhi_stt_stop(); assert(stopped==1);
  const audio_snapshot_t off={0}; stop_intent=false; cancelled=false; capturing=true; assert(!microphone_healthy(&off));
  stop_intent=true; assert(microphone_healthy(&off));
  progress_count=8; notify(STT_DONE,NULL); assert(progress_count==8);
  notify(STT_FINISHED,NULL); assert(progress_count==1 && notification_resets==1 && last_event.kind==STT_FINISHED);
  puts("streaming STT boundaries passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir,
      join(root, 'test.c'), join(sourceDir, 'stt_stream.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('streaming STT boundaries passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('uses PSRAM for real HTTP and hello buffers when internal blocks are below 16 KiB, and reports allocation failures without payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-memory-tests-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp(`static [^\\n]+[ *]${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing memory regression function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'memory.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#define ESP_OK 0
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_RESPONSE 0x108
#define ESP_ERR_TIMEOUT 0x107
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_INTERNAL 4
#define JSON_BYTES 16384
#define STT_JSON_BYTES 16384
#define HTTP_METHOD_POST 1
#define pdMS_TO_TICKS(n) (n)
#define pdTRUE 1
#define esp_crt_bundle_attach NULL
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef int esp_err_t;
typedef void *esp_http_client_handle_t;
typedef struct { const char *url; void *crt_bundle_attach; int timeout_ms; bool disable_auto_redirect; int buffer_size; } esp_http_client_config_t;
typedef struct { char json[STT_JSON_BYTES]; } incoming_t;
typedef struct { const char *valuestring; } cJSON;
typedef struct { const char *version; } app_t;
static const char *TAG="stt", *device="synthetic-device", *client="synthetic-client";
static char logs[4096];
static int external_allocations, internal_attempts, fail_external, opened, receive_hello;
static size_t maximum_request;
static int64_t clock_us;
static int incoming=1;
static cJSON response={.valuestring="hello"};
static int capture_lock;
static bool diagnostic_failed;
static struct { char stage[40]; int error; } diagnostics;
#undef strlcpy
#define strlcpy stt_memory_strlcpy
static size_t strlcpy(char *dst,const char *src,size_t n) { size_t size=strlen(src);if(n) { size_t used=size<n-1?size:n-1;memcpy(dst,src,used);dst[used]=0; }return size; }
static void record_log(const char *tag, const char *format, ...) {
  (void)tag; size_t used=strlen(logs); va_list args; va_start(args,format);
  vsnprintf(logs+used,sizeof(logs)-used,format,args); va_end(args);
}
#define ESP_LOGW(...) record_log(__VA_ARGS__)
static size_t heap_caps_get_free_size(int caps) { return caps & MALLOC_CAP_INTERNAL ? 15000 : 6000000; }
static size_t heap_caps_get_largest_free_block(int caps) { (void)caps; return 7680; }
static void *heap_caps_malloc(size_t bytes,int caps) {
  if(caps & MALLOC_CAP_SPIRAM) { external_allocations++; if(bytes>maximum_request) maximum_request=bytes; return fail_external ? NULL : malloc(bytes); }
  internal_attempts++; return bytes>7680 ? NULL : malloc(bytes);
}
static bool is_cancelled(void) { return false; }
static const app_t *esp_app_get_description(void) { static const app_t a={.version="synthetic"};return &a; }
static esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t *c) { assert(c->buffer_size==2048);return (void *)1; }
static void esp_http_client_set_method(void *h,int method) { (void)h;(void)method; }
static void esp_http_client_set_header(void *h,const char *key,const char *value) { (void)h;(void)key;(void)value; }
static int esp_http_client_get_errno(void *h) { (void)h;return 12; }
static int esp_http_client_get_and_clear_last_tls_error(void *h,int *code,int *flags) { (void)h;*code=0x7f00;*flags=0;return 0; }
static int esp_http_client_open(void *h,int length) { (void)h;(void)length;opened++;return 0; }
static int esp_http_client_write(void *h,const char *body,int length) { (void)h;(void)body;return length; }
static int64_t esp_http_client_fetch_headers(void *h) { (void)h;return 2; }
static int esp_http_client_get_status_code(void *h) { (void)h;return 200; }
static int esp_http_client_read(void *h,char *buffer,int capacity) {
  (void)h;assert(capacity>=2);static int calls;if(calls++%2==0) { memcpy(buffer,"{}",2);return 2; }return 0;
}
static bool esp_http_client_is_complete_data_received(void *h) { (void)h;return true; }
static void esp_http_client_close(void *h) { (void)h; }
static void esp_http_client_cleanup(void *h) { (void)h; }
static cJSON *cJSON_ParseWithLength(const char *s,size_t n) { assert(n==2 && !memcmp(s,"{}",2));return &response; }
static cJSON *cJSON_Parse(const char *s) { assert(!strcmp(s,"{}"));return &response; }
static const cJSON *cJSON_GetObjectItemCaseSensitive(cJSON *j,const char *key) { assert(!strcmp(key,"type"));return j; }
static bool cJSON_IsString(const cJSON *j) { return j && j->valuestring; }
static void cJSON_Delete(cJSON *j) { (void)j; }
static int64_t esp_timer_get_time(void) { clock_us+=100000;return clock_us; }
static int xQueueReceive(int q,incoming_t *event,int wait) { (void)q;(void)wait;if(!receive_hello) return 0;receive_hello=0;strcpy(event->json,"{}");return 1; }
${['set_stage', 'log_failure', 'psram_alloc', 'http_failure', 'http_post', 'wait_type'].map(extract).join('\n')}
int main(void) {
  int status;
  // Reproduce the observed allocator condition: 7680 internal bytes is too small
  // for either real 16384-byte buffer, while PSRAM has megabytes available.
  assert(!heap_caps_malloc(16384,MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT));
  assert(http_post("https://synthetic.invalid/private-token","private-transcript",&status)==&response);
  assert(status==200 && opened==1 && external_allocations==1 && maximum_request==16384 && internal_attempts==1);
  receive_hello=1;assert(wait_type("hello",1000)==&response);
  assert(external_allocations==2 && !logs[0]);
  fail_external=1;
  assert(!http_post("https://synthetic.invalid/private-token","private-transcript",&status));
  assert(opened==1 && status==0 && strstr(logs,"stage=http.buffer") && strstr(logs,"internal_largest=7680"));
  assert(!wait_type("hello",1000) && strstr(logs,"stage=ws.hello_buffer"));
  assert(!strstr(logs,"private-token") && !strstr(logs,"private-transcript") && !strstr(logs,"synthetic-device"));
  puts("PSRAM HTTP and hello regression passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'memory.c'), '-o', join(root, 'memory')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'memory'), { encoding: 'utf8' })).toContain('PSRAM HTTP and hello regression passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('runs actual diagnostic lifecycle and emits capture-stopped once only after confirmed teardown, even with a full notification queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-lifecycle-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp(`(?:static )?[^\n]+[ *]${name}\\([^;]*?\\)\n\\{`))
      if (start < 0) throw new Error(`Missing lifecycle function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_FAIL -1\n#define ESP_ERR_INVALID_STATE 0x103\n#define ESP_ERR_TIMEOUT 0x107\n')
    writeFileSync(join(root, 'lifecycle.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "xiaozhi_stt.h"
#include "stt_stream.h"
#define PCM_BYTES 64
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_SPIRAM 4
#define portMAX_DELAY 0
#define pdTRUE 1
static int guard=1, microphone_guard=2, worker=3, notifications=4, capture_lock;
static int guard_depth, microphone_depth, critical_depth;
static bool busy, cancelled, capturing, stop_requested, stop_intent, cancel_storage_failed, cancel_preparing;
static bool storage_ready=true, identity_ready=true, transport_failed, capacity_failed, pending_durable;
static stt_snapshot_t diagnostics={.stage="idle"};
static bool diagnostic_failed, capture_stopped_pending;
static uint8_t pcm_storage[PCM_BYTES], *pcm=pcm_storage;
static stt_stream_t stream;
static stt_text_t pending;
static size_t text_head, text_count;
static int start_result, stop_result, starts, stops, worker_notifications, notification_resets;
static bool hardware_active, persisted=true;
static stt_event_t events[8];
static unsigned event_count;
static const char *TAG="stt";
static char logs[4096];
static void enter_critical(int *lock) { (void)lock;assert(!critical_depth);critical_depth++; }
static void exit_critical(int *lock) { (void)lock;assert(critical_depth==1);critical_depth--; }
#define portENTER_CRITICAL(p) enter_critical(p)
#define portEXIT_CRITICAL(p) exit_critical(p)
static void xSemaphoreTake(int h,int wait) { (void)wait;assert(!critical_depth);int *depth=h==guard?&guard_depth:&microphone_depth;assert(!*depth);(*depth)++; }
static void xSemaphoreGive(int h) { int *depth=h==guard?&guard_depth:&microphone_depth;assert(*depth==1);(*depth)--; }
static void record_log(const char *tag,const char *format,...) { (void)tag;assert(!critical_depth);size_t used=strlen(logs);va_list args;va_start(args,format);vsnprintf(logs+used,sizeof(logs)-used,format,args);va_end(args); }
#define ESP_LOGW(...) record_log(__VA_ARGS__)
static size_t heap_caps_get_free_size(int caps) { (void)caps;return 6000000; }
static size_t heap_caps_get_largest_free_block(int caps) { (void)caps;return 7680; }
#undef strlcpy
#define strlcpy stt_lifecycle_strlcpy
static size_t strlcpy(char *dst,const char *src,size_t n) { size_t size=strlen(src);if(n) { size_t used=size<n-1?size:n-1;memcpy(dst,src,used);dst[used]=0; }return size; }
static int xQueueSend(int q,const void *event,int wait) { (void)wait;assert(q==notifications);if(event_count==8)return 0;events[event_count++]=*(const stt_event_t *)event;return 1; }
static void xQueueReset(int q) { assert(q==notifications);event_count=0;notification_resets++; }
static int xQueueReceive(int q,void *event,int wait) { (void)wait;assert(q==notifications);if(!event_count)return 0;*(stt_event_t *)event=events[0];memmove(events,events+1,--event_count*sizeof(*events));return 1; }
static void sink(const uint8_t *data,size_t length);
static int audio_live_start(void (*callback)(const uint8_t *,size_t)) {
  assert(callback==sink && microphone_depth==1 && !guard_depth && !critical_depth);starts++;
  if(!start_result) { hardware_active=true;sink((const uint8_t *)"head",4); }
  return start_result;
}
static int audio_live_stop(void) {
  assert(microphone_depth==1 && !guard_depth && !critical_depth);stops++;
  if(!stop_result && hardware_active) { sink((const uint8_t *)"tail",4);hardware_active=false; }
  return stop_result;
}
static void xTaskNotifyGive(int task) { assert(task==worker);worker_notifications++; }
static bool persist_pending_head(void) { assert(!capturing && !hardware_active);return persisted; }
static bool persist_text(const stt_text_t *text) { assert(!text && !hardware_active);return persisted; }
${['set_stage', 'log_failure', 'notify', 'stream_error', 'sink', 'stop_capture', 'capture_running', 'xiaozhi_stt_start', 'xiaozhi_stt_stop', 'xiaozhi_stt_get_snapshot', 'xiaozhi_stt_poll', 'xiaozhi_stt_cancel'].map(extract).join('\n')}
static stt_snapshot_t snapshot(void) { stt_snapshot_t value;xiaozhi_stt_get_snapshot(&value);return value; }
int main(void) {
  _Static_assert(STT_FULL==7 && STT_CAPTURE_STOPPED==8,"existing event values remain stable");
  xiaozhi_stt_get_snapshot(NULL);assert(!xiaozhi_stt_poll(NULL));
  assert(!snapshot().busy && !snapshot().capturing && !strcmp(snapshot().stage,"idle"));
  // Initialization failures remain visible even when no mutex was allocated.
  guard=0;log_failure("init.worker",0x101);assert(xiaozhi_stt_start()==ESP_ERR_INVALID_STATE);
  assert(!strcmp(snapshot().stage,"init.worker") && snapshot().error==0x101);guard=1;
  assert(xiaozhi_stt_start()==ESP_OK && starts==1 && worker_notifications==1);
  assert(snapshot().busy && snapshot().capturing && snapshot().error==0 && snapshot().captured_bytes==4);
  const char *stages[]={"provision","http","ws","hello","listening"};
  for(unsigned i=0;i<sizeof(stages)/sizeof(stages[0]);i++) { set_stage(stages[i]);assert(!strcmp(snapshot().stage,stages[i])); }
  // The first code is preserved, including zero-valued transport error codes.
  log_failure("ws.send_audio",0);log_failure("stream.failed",ESP_FAIL);log_failure("ws.connection_lost",-7);set_stage("finished");
  assert(xiaozhi_stt_start()==ESP_ERR_INVALID_STATE);
  assert(!strcmp(snapshot().stage,"ws.send_audio") && snapshot().error==0 && snapshot().captured_bytes==4);
  // A failed hardware stop must not claim that it is safe to speak a prompt.
  stop_result=ESP_ERR_TIMEOUT;assert(!stop_capture() && hardware_active && snapshot().capturing);
  stt_event_t event;assert(!xiaozhi_stt_poll(&event));
  stop_result=ESP_OK;assert(stop_capture() && !hardware_active && snapshot().busy && !snapshot().capturing);
  assert(snapshot().captured_bytes==8);
  for(int i=0;i<8;i++)notify(STT_DONE,NULL);notify(STT_FAILED,NULL);
  assert(event_count==1 && notification_resets>=2);
  assert(xiaozhi_stt_poll(&event) && event.kind==STT_CAPTURE_STOPPED && !snapshot().capturing);
  assert(xiaozhi_stt_poll(&event) && event.kind==STT_FAILED && !xiaozhi_stt_poll(&event));
  assert(stop_capture() && !xiaozhi_stt_poll(&event));
  busy=false;set_stage("finished");assert(!strcmp(snapshot().stage,"ws.send_audio"));
  // An accepted new start resets diagnostics; normal stop flushes the tail first.
  assert(xiaozhi_stt_start()==ESP_OK && !snapshot().error && !strcmp(snapshot().stage,"starting"));
  xiaozhi_stt_stop();assert(stop_requested && !snapshot().capturing && snapshot().busy);
  assert(!strcmp(snapshot().stage,"draining") && snapshot().captured_bytes==8);
  assert(xiaozhi_stt_poll(&event) && event.kind==STT_CAPTURE_STOPPED);
  assert(xiaozhi_stt_poll(&event) && event.kind==STT_WAIT);
  const int stopped=stops;xiaozhi_stt_stop();assert(stops==stopped && !xiaozhi_stt_poll(&event));
  busy=false;set_stage("finished");assert(!strcmp(snapshot().stage,"finished"));
  assert(xiaozhi_stt_start()==ESP_OK);assert(xiaozhi_stt_cancel());
  assert(!snapshot().capturing && snapshot().busy);
  assert(xiaozhi_stt_poll(&event) && event.kind==STT_CAPTURE_STOPPED);
  assert(xiaozhi_stt_cancel() && !xiaozhi_stt_poll(&event));busy=false;
  // A microphone-start failure has no actual capture to stop and retains its cause.
  start_result=ESP_FAIL;assert(xiaozhi_stt_start()==ESP_FAIL);
  assert(!snapshot().busy && !snapshot().capturing && !strcmp(snapshot().stage,"mic.start") && snapshot().error==ESP_FAIL);
  assert(!xiaozhi_stt_poll(&event));worker=0;assert(xiaozhi_stt_start()==ESP_ERR_INVALID_STATE);
  assert(!strcmp(snapshot().stage,"mic.start"));worker=3;start_result=ESP_OK;
  assert(xiaozhi_stt_start()==ESP_OK && snapshot().error==0 && snapshot().received_texts==0 && snapshot().acked_texts==0);
  assert(stop_capture() && !guard_depth && !microphone_depth && !critical_depth);
  assert(!strstr(logs,"head") && !strstr(logs,"tail"));
  puts("STT diagnostic lifecycle passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir,
      join(root, 'lifecycle.c'), join(sourceDir, 'stt_stream.c'), '-o', join(root, 'lifecycle')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'lifecycle'), { encoding: 'utf8' })).toContain('STT diagnostic lifecycle passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
