import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('runs actual STT text validation and bounded WebSocket assembly against malformed and fragmented input', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-stt-tests-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/xiaozhi_stt.c'), 'utf8')
    const extract = (name: string) => {
      const start = source.search(new RegExp(`static (?:void|bool) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing STT function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define STT_TEXT_BYTES 3001
#define WEBSOCKET_EVENT_DATA 1
#define PCM_BYTES 640000
#define portENTER_CRITICAL(p) ((void)(p))
#define portEXIT_CRITICAL(p) ((void)(p))
typedef const char *esp_event_base_t;
typedef struct { int payload_offset, op_code, payload_len, data_len; bool fin; const char *data_ptr; } esp_websocket_event_data_t;
typedef struct { char json[4096]; } incoming_t;
static char ws_json[4096];
static size_t ws_used, ws_expected, ws_frame_start;
static bool ws_accepting;
static int incoming, queued;
static incoming_t last;
static int capture_lock;
static bool capturing;
static uint8_t data[PCM_BYTES], *pcm = data;
static size_t pcm_length;
#undef strlcpy
#define strlcpy stt_test_strlcpy
static size_t strlcpy(char *dst, const char *src, size_t n) { size_t size = strlen(src); if (n) { size_t used = size < n - 1 ? size : n - 1; memcpy(dst, src, used); dst[used] = 0; } return size; }
static int xQueueSend(int q, const incoming_t *event, int wait) { (void)q; (void)wait; last = *event; queued++; return 1; }
${['valid_text', 'ws_event', 'sink'].map(extract).join('\n')}
static void fragment(int opcode, int total, int offset, const char *p, int n) {
  esp_websocket_event_data_t e = {.op_code=opcode,.payload_len=total,.payload_offset=offset,.data_ptr=p,.data_len=n,.fin=true};
  ws_event(NULL, NULL, WEBSOCKET_EVENT_DATA, &e);
}
int main(void) {
  assert(valid_text("你好，273元"));
  assert(valid_text("\\xf0\\x9f\\x98\\x80"));
  assert(!valid_text(" \\t\\n\\r"));
  assert(!valid_text("\\xe3\\x80\\x80"));
  assert(!valid_text("\\xed\\xa0\\x80"));
  assert(!valid_text("\\xc0\\x80"));
  assert(!valid_text("\\xf4\\x90\\x80\\x80"));
  assert(!valid_text("\\xe4\\xb8"));
  assert(!valid_text("a\\x01"));
  char text[4001];
  for(int i=0;i<1000;i++) memcpy(text+i*3,"字",3);
  text[3000]=0; assert(valid_text(text));
  memset(text,'a',1001); text[1001]=0; assert(!valid_text(text));
  for(int i=0;i<500;i++) memcpy(text+i*4,"\\xf0\\x9f\\x98\\x80",4);
  text[2000]=0; assert(valid_text(text));
  text[2000]='a'; text[2001]=0; assert(!valid_text(text));

  fragment(1, 7, 0, "{\\\"a\\\":", 5); assert(!queued);
  fragment(0, 7, 5, "1}", 2); assert(queued==1 && !strcmp(last.json,"{\\\"a\\\":1}"));
  fragment(2, 7, 0, "{\\\"a\\\":1}", 7); assert(queued==1);
  fragment(1, 4096, 0, "x", 1); assert(queued==1);
  fragment(1, 7, 0, "{", 1);
  fragment(0, 7, 2, "xxxxx", 5); assert(queued==1 && !ws_accepting);
  fragment(1, 7, 0, "{", 1);
  fragment(0, 7, 1, "xxxxxxx", 7); assert(queued==1 && !ws_accepting);
  fragment(1, 2, 0, "{}", 2); assert(queued==2 && !strcmp(last.json,"{}"));
  esp_websocket_event_data_t first = {.op_code=1,.payload_len=5,.data_len=5,.data_ptr="{\\\"a\\\":",.fin=false};
  ws_event(NULL,NULL,WEBSOCKET_EVENT_DATA,&first); assert(queued==2);
  fragment(9, 1, 0, "x", 1); assert(queued==2);
  fragment(0, 2, 0, "1}", 2); assert(queued==3 && !strcmp(last.json,"{\\\"a\\\":1}"));
  capturing=true;
  sink((const uint8_t *)"abc",3); assert(pcm_length==3 && !memcmp(pcm,"abc",3));
  pcm_length=PCM_BYTES-1; sink((const uint8_t *)"xx",2); assert(pcm_length==PCM_BYTES-1);
  capturing=false; sink((const uint8_t *)"x",1); assert(pcm_length==PCM_BYTES-1);
  puts("STT boundaries passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8' })).toContain('STT boundaries passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
