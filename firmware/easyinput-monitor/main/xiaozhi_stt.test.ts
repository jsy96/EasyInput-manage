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
typedef struct { char json[STT_JSON_BYTES]; size_t length; bool binary; } incoming_t;
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
static size_t text_head, text_count, prior_texts_remaining;
static int persist_calls, persist_fail;
static bool persist_text(const stt_text_t *t) { persist_calls++; if(persist_fail) return false; if(t) durable=*t; else memset(&durable,0,sizeof(durable)); return true; }
static void xSemaphoreTake(int q, int wait) { (void)q; (void)wait; }
static void xSemaphoreGive(int q) { (void)q; }
static void esp_fill_random(void *p, size_t n) { static unsigned value; unsigned char *b=p; for(size_t i=0;i<n;i++) b[i]=(unsigned char)++value; }
static incoming_t ws_message;
static char *ws_json=ws_message.json;
static size_t ws_used, ws_expected, ws_frame_start;
static bool ws_accepting, ws_binary, dialogue_session;
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
  text_head=text_count=prior_texts_remaining=0; persist_calls=persist_fail=0;
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

  // One long server utterance becomes three chat rows, all of which must be
  // acknowledged. Repeating the same speech is a new utterance with new IDs.
  reset(); busy=true; receive("stt",text);
  stt_snapshot_t split; xiaozhi_stt_get_snapshot(&split);
  assert(split.received_texts==3 && split.acked_texts==0 && split.queued_texts==3);
  const stt_text_t split_first=pending;
  assert(xiaozhi_stt_ack(pending.id) && xiaozhi_stt_ack(pending.id) && xiaozhi_stt_ack(pending.id));
  assert(!xiaozhi_stt_ack(split_first.id));
  xiaozhi_stt_get_snapshot(&split);
  assert(split.received_texts==3 && split.acked_texts==3 && split.queued_texts==0 && persist_calls==0);
  receive("stt",text); assert(strcmp(pending.id,split_first.id));
  xiaozhi_stt_get_snapshot(&split);
  assert(split.received_texts==6 && split.acked_texts==3 && split.queued_texts==3);
  assert(xiaozhi_stt_ack(pending.id) && xiaozhi_stt_ack(pending.id) && xiaozhi_stt_ack(pending.id));
  xiaozhi_stt_get_snapshot(&split);
  assert(split.received_texts==6 && split.acked_texts==6 && !split.queued_texts && persist_calls==0);

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
  xiaozhi_stt_get_snapshot(&snapshot); assert(snapshot.received_texts==TEXT_QUEUE_CAPACITY+1 && !snapshot.acked_texts);
  reset(); capturing=false; persist_fail=1; assert(!enqueue_text("save failure") && !pending.id[0] && text_count==0);

  reset();
  fragment(1,7,0,"{\\\"a\\\":",5); assert(!queued);
  fragment(0,7,5,"1}",2); assert(queued==1 && !strcmp(last.json,"{\\\"a\\\":1}"));
  assert(!last.binary && last.length==7);
  fragment(2,7,0,"ignored",7); assert(queued==1);
  fragment(0,7,0,"ignored",7); assert(queued==1 && !stream_failed());
  fragment(1,STT_JSON_BYTES,0,"x",1); assert(queued==1 && capacity_exhausted());
  reset(); fragment(1,7,0,"{",1); fragment(0,7,2,"xxxxx",5); assert(stream_failed() && !ws_accepting);
  reset(); fragment(1,2,0,"{}",2); assert(queued==2 && !strcmp(last.json,"{}"));
  esp_websocket_event_data_t first_frame={.op_code=1,.payload_len=5,.data_len=5,.data_ptr="{\\\"a\\\":",.fin=false};
  ws_event(NULL,NULL,WEBSOCKET_EVENT_DATA,&first_frame); assert(queued==2);
  fragment(9,1,0,"x",1); fragment(0,2,0,"1}",2); assert(queued==3 && !stream_failed());
  incoming_full=true; fragment(1,2,0,"{}",2); assert(capacity_exhausted()); incoming_full=false;

  // Conversation downlink assembles binary frames in the same ordered queue.
  reset(); dialogue_session=true; queued=0; ws_accepting=false;
  fragment(2,4,0,"ab",2); assert(!queued);
  fragment(0,4,2,"cd",2); assert(queued==1 && last.binary && last.length==4 && !memcmp(last.json,"abcd",4));
  esp_websocket_event_data_t binary_first={.op_code=2,.payload_len=2,.data_len=2,.data_ptr="ef",.fin=false};
  ws_event(NULL,NULL,WEBSOCKET_EVENT_DATA,&binary_first); assert(queued==1);
  fragment(0,2,0,"gh",2); assert(queued==2 && last.binary && last.length==4 && !memcmp(last.json,"efgh",4));
  fragment(1,2,0,"{}",2); assert(queued==3 && !last.binary && last.length==2);
  reset(); ws_accepting=false; fragment(2,4,0,"x",1); fragment(0,4,2,"yz",2);
  assert(stream_failed() && !ws_accepting);
  reset(); ws_accepting=false; fragment(2,STT_JSON_BYTES,0,"x",1); assert(capacity_exhausted());
  reset(); ws_accepting=false; incoming_full=true; fragment(2,2,0,"ab",2);
  assert(capacity_exhausted()); incoming_full=false; dialogue_session=false;

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
typedef struct { char json[STT_JSON_BYTES]; size_t length; bool binary; } incoming_t;
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
static void stream_error(void) {}
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
static int xQueueReceive(int q,incoming_t *event,int wait) { (void)q;(void)wait;if(!receive_hello) return 0;receive_hello=0;memset(event,0,sizeof(*event));strcpy(event->json,"{}");return 1; }
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
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n#define ESP_FAIL -1\n#define ESP_ERR_NO_MEM 0x101\n#define ESP_ERR_INVALID_RESPONSE 0x108\n#define ESP_ERR_INVALID_STATE 0x103\n#define ESP_ERR_TIMEOUT 0x107\n')
    writeFileSync(join(root, 'lifecycle.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "xiaozhi_stt.h"
#include "stt_stream.h"
#define PCM_BYTES 64
#define STT_JSON_BYTES 16384
#define TEXT_QUEUE_CAPACITY 128
#define TEXT_BATCH_MAX 17
#define NVS_READWRITE 1
#define ESP_ERR_NVS_NOT_FOUND 0x1102
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_SPIRAM 4
#define portMAX_DELAY 0
#define pdTRUE 1
static int guard=1, microphone_guard=2, worker=3, notifications=4, capture_lock;
static int guard_depth, microphone_depth, critical_depth;
static bool busy, cancelled, capturing, stop_requested, stop_intent, cancel_storage_failed, cancel_preparing;
static bool storage_ready=true, identity_ready=true, transport_failed, capacity_failed, pending_durable, dialogue_session;
static stt_snapshot_t diagnostics={.stage="idle"};
static bool diagnostic_failed, capture_stopped_pending;
static uint8_t pcm_storage[PCM_BYTES], *pcm=pcm_storage;
static stt_stream_t stream;
static stt_text_t pending, queue_storage[TEXT_QUEUE_CAPACITY], *text_queue=queue_storage, durable;
static size_t text_head, text_count, prior_texts_remaining;
typedef struct { size_t offset, length; } text_slice_t;
typedef int nvs_handle_t;
static int nvs_open(const char *name,int mode,nvs_handle_t *handle) { assert(!strcmp(name,"stt") && mode==NVS_READWRITE);*handle=1;return ESP_OK; }
static int nvs_get_blob(nvs_handle_t handle,const char *key,void *text,size_t *length) { assert(handle==1 && !strcmp(key,"pending") && *length==sizeof(durable));memcpy(text,&durable,sizeof(durable));return durable.id[0]?ESP_OK:ESP_ERR_NVS_NOT_FOUND; }
static void nvs_close(nvs_handle_t handle) { assert(handle==1); }
static void esp_fill_random(void *data,size_t size) { static unsigned value;unsigned char *bytes=data;for(size_t i=0;i<size;i++)bytes[i]=(unsigned char)++value; }
static int start_result, stop_result, starts, stops, worker_notifications, notification_resets;
static bool hardware_active, persisted=true;
static int speaker_stops;
static int audio_stop_speaker(void) { speaker_stops++;return ESP_OK; }
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
static bool persist_text(const stt_text_t *text) { assert(!hardware_active);if(!persisted)return false;if(text)durable=*text;else memset(&durable,0,sizeof(durable));return true; }
${['set_stage', 'log_failure', 'notify', 'stream_error', 'capacity_error', 'sink', 'stop_capture', 'capture_running', 'utf8_next', 'unicode_space', 'valid_text', 'text_slices', 'enqueue_text', 'restore_pending_head', 'xiaozhi_dialogue_start', 'xiaozhi_dialogue_stop', 'xiaozhi_stt_start', 'xiaozhi_stt_stop', 'xiaozhi_stt_get_snapshot', 'xiaozhi_stt_delivery_result', 'xiaozhi_stt_ack', 'xiaozhi_stt_poll', 'xiaozhi_stt_cancel'].map(extract).join('\n')}
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
  busy=false; pending.id[0]='p'; pending_durable=true; text_count=2;
  const int old_starts=starts, old_notifications=worker_notifications;
  assert(xiaozhi_stt_start()==ESP_OK && starts==old_starts+1);
  assert(snapshot().received_texts==0 && snapshot().acked_texts==0 && snapshot().queued_texts==3 && !snapshot().session_queued_texts);
  assert(pending.id[0]=='p' && pending_durable && text_count==2 && snapshot().busy);
  assert(stop_capture());busy=false;
  // Connecting does not capture speech and does not discard old pending text.
  assert(xiaozhi_dialogue_start()==ESP_OK && dialogue_session && snapshot().busy && !snapshot().capturing);
  assert(starts==old_starts+1 && worker_notifications==old_notifications+2 && !strcmp(snapshot().stage,"connecting"));
  assert(pending.id[0]=='p' && pending_durable && text_count==2);
  assert(xiaozhi_dialogue_start()==ESP_ERR_INVALID_STATE);
  xiaozhi_stt_stop(); assert(!cancelled && !stop_intent && !stop_requested && !speaker_stops);
  xiaozhi_dialogue_stop(); assert(cancelled && stop_intent && !hardware_active && !snapshot().capturing);
  assert(speaker_stops==1 && pending.id[0]=='p' && pending_durable && text_count==2);
  xiaozhi_dialogue_stop(); assert(speaker_stops==1); // Idempotent stop cannot cut its own end cue.
  busy=false; cancelled=false; dialogue_session=false; xiaozhi_dialogue_stop(); assert(speaker_stops==1);
  // The real restore path classifies the durable head as an earlier session.
  pending=(stt_text_t){0};text_head=text_count=prior_texts_remaining=0;
  diagnostics=(stt_snapshot_t){0};diagnostic_failed=false;
  strcpy(durable.id,"11111111111111111111111111111111");strcpy(durable.text,"restored");
  restore_pending_head();assert(storage_ready && pending_durable && prior_texts_remaining==1);
  assert(snapshot().queued_texts==1 && !snapshot().session_queued_texts);
  assert(xiaozhi_stt_ack(pending.id) && !snapshot().acked_texts && !snapshot().queued_texts);
  // Failed ACK persistence retains both the prior boundary and the durable head.
  assert(enqueue_text("older"));const stt_text_t older=pending;
  assert(xiaozhi_stt_start()==ESP_OK && prior_texts_remaining==1);
  assert(enqueue_text("current first") && enqueue_text("current second"));
  assert(snapshot().received_texts==2 && snapshot().session_queued_texts==2 && snapshot().queued_texts==3);
  assert(stop_capture());busy=false;persisted=false;
  assert(!xiaozhi_stt_ack(older.id) && prior_texts_remaining==1 && !snapshot().acked_texts && snapshot().queued_texts==3);
  persisted=true;assert(xiaozhi_stt_ack(older.id) && !prior_texts_remaining && !snapshot().acked_texts);
  assert(!xiaozhi_stt_ack(older.id) && snapshot().session_queued_texts==2);
  assert(xiaozhi_stt_ack(pending.id) && snapshot().acked_texts==1 && snapshot().session_queued_texts==1);
  xiaozhi_stt_delivery_result(false,true);assert(!strcmp(snapshot().stage,"delivery.display_timeout") && snapshot().error==ESP_ERR_TIMEOUT);
  // A new accepted start retains the previous unsent text and resets diagnostics.
  assert(xiaozhi_stt_start()==ESP_OK && snapshot().received_texts==0 && !snapshot().session_queued_texts && snapshot().queued_texts==1);
  assert(enqueue_text("retry current"));assert(xiaozhi_stt_ack(pending.id) && !snapshot().acked_texts);
  assert(xiaozhi_stt_ack(pending.id) && snapshot().acked_texts==1 && !snapshot().session_queued_texts);
  assert(stop_capture());busy=false;xiaozhi_stt_delivery_result(true,true);
  assert(!strcmp(snapshot().stage,"delivered") && !snapshot().error);
  // The queue holds one durable head plus 128 RAM rows; partial backlog is valid.
  assert(enqueue_text("full head"));for(int i=0;i<TEXT_QUEUE_CAPACITY-1;i++)assert(enqueue_text("old"));
  assert(xiaozhi_stt_start()==ESP_OK && prior_texts_remaining==TEXT_QUEUE_CAPACITY);
  assert(enqueue_text("last slot"));assert(snapshot().queued_texts==TEXT_QUEUE_CAPACITY+1 && snapshot().session_queued_texts==1);
  assert(stop_capture());busy=false;const int full_starts=starts;
  assert(xiaozhi_stt_start()==ESP_ERR_NO_MEM && starts==full_starts && !snapshot().busy && !strcmp(snapshot().stage,"start.queue_full"));
  assert(xiaozhi_stt_ack(pending.id) && snapshot().session_queued_texts==1);
  assert(xiaozhi_stt_start()==ESP_OK && !snapshot().session_queued_texts && snapshot().queued_texts==TEXT_QUEUE_CAPACITY);
  assert(enqueue_text("cancelled current"));assert(xiaozhi_stt_cancel());busy=false;
  assert(!prior_texts_remaining && !snapshot().queued_texts && !snapshot().session_queued_texts && snapshot().acked_texts==0);
  // Delivery diagnostics separate empty recognition, offline route, timeout and
  // engine failure, preserving an existing first error even if its code is zero.
  assert(xiaozhi_stt_start()==ESP_OK);assert(stop_capture());busy=false;
  xiaozhi_stt_delivery_result(false,false);assert(!strcmp(snapshot().stage,"delivery.no_text"));
  assert(xiaozhi_stt_start()==ESP_OK);assert(enqueue_text("offline"));assert(stop_capture());busy=false;
  xiaozhi_stt_delivery_result(false,false);assert(!strcmp(snapshot().stage,"delivery.offline") && snapshot().error==ESP_ERR_INVALID_STATE);
  assert(xiaozhi_stt_start()==ESP_OK);assert(enqueue_text("engine failed"));
  assert(xiaozhi_stt_ack(pending.id) && xiaozhi_stt_ack(pending.id));assert(stop_capture());busy=false;
  xiaozhi_stt_delivery_result(false,true);assert(!strcmp(snapshot().stage,"delivery.engine_failed"));
  assert(xiaozhi_stt_start()==ESP_OK);log_failure("ws.connection_lost",0);assert(stop_capture());busy=false;
  xiaozhi_stt_delivery_result(false,true);xiaozhi_stt_delivery_result(true,true);
  assert(!strcmp(snapshot().stage,"ws.connection_lost") && snapshot().error==0);
  assert(!guard_depth && !microphone_depth && !critical_depth);
  puts("STT diagnostic lifecycle passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir,
      join(root, 'lifecycle.c'), join(sourceDir, 'stt_stream.c'), '-o', join(root, 'lifecycle')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'lifecycle'), { encoding: 'utf8' })).toContain('STT diagnostic lifecycle passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('runs ordered conversation TTS, PCM decode and microphone resume only after local playback drains', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-dialogue-turns-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp('static [^\\n]+[ *]' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error('Missing dialogue function ' + name)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const codecTypeStart = source.indexOf('typedef enum {\n    CODEC_ENCODER_OPEN')
    const codecTypeEnd = source.indexOf('} codec_job_t;') + '} codec_job_t;'.length
    const codecTypes = source.slice(codecTypeStart, codecTypeEnd)
    const typeEnd = source.indexOf('} dialogue_t;') + '} dialogue_t;'.length
    const type = source.slice(source.lastIndexOf('typedef struct {', typeEnd), typeEnd)
    writeFileSync(join(root, 'turns.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "stt_stream.h"
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_NOT_SUPPORTED 0x106
#define ESP_ERR_TIMEOUT 0x107
#define ESP_ERR_INVALID_RESPONSE 0x108
#define ESP_ERR_NO_MEM 0x101
#define ESP_AUDIO_ERR_OK 0
#define AUDIO_SAMPLE_RATE 16000
#define DECODED_PCM_BYTES (AUDIO_SAMPLE_RATE * 120 / 1000 * sizeof(int16_t))
#define DIALOGUE_REPLY_TIMEOUT_US 90000000LL
#define STT_JSON_BYTES 16384
#define portMAX_DELAY 0
#define pdMS_TO_TICKS(n) (n)
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef int esp_err_t;
typedef int esp_audio_err_t;
typedef void *esp_websocket_client_handle_t;
typedef struct { uint8_t *buffer; size_t len, consumed; } esp_audio_dec_in_raw_t;
typedef struct { uint8_t *buffer; size_t len, decoded_size; } esp_audio_dec_out_frame_t;
typedef struct { int sample_rate, channel, bits_per_sample; } esp_audio_dec_info_t;
typedef struct { char json[STT_JSON_BYTES]; size_t length; bool binary; } incoming_t;
typedef struct { bool speaker_playing, voice_completed; int speaker_error; } audio_snapshot_t;
typedef struct cJSON { const char *valuestring; double valuedouble; bool number; struct cJSON *type, *state, *params, *format, *rate, *channels, *duration; } cJSON;
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *j,const char *key) {
  if(!j)return NULL;
  if(!strcmp(key,"type"))return j->type;if(!strcmp(key,"state"))return j->state;
  if(!strcmp(key,"audio_params"))return j->params;if(!strcmp(key,"format"))return j->format;
  if(!strcmp(key,"sample_rate"))return j->rate;if(!strcmp(key,"channels"))return j->channels;
  if(!strcmp(key,"frame_duration"))return j->duration;return NULL;
}
static bool cJSON_IsString(const cJSON *j) { return j && j->valuestring; }
static bool cJSON_IsNumber(const cJSON *j) { return j && j->number; }
${type}
${codecTypes}
static int guard=1, microphone_guard=2, capture_lock;
static bool busy=true, cancelled, stop_intent, capturing=true, transport_failed;
static int capture_stops, capture_starts, pcm_starts, pcm_finishes, pcm_writes, decoder_resets, send_starts;
static int start_result, finish_result, write_result, decode_result, bad_decode, partial_decode;
static int stop_calls, guard_depth, microphone_depth;
static int64_t clock_us=1000000;
static char stage[40], failed_stage[40];
static uint8_t pcm_storage[128];
static stt_stream_t stream;
static audio_snapshot_t audio;
static int16_t decoded[DECODED_PCM_BYTES/sizeof(int16_t)];
static void log_failure(const char *s,int e) { (void)e;snprintf(failed_stage,sizeof failed_stage,"%s",s); }
static void set_stage(const char *s) { snprintf(stage,sizeof stage,"%s",s); }
static bool is_cancelled(void) { return cancelled; }
static bool stream_failed(void) { return transport_failed; }
static int64_t esp_timer_get_time(void) { return clock_us; }
static void vTaskDelay(int ms) { clock_us+=(int64_t)ms*1000; }
static void xSemaphoreTake(int h,int wait) { (void)wait;int *d=h==guard?&guard_depth:&microphone_depth;assert(!*d);(*d)++; }
static void xSemaphoreGive(int h) { int *d=h==guard?&guard_depth:&microphone_depth;assert(*d==1);(*d)--; }
static void sink(const uint8_t *p,size_t n) { (void)p;(void)n; }
static bool stop_capture(void) { capture_stops++;capturing=false;return true; }
static int audio_live_start(void (*callback)(const uint8_t *,size_t)) { assert(callback==sink && microphone_depth==1 && !guard_depth);capture_starts++;return start_result; }
static int audio_pcm_start(void) { assert(!capturing);pcm_starts++;audio=(audio_snapshot_t){.speaker_playing=true};return start_result; }
static int audio_pcm_finish(void) { pcm_finishes++;return finish_result; }
static int audio_pcm_write(const int16_t *samples,size_t frames) { assert(samples==decoded && frames==4);pcm_writes++;return write_result; }
static esp_audio_err_t codec_call(codec_job_t *job) {
  assert(job->handle==(void *)1);
  if(job->operation==CODEC_DECODER_RESET) { decoder_resets++;return 0; }
  assert(job->operation==CODEC_DECODE);
  esp_audio_dec_in_raw_t *input=job->input;
  esp_audio_dec_out_frame_t *output=job->output;
  esp_audio_dec_info_t *info=job->info;
  assert(input->len==3 && !memcmp(input->buffer,"abc",3));
  assert(output->len==DECODED_PCM_BYTES);
  input->consumed=partial_decode?input->len-1:input->len;output->decoded_size=8;
  *info=(esp_audio_dec_info_t){.sample_rate=bad_decode?24000:AUDIO_SAMPLE_RATE,.channel=1,.bits_per_sample=16};
  return decode_result;
}
static void audio_get_snapshot(audio_snapshot_t *value) { *value=audio; }
static cJSON frame;
static cJSON *listen_frame(const char *session,const char *state) { assert(!strcmp(session,"session") && !strcmp(state,"start"));return &frame; }
static bool send_json(void *ws,cJSON *json) { assert(ws==(void *)2 && json==&frame);send_starts++;return true; }
static void xiaozhi_dialogue_stop(void) { stop_calls++;cancelled=true;capturing=false;audio.speaker_playing=false; }
${['dialogue_audio_params', 'dialogue_pause_capture', 'dialogue_resume_capture', 'dialogue_receive_json', 'dialogue_receive_audio', 'dialogue_next_turn'].map(extract).join('\n')}
static bool event(dialogue_t *d,const char *kind,const char *value) {
  cJSON t={.valuestring=kind},v={.valuestring=value},j={.type=&t,.state=value?&v:NULL};
  return dialogue_receive_json(d,&j);
}
static void reset(dialogue_t *d) {
  *d=(dialogue_t){.decoder=(void *)1,.decoded=decoded};
  busy=capturing=true;cancelled=stop_intent=transport_failed=false;
  capture_stops=capture_starts=pcm_starts=pcm_finishes=pcm_writes=decoder_resets=send_starts=stop_calls=0;
  start_result=finish_result=write_result=decode_result=bad_decode=partial_decode=0;
  audio=(audio_snapshot_t){0};stage[0]=failed_stage[0]=0;
  stt_stream_init(&stream,pcm_storage,sizeof pcm_storage);
  assert(stt_stream_write(&stream,(const uint8_t *)"stale tail",10));
}
int main(void) {
  dialogue_t d;reset(&d);
  cJSON opus={.valuestring="opus"},rate={.number=true,.valuedouble=24000};
  cJSON channels={.number=true,.valuedouble=1},duration={.number=true,.valuedouble=60};
  cJSON params={.format=&opus,.rate=&rate,.channels=&channels,.duration=&duration},hello={.params=&params};
  assert(dialogue_audio_params(&hello));
  rate.valuedouble=48000;assert(dialogue_audio_params(&hello));
  channels.valuedouble=2;assert(!dialogue_audio_params(&hello));channels.valuedouble=1;
  rate.valuedouble=44100;assert(!dialogue_audio_params(&hello));
  assert(dialogue_audio_params(NULL));
  // STT ends the speaking turn without enqueuing any durable transcript.
  assert(event(&d,"stt",NULL) && d.awaiting_reply && !capturing && !stream.size);
  assert(!strcmp(stage,"thinking") && capture_stops==1);
  assert(event(&d,"stt",NULL) && capture_stops==1);
  assert(event(&d,"tts","start") && d.replying && !d.awaiting_reply);
  assert(pcm_starts==1 && decoder_resets==1 && !capturing);
  incoming_t packet={.length=3,.binary=true};memcpy(packet.json,"abc",3);
  assert(dialogue_receive_audio(&d,&packet,1) && pcm_writes==1);
  assert(event(&d,"tts","stop") && d.tts_stopped && pcm_finishes==1);
  assert(dialogue_next_turn(&d,(void *)2,"session") && !capturing && send_starts==0);
  // Server EOF is insufficient until queued audio and DMA both finish.
  audio.speaker_playing=false;audio.voice_completed=true;
  assert(dialogue_next_turn(&d,(void *)2,"session") && capturing && !d.replying && send_starts==1 && capture_starts==1);
  assert(dialogue_next_turn(&d,(void *)2,"session") && send_starts==1);
  assert(!dialogue_receive_audio(&d,&packet,1));
  // TTS may arrive before STT, but duplicate starts and stop-before-start are rejected.
  reset(&d);assert(event(&d,"tts","start"));assert(!event(&d,"tts","start"));
  reset(&d);assert(!event(&d,"tts","stop"));assert(!event(&d,"tts",NULL));
  reset(&d);assert(event(&d,"tts","start"));assert(event(&d,"tts","stop"));assert(!event(&d,"tts","stop"));
  // The same packet decodes through protocol 2/3 framing; malformed sizes fail.
  reset(&d);assert(event(&d,"tts","start"));
  memset(&packet,0,sizeof packet);packet.length=19;packet.json[1]=2;packet.json[15]=3;memcpy(packet.json+16,"abc",3);
  assert(dialogue_receive_audio(&d,&packet,2));packet.json[15]=4;assert(!dialogue_receive_audio(&d,&packet,2));
  memset(&packet,0,sizeof packet);packet.length=7;packet.json[3]=3;memcpy(packet.json+4,"abc",3);
  assert(dialogue_receive_audio(&d,&packet,3));packet.json[0]=1;assert(!dialogue_receive_audio(&d,&packet,3));
  packet.json[0]=0;partial_decode=1;assert(!dialogue_receive_audio(&d,&packet,3));partial_decode=0;
  bad_decode=1;assert(!dialogue_receive_audio(&d,&packet,3));bad_decode=0;
  decode_result=-1;assert(!dialogue_receive_audio(&d,&packet,3));decode_result=0;
  // Full PCM buffers have bounded backpressure, never an endless retry loop.
  write_result=ESP_ERR_NO_MEM;const int64_t before=clock_us;
  assert(!dialogue_receive_audio(&d,&packet,3) && clock_us-before==500000);
  cancelled=true;const int writes=pcm_writes;assert(!dialogue_receive_audio(&d,&packet,3) && pcm_writes==writes);
  // Connection cancellation may never resume the microphone after a completed reply.
  reset(&d);assert(event(&d,"tts","start"));assert(event(&d,"tts","stop"));
  audio=(audio_snapshot_t){.voice_completed=true};cancelled=true;
  assert(!dialogue_next_turn(&d,(void *)2,"session") && !capturing && !capture_starts);
  reset(&d);assert(event(&d,"stt",NULL));clock_us+=DIALOGUE_REPLY_TIMEOUT_US+1;
  assert(!dialogue_next_turn(&d,(void *)2,"session") && !strcmp(failed_stage,"dialogue.reply_timeout"));
  reset(&d);assert(event(&d,"tts","start"));audio.speaker_error=-1;
  assert(!dialogue_next_turn(&d,(void *)2,"session"));
  reset(&d);assert(event(&d,"goodbye",NULL) && stop_calls==1 && cancelled);assert(!event(&d,"error",NULL));
  assert(!guard_depth && !microphone_depth);
  puts("ordered dialogue audio and automatic turns passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', sourceDir, join(root, 'turns.c'), join(sourceDir, 'stt_stream.c'), '-o', join(root, 'turns')])
    expect(execFileSync(join(root, 'turns'), { encoding: 'utf8' })).toContain('ordered dialogue audio and automatic turns passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('dispatches all codec operations to the dedicated task and preserves borrowed job lifetime through completion', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-codec-dispatch-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp('static [^\\n]+[ *]' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error('Missing codec function ' + name)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const codecTypeStart = source.indexOf('typedef enum {\n    CODEC_ENCODER_OPEN')
    const codecTypeEnd = source.indexOf('} codec_job_t;') + '} codec_job_t;'.length
    const codecTypes = source.slice(codecTypeStart, codecTypeEnd)
    const stackDefinition = source.match(/^#define CODEC_STACK_BYTES .+$/m)?.[0]
    if (!stackDefinition) throw new Error('Missing codec stack configuration')
    writeFileSync(join(root, 'dispatch.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <setjmp.h>
#define ESP_AUDIO_ERR_OK 0
#define ESP_AUDIO_ERR_FAIL -1
#define ESP_AUDIO_ERR_INVALID_PARAMETER -2
#define ESP_ERR_NO_MEM 0x101
#define pdTRUE 1
#define pdPASS 1
#define portMAX_DELAY -1
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
${stackDefinition}
typedef int esp_audio_err_t;
${codecTypes}
static void *codec_worker, *codec_requests, *codec_done;
static void (*created_task)(void *);
static codec_job_t *borrowed_job, *executing_job;
static int failure_stage, create_queue_calls, create_semaphore_calls, create_task_calls;
static int delete_queue_calls, delete_semaphore_calls, delete_task_calls;
static int submit_calls, sdk_calls, gives, waits, early_wakes, sdk_result;
static bool in_codec_task, completed, submit_fails;
static char failure[40];
static jmp_buf scheduler_return;
static void *const encoder=(void *)11;
static void *const decoder=(void *)12;
static unsigned char configuration[16], input_data[16], encoded_data[16], decoded_data[16];
static int input_size, output_size, decoder_info;
static void *opened_handle;
static void log_failure(const char *stage,int error) { assert(error==ESP_ERR_NO_MEM);snprintf(failure,sizeof failure,"%s",stage); }
static void *xQueueCreate(unsigned depth,size_t item_size) { create_queue_calls++;assert(depth==1 && item_size==sizeof(codec_job_t *));return failure_stage==1?NULL:(void *)1; }
static void *xSemaphoreCreateBinary(void) { create_semaphore_calls++;return failure_stage==2?NULL:(void *)2; }
static int xTaskCreateWithCaps(void (*task)(void *),const char *name,unsigned stack_bytes,void *arg,unsigned priority,void **handle,unsigned caps) {
  create_task_calls++;assert(!strcmp(name,"xiaozhi_codec") && stack_bytes==48*1024 && !arg && priority==4);
  assert(caps==(MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(failure_stage==3)return 0;*handle=(void *)3;created_task=task;return pdPASS;
}
static void vTaskDeleteWithCaps(void *task) { assert(task==(void *)3);delete_task_calls++; }
static void vQueueDelete(void *queue) { assert(queue==(void *)1);delete_queue_calls++; }
static void vSemaphoreDelete(void *semaphore) { assert(semaphore==(void *)2);delete_semaphore_calls++; }
static int xQueueSend(void *queue,const void *item,int wait) {
  assert(!in_codec_task && queue==codec_requests && wait==portMAX_DELAY && !borrowed_job);
  submit_calls++;if(submit_fails)return 0;borrowed_job=*(codec_job_t *const *)item;
  assert(borrowed_job->result==ESP_AUDIO_ERR_FAIL);completed=false;return pdTRUE;
}
static int xQueueReceive(void *queue,void *item,int wait) {
  assert(in_codec_task && queue==codec_requests && wait==portMAX_DELAY);
  if(!borrowed_job)longjmp(scheduler_return,1);
  executing_job=borrowed_job;*(codec_job_t **)item=borrowed_job;return pdTRUE;
}
static void xSemaphoreGive(void *semaphore) {
  assert(in_codec_task && semaphore==codec_done && executing_job==borrowed_job);
  assert(executing_job->result==sdk_result || executing_job->operation==CODEC_ENCODER_CLOSE || executing_job->operation==(codec_operation_t)99);
  completed=true;gives++;borrowed_job=NULL;executing_job=NULL;
}
static int xSemaphoreTake(void *semaphore,int wait) {
  assert(!in_codec_task && semaphore==codec_done && wait==portMAX_DELAY);waits++;
  if(early_wakes) { early_wakes--;assert(borrowed_job && !completed);return 0; }
  assert(borrowed_job && !completed && created_task);
  in_codec_task=true;
  if(!setjmp(scheduler_return))created_task(NULL);
  in_codec_task=false;assert(completed && !borrowed_job && !executing_job);return pdTRUE;
}
static void check_sdk(codec_operation_t operation) {
  assert(in_codec_task && executing_job && executing_job->operation==operation);
  assert(!completed);sdk_calls++;
}
static int esp_opus_enc_open(void *config,uint32_t size,void **handle) { check_sdk(CODEC_ENCODER_OPEN);assert(config==configuration && size==sizeof configuration && handle==&opened_handle);*handle=encoder;return sdk_result; }
static int esp_opus_enc_get_frame_size(void *handle,int *in,int *out) { check_sdk(CODEC_ENCODER_SIZE);assert(handle==encoder && in==&input_size && out==&output_size);*in=1920;*out=400;return sdk_result; }
static int esp_opus_enc_process(void *handle,void *in,void *out) { check_sdk(CODEC_ENCODE);assert(handle==encoder && in==input_data && out==encoded_data);encoded_data[0]=42;return sdk_result; }
static void esp_opus_enc_close(void *handle) { check_sdk(CODEC_ENCODER_CLOSE);assert(handle==encoder); }
static int esp_opus_dec_open(void *config,uint32_t size,void **handle) { check_sdk(CODEC_DECODER_OPEN);assert(config==configuration && size==sizeof configuration && handle==&opened_handle);*handle=decoder;return sdk_result; }
static int esp_opus_dec_reset(void *handle) { check_sdk(CODEC_DECODER_RESET);assert(handle==decoder);return sdk_result; }
static int esp_opus_dec_decode(void *handle,void *in,void *out,void *info) { check_sdk(CODEC_DECODE);assert(handle==decoder && in==encoded_data && out==decoded_data && info==&decoder_info);decoded_data[0]=17;decoder_info=16000;return sdk_result; }
static int esp_opus_dec_close(void *handle) { check_sdk(CODEC_DECODER_CLOSE);assert(handle==decoder);return sdk_result; }
${['codec_execute', 'codec_run', 'codec_call', 'codec_deinit', 'codec_init'].map(extract).join('\n')}
static void reset(void) {
  assert(!codec_worker && !codec_requests && !codec_done);
  failure_stage=create_queue_calls=create_semaphore_calls=create_task_calls=0;
  delete_queue_calls=delete_semaphore_calls=delete_task_calls=0;
  submit_calls=sdk_calls=gives=waits=early_wakes=sdk_result=0;
  in_codec_task=completed=submit_fails=false;failure[0]=0;borrowed_job=executing_job=NULL;created_task=NULL;
}
int main(void) {
  codec_job_t job={.operation=CODEC_ENCODE,.handle=encoder,.input=input_data,.output=encoded_data};
  // Resource absence and queue submission failure return safely without SDK calls.
  reset();assert(codec_call(&job)==ESP_AUDIO_ERR_FAIL && !submit_calls && !sdk_calls);
  for(int stage=1;stage<=3;stage++) {
    reset();failure_stage=stage;assert(!codec_init());
    assert(!codec_worker && !codec_requests && !codec_done && !strcmp(failure,"init.codec_worker"));
    assert(delete_queue_calls==(stage!=1) && delete_semaphore_calls==(stage!=2) && !delete_task_calls);
    assert(create_task_calls==(stage==3));
    assert(codec_call(&job)==ESP_AUDIO_ERR_FAIL && !submit_calls && !sdk_calls);
  }
  reset();assert(codec_init());assert(create_queue_calls==1 && create_semaphore_calls==1 && create_task_calls==1);
  submit_fails=true;assert(codec_call(&job)==ESP_AUDIO_ERR_FAIL && !sdk_calls && !gives && !waits);
  submit_fails=false;
  // Callers retain stack-owned arguments through a transient wake and completion.
  early_wakes=1;assert(codec_call(&job)==ESP_AUDIO_ERR_OK && encoded_data[0]==42);
  assert(waits==2 && sdk_calls==1 && gives==1 && !borrowed_job);
  job=(codec_job_t){.operation=CODEC_ENCODER_OPEN,.input=configuration,.config_size=sizeof configuration,.output=&opened_handle};
  assert(codec_call(&job)==ESP_AUDIO_ERR_OK && opened_handle==encoder);
  job=(codec_job_t){.operation=CODEC_ENCODER_SIZE,.handle=encoder,.input=&input_size,.output=&output_size};
  assert(codec_call(&job)==ESP_AUDIO_ERR_OK && input_size==1920 && output_size==400);
  sdk_result=-37;job=(codec_job_t){.operation=CODEC_ENCODER_CLOSE,.handle=encoder};
  assert(codec_call(&job)==ESP_AUDIO_ERR_OK);sdk_result=0;
  job=(codec_job_t){.operation=CODEC_DECODER_OPEN,.input=configuration,.config_size=sizeof configuration,.output=&opened_handle};
  assert(codec_call(&job)==ESP_AUDIO_ERR_OK && opened_handle==decoder);
  job=(codec_job_t){.operation=CODEC_DECODER_RESET,.handle=decoder};assert(codec_call(&job)==ESP_AUDIO_ERR_OK);
  job=(codec_job_t){.operation=CODEC_DECODE,.handle=decoder,.input=encoded_data,.output=decoded_data,.info=&decoder_info};
  assert(codec_call(&job)==ESP_AUDIO_ERR_OK && decoded_data[0]==17 && decoder_info==16000);
  // Codec errors return after completion too, preserving the vendor error code.
  sdk_result=-37;assert(codec_call(&job)==-37 && completed && !borrowed_job);
  job=(codec_job_t){.operation=CODEC_DECODER_CLOSE,.handle=decoder};assert(codec_call(&job)==-37);
  job=(codec_job_t){.operation=(codec_operation_t)99};assert(codec_call(&job)==ESP_AUDIO_ERR_INVALID_PARAMETER);
  assert(sdk_calls==9 && gives==10 && waits==11);
  codec_deinit();assert(!codec_worker && !codec_requests && !codec_done);
  assert(delete_task_calls==1 && delete_queue_calls==1 && delete_semaphore_calls==1);
  assert(codec_call(&job)==ESP_AUDIO_ERR_FAIL);
  puts("codec task dispatch, completion and initialization checks passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'dispatch.c'), '-o', join(root, 'dispatch')])
    expect(execFileSync(join(root, 'dispatch'), { encoding: 'utf8' })).toContain('codec task dispatch, completion and initialization checks passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('keeps one continuous transcription session through multiple utterances and the complete final drain window', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-session-'))
  try {
    const sourceDir = resolve('firmware/easyinput-monitor/main')
    const source = readFileSync(join(sourceDir, 'xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp('static [^\\n]+[ *]' + name + '\\([^;]*?\\)\\n\\{'))
      if (start < 0) throw new Error('Missing session function ' + name)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\n#define ESP_OK 0\n')
    const prelude = String.raw`
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "xiaozhi_stt.h"
#include "stt_stream.h"
#define STT_JSON_BYTES 16384
#define TEXT_BATCH_MAX 17
#define VOICE_SILENCE_US 60000000LL
#define VOICE_SESSION_US 3600000000LL
#define AUDIO_SAMPLE_RATE 16000
#define DECODED_PCM_BYTES 3840
#define CODEC_STACK_BYTES 49152
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_NOT_SUPPORTED 0x106
#define ESP_ERR_TIMEOUT 0x107
#define ESP_ERR_INVALID_RESPONSE 0x108
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_AUDIO_ERR_OK 0
#define ESP_OPUS_DEC_FRAME_DURATION_120_MS 120
#define ESP_OPUS_ENC_FRAME_DURATION_60_MS 60
#define ESP_OPUS_DEC_CONFIG_DEFAULT() ((esp_opus_dec_cfg_t){0})
#define ESP_OPUS_ENC_CONFIG_DEFAULT() ((esp_opus_enc_config_t){0})
#define WEBSOCKET_EVENT_ANY -1
#define pdTRUE 1
#define portMAX_DELAY 0
#define pdMS_TO_TICKS(n) (n)
#define esp_crt_bundle_attach NULL
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
#define ESP_LOGI(tag, ...) test_log(__VA_ARGS__)
typedef int esp_audio_err_t;
typedef void *esp_websocket_client_handle_t;
typedef struct { const char *uri; void *crt_bundle_attach; bool disable_auto_reconnect; int network_timeout_ms, buffer_size, task_stack; } esp_websocket_client_config_t;
typedef struct { int sample_rate, channel, frame_duration; } esp_opus_dec_cfg_t;
typedef struct { int sample_rate, channel, bitrate, frame_duration; } esp_opus_enc_config_t;
typedef struct { uint8_t *buffer; size_t len; } esp_audio_enc_in_frame_t;
typedef struct { uint8_t *buffer; size_t len; unsigned encoded_bytes; } esp_audio_enc_out_frame_t;
typedef enum { CODEC_ENCODER_OPEN, CODEC_ENCODER_SIZE, CODEC_ENCODE, CODEC_ENCODER_CLOSE, CODEC_DECODER_OPEN, CODEC_DECODER_RESET, CODEC_DECODE, CODEC_DECODER_CLOSE } codec_operation_t;
typedef struct { codec_operation_t operation; void *handle, *input, *output, *info; uint32_t config_size; esp_audio_err_t result; } codec_job_t;
typedef struct cJSON { const char *valuestring; int valueint; bool number; struct cJSON *children[12]; const char *keys[12]; size_t count; } cJSON;
typedef struct { char json[STT_JSON_BYTES]; size_t length; bool binary; } incoming_t;
typedef struct { size_t offset, length; } text_slice_t;
typedef struct { void *decoder; int16_t *decoded; bool awaiting_reply, replying, tts_stopped; int64_t activity_at; } dialogue_t;
typedef struct { bool vad; int microphone_error; } audio_snapshot_t;
static stt_stream_t stream;
static uint8_t pcm[8192];
static stt_snapshot_t diagnostics;
static int capture_lock, incoming=1, microphone_guard=2, codec_worker=3;
static bool dialogue_session, connected, heard=true, connection_failure;
static int64_t clock_us, stop_at, stop_sent_at, loop_deadline;
static unsigned automatic_stops;
static unsigned listen_starts, listen_stops, aborts, binary_frames, speaker_calls, cleanup_calls;
static const char *device="test-device", *client="test-client";
static size_t ws_used, ws_expected, ws_frame_start;
static bool ws_accepting, ws_binary;
static size_t script_head, script_count;
static const struct { int64_t at; const char *key; } script[] = {
  {100000,"first"}, {200000,"tts"}, {300000,"llm"}, {500000,"second"},
  {19000000,"last"}, {21010000,"too-late"},
};
static char rows[8][40];
static unsigned row_count;
static void test_log(const char *format,...) { (void)format; }
static unsigned uxTaskGetStackHighWaterMark(int task) { assert(task==codec_worker);return CODEC_STACK_BYTES; }
static int64_t esp_timer_get_time(void) { return clock_us; }
static void set_stage(const char *stage) { (void)stage; }
static void log_failure(const char *stage,int code) { (void)stage;(void)code; }
static void *psram_alloc(size_t size,const char *stage) { (void)stage;return malloc(size); }
static bool is_cancelled(void) { return false; }
static bool stream_failed(void) { return false; }
static bool capacity_exhausted(void) { return false; }
static bool is_stopping(void) { return clock_us>=stop_at; }
static bool capture_running(void) { return !is_stopping(); }
void xiaozhi_stt_stop(void) {
  assert(!is_stopping()); automatic_stops++; stop_at=clock_us;
  const uint8_t tail[2]={1,2}; assert(stt_stream_write(&stream,tail,sizeof tail));
}
void xiaozhi_dialogue_stop(void) { assert(!"transcription must not cancel dialogue"); }
static bool stop_capture(void) { cleanup_calls++;return true; }
static void xSemaphoreTake(int h,int wait) { (void)h;(void)wait; }
static void xSemaphoreGive(int h) { (void)h; }
static int audio_stop_speaker(void) { speaker_calls++;return ESP_OK; }
static void audio_get_snapshot(audio_snapshot_t *audio) { *audio=(audio_snapshot_t){.vad=heard}; }
static bool microphone_healthy(const audio_snapshot_t *audio) { (void)audio;return true; }
static void vTaskDelay(int ticks) {
  const int64_t next=clock_us+(int64_t)ticks*1000;
  if(clock_us<stop_at) {
    const size_t length=(size_t)((next<stop_at?next:stop_at)-clock_us)*32/1000;
    uint8_t samples[1600]={0};assert(length<=sizeof(samples));
    assert(stt_stream_write(&stream,samples,length));
  }
  clock_us=next;assert(clock_us<loop_deadline);
}
#undef strlcpy
#define strlcpy stt_session_strlcpy
static size_t strlcpy(char *dst,const char *src,size_t n) { size_t size=strlen(src);if(n) { size_t used=size<n-1?size:n-1;memcpy(dst,src,used);dst[used]=0; }return size; }
static cJSON *cJSON_CreateObject(void) { cJSON *node=calloc(1,sizeof(*node));assert(node);return node; }
static cJSON *add(cJSON *object,const char *key) { assert(object->count<12);cJSON *child=cJSON_CreateObject();object->keys[object->count]=key;object->children[object->count++]=child;return child; }
static void cJSON_AddStringToObject(cJSON *object,const char *key,const char *value) { add(object,key)->valuestring=value; }
static void cJSON_AddNumberToObject(cJSON *object,const char *key,int value) { cJSON *node=add(object,key);node->number=true;node->valueint=value; }
static cJSON *cJSON_AddObjectToObject(cJSON *object,const char *key) { return add(object,key); }
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *object,const char *key) { if(object)for(size_t i=0;i<object->count;i++)if(!strcmp(object->keys[i],key))return object->children[i];return NULL; }
static bool cJSON_IsString(const cJSON *node) { return node && node->valuestring; }
static bool cJSON_IsNumber(const cJSON *node) { return node && node->number; }
static void cJSON_Delete(cJSON *object) { if(object) { for(size_t i=0;i<object->count;i++)cJSON_Delete(object->children[i]);free(object); } }
static cJSON *cJSON_Parse(const char *key) {
  cJSON *event=cJSON_CreateObject();
  const char *type=!strcmp(key,"tts")?"tts":!strcmp(key,"llm")?"llm":"stt";
  cJSON_AddStringToObject(event,"type",type);
  cJSON_AddStringToObject(event,"text",!strcmp(type,"stt")?script[script_head-1].key:"assistant text");
  cJSON_AddStringToObject(event,"state","stop");return event;
}
static int text_slices(const char *text,text_slice_t slices[TEXT_BATCH_MAX]) { slices[0]=(text_slice_t){.length=strlen(text)};return text[0]?1:0; }
static bool enqueue_text(const char *text) { assert(row_count<8);strlcpy(rows[row_count++],text,sizeof(rows[0]));return true; }
static void ws_event(void) {}
static esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t *config) { assert(!strcmp(config->uri,"wss://synthetic"));return (void *)1; }
static void esp_websocket_client_append_header(void *ws,const char *key,const char *value) { assert(ws);(void)key;(void)value; }
static void xQueueReset(int q) { assert(q==incoming); }
static void esp_websocket_register_events(void *ws,int any,void (*callback)(void),void *arg) { assert(ws && any==WEBSOCKET_EVENT_ANY && callback==ws_event && !arg); }
static int esp_websocket_client_start(void *ws) { assert(ws);connected=true;return ESP_OK; }
static bool esp_websocket_client_is_connected(void *ws) { assert(ws);return connected && !(connection_failure && clock_us>=700000); }
static bool send_json(void *ws,cJSON *json) {
  assert(ws);const cJSON *type=cJSON_GetObjectItemCaseSensitive(json,"type");assert(cJSON_IsString(type));
  if(!strcmp(type->valuestring,"listen")) {
    const cJSON *state=cJSON_GetObjectItemCaseSensitive(json,"state");assert(cJSON_IsString(state));
    if(!strcmp(state->valuestring,"start")) { const cJSON *mode=cJSON_GetObjectItemCaseSensitive(json,"mode");assert(cJSON_IsString(mode) && !strcmp(mode->valuestring,"realtime"));listen_starts++; }
    else { assert(!strcmp(state->valuestring,"stop"));listen_stops++;stop_sent_at=clock_us; }
  } else if(!strcmp(type->valuestring,"abort"))aborts++;
  else assert(!strcmp(type->valuestring,"hello"));
  cJSON_Delete(json);return true;
}
static cJSON *wait_type(const char *type,int wait) { assert(!strcmp(type,"hello") && wait==10000);cJSON *hello=cJSON_CreateObject();cJSON_AddStringToObject(hello,"session_id","synthetic-session");cJSON_AddStringToObject(hello,"transport","websocket");return hello; }
static int codec_call(codec_job_t *job) {
  switch(job->operation) {
    case CODEC_ENCODER_OPEN: *(void **)job->output=(void *)2;break;
    case CODEC_ENCODER_SIZE: *(int *)job->input=1920;*(int *)job->output=4000;break;
    case CODEC_ENCODE: { esp_audio_enc_out_frame_t *out=job->output;out->encoded_bytes=8;memset(out->buffer,0,8);break; }
    case CODEC_ENCODER_CLOSE: break;
    default: assert(!"transcription must never open/decode assistant audio");
  }
  return ESP_AUDIO_ERR_OK;
}
static int esp_websocket_client_send_bin(void *ws,const char *data,int bytes,int wait) { assert(ws && data && bytes==8 && wait==3000);binary_frames++;return bytes; }
static void esp_websocket_client_stop(void *ws) { assert(ws);connected=false; }
static void esp_websocket_client_destroy(void *ws) { assert(ws); }
static int xQueueReceive(int q,incoming_t *event,int wait) {
  assert(q==incoming && !wait);if(script_head>=script_count || script[script_head].at>clock_us)return 0;
  strlcpy(event->json,script[script_head++].key,sizeof(event->json));event->binary=false;return pdTRUE;
}
static bool dialogue_audio_params(const cJSON *params) { (void)params;assert(!"dialogue only");return false; }
static bool dialogue_resume_capture(void) { assert(!"dialogue only");return false; }
static bool dialogue_receive_audio(dialogue_t *state,incoming_t *event,int protocol) { (void)state;(void)event;(void)protocol;assert(!"dialogue only");return false; }
static bool dialogue_receive_json(dialogue_t *state,const cJSON *json) { (void)state;(void)json;assert(!"dialogue only");return false; }
static bool dialogue_next_turn(dialogue_t *state,void *ws,const char *session) { (void)state;(void)ws;(void)session;assert(!"dialogue only");return false; }
`
    const main = String.raw`
static void reset(void) {
  memset(&diagnostics,0,sizeof(diagnostics));stt_stream_init(&stream,pcm,sizeof(pcm));
  automatic_stops=0;loop_deadline=22000000;
  clock_us=0;stop_at=1000000;stop_sent_at=0;script_head=0;script_count=6;
  listen_starts=listen_stops=aborts=binary_frames=speaker_calls=cleanup_calls=row_count=0;
  connected=connection_failure=false;heard=true;
}
int main(void) {
  cJSON *provisioning=cJSON_CreateObject();cJSON *config=cJSON_AddObjectToObject(provisioning,"websocket");
  cJSON_AddStringToObject(config,"url","wss://synthetic");cJSON_AddNumberToObject(config,"version",1);
  reset();assert(transcribe(provisioning)==STT_FINISHED);
  assert(clock_us==21000000 && stop_sent_at==1000000 && script_head==5);
  assert(listen_starts==1 && listen_stops==1 && aborts==1 && binary_frames>=16);
  assert(row_count==3 && !strcmp(rows[0],"first") && !strcmp(rows[1],"second") && !strcmp(rows[2],"last"));
  assert(stream.consumed==stream.accepted && diagnostics.sent_bytes==stream.accepted);
  assert(!speaker_calls && cleanup_calls==1);
  reset();script_count=0;heard=false;assert(transcribe(provisioning)==STT_EMPTY && !row_count);
  reset();script_count=0;assert(transcribe(provisioning)==STT_FAILED && !row_count);
  reset();connection_failure=true;assert(transcribe(provisioning)==STT_FAILED);
  assert(row_count==2 && !strcmp(rows[0],"first") && !strcmp(rows[1],"second"));
  assert(!listen_stops && listen_starts==1 && !speaker_calls && cleanup_calls==1);
  // Automatic silence stop still transmits a final partial sample and waits
  // the complete recognition window instead of aborting the transcript.
  reset(); script_count=0; heard=false; stop_at=INT64_MAX; loop_deadline=81000000;
  assert(transcribe(provisioning)==STT_EMPTY);
  assert(automatic_stops==1 && stop_sent_at==VOICE_SILENCE_US && clock_us==VOICE_SILENCE_US+20000000);
  assert(listen_stops==1 && stream.consumed==stream.accepted && stream.accepted%1920==2);
  // Continuous VAD and successful recognition do not extend the one-hour cap.
  reset(); script_count=1; stop_at=INT64_MAX; loop_deadline=VOICE_SESSION_US+21000000;
  assert(transcribe(provisioning)==STT_FINISHED);
  assert(automatic_stops==1 && stop_sent_at==VOICE_SESSION_US && clock_us==VOICE_SESSION_US+20000000);
  assert(row_count==1 && stream.consumed==stream.accepted);
  cJSON_Delete(provisioning);puts("continuous transcription session passed");
}
`
    writeFileSync(join(root, 'session.c'), prelude + '\n' + ['session_limit_reached', 'listen_frame', 'receive_message', 'transcribe'].map(extract).join('\n') + '\n' + main)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I', root, '-I', sourceDir,
      join(root, 'session.c'), join(sourceDir, 'stt_stream.c'), '-o', join(root, 'session')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'session'), { encoding: 'utf8' })).toContain('continuous transcription session passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('bounds silent listening and total session time without counting Xiaozhi thinking or playback as silence', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-session-limit-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/xiaozhi_stt.c'), 'utf8')
    const start = source.indexOf('static bool session_limit_reached(')
    const fn = source.slice(start, source.indexOf('\n}\n', start) + 3)
    const limits = source.match(/^#define VOICE_(?:SILENCE|SESSION)_US .+$/gm)?.join('\n')
    if (start < 0 || !limits) throw new Error('Missing session limits')
    writeFileSync(join(root, 'limits.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
${limits}
${fn}
int main(void) {
  const int64_t started=1000000;
  int64_t last=started;
  assert(!session_limit_reached(started+20000000,started,&last,true,false));
  assert(!session_limit_reached(started+VOICE_SILENCE_US-1,started,&last,true,false));
  assert(session_limit_reached(started+VOICE_SILENCE_US,started,&last,true,false));
  // Speech, including speech just before the boundary, grants a new window.
  last=started;
  const int64_t speech=started+VOICE_SILENCE_US-1;
  assert(!session_limit_reached(speech,started,&last,true,true) && last==speech);
  assert(!session_limit_reached(speech+VOICE_SILENCE_US-1,started,&last,true,false));
  assert(session_limit_reached(speech+VOICE_SILENCE_US,started,&last,true,false));
  // Many turns and a long reply do not prematurely close the next listening turn.
  for(int turn=0;turn<8;turn++) {
    const int64_t reply_end=started+(int64_t)(turn+1)*120000000;
    assert(!session_limit_reached(reply_end,started,&last,false,false) && last==reply_end);
    assert(!session_limit_reached(reply_end+VOICE_SILENCE_US-1,started,&last,true,false));
  }
  // A persistent VAD/noisy room cannot extend the absolute cap, including TTS.
  assert(!session_limit_reached(started+VOICE_SESSION_US-1,started,&last,true,true));
  assert(session_limit_reached(started+VOICE_SESSION_US,started,&last,true,true));
  assert(session_limit_reached(started+VOICE_SESSION_US,started,&last,false,false));
  // A new session starts with independent timestamps.
  const int64_t next=started+VOICE_SESSION_US+1000000; last=next;
  assert(!session_limit_reached(next,next,&last,true,false));
  puts("voice silence and session limits passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'limits.c'), '-o', join(root, 'limits')])
    expect(execFileSync(join(root, 'limits'), { encoding: 'utf8' })).toContain('voice silence and session limits passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
