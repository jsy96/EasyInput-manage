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
#define portMAX_DELAY 0
#define pdTRUE 1
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef const char *esp_event_base_t;
typedef struct { int payload_offset, op_code, payload_len, data_len; bool fin; const char *data_ptr; } esp_websocket_event_data_t;
typedef struct { char json[STT_JSON_BYTES]; } incoming_t;
typedef struct { size_t offset, length; } text_slice_t;
typedef struct { bool microphone_active; int microphone_error; } audio_snapshot_t;
typedef struct cJSON { const char *valuestring; struct cJSON *type, *text; } cJSON;
static const cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *j, const char *key) { return !j ? NULL : !strcmp(key,"type") ? j->type : j->text; }
static bool cJSON_IsString(const cJSON *j) { return j && j->valuestring; }
static int guard=1, microphone_guard=2, capture_lock;
static bool capturing, cancelled, stop_requested, stop_intent, busy, storage_ready = true;
static bool transport_failed, capacity_failed, pending_durable;
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
${['notify', 'stream_error', 'capacity_error', 'capacity_exhausted', 'stream_failed', 'sink', 'microphone_healthy', 'capture_running', 'persist_pending_head', 'ws_event', 'utf8_next', 'unicode_space', 'valid_text', 'text_slices', 'enqueue_text', 'receive_message', 'xiaozhi_stt_ack'].map(extract).join('\n')}
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
  assert(busy && capturing && text_count==2 && !strcmp(pending.text,"第一句"));
  const stt_text_t first=pending, second=text_queue[text_head];
  assert(persist_calls==0 && !pending_durable); // No Flash writes while capturing.
  capturing=false; assert(persist_pending_head() && pending_durable);
  assert(!xiaozhi_stt_ack("wrong-id") && !strcmp(pending.text,"第一句"));
  persist_fail=1; assert(!xiaozhi_stt_ack(first.id));
  assert(text_count==2 && !strcmp(pending.id,first.id) && !strcmp(durable.id,first.id));
  persist_fail=0; assert(xiaozhi_stt_ack(first.id));
  assert(text_count==1 && !strcmp(pending.id,second.id) && !strcmp(durable.id,second.id));
  assert(xiaozhi_stt_ack(pending.id)); assert(!strcmp(pending.text,"第三句") && text_count==0);
  assert(xiaozhi_stt_ack(pending.id) && !pending.id[0] && !durable.id[0]);
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
