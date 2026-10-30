import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('gates WSS by IP generation, rejects partial sends and bounds audio/control scheduling', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-cloud-tests-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/cloud.c'), 'utf8')
    const header = readFileSync(resolve('firmware/easyinput-monitor/main/cloud.h'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp(`(?:static )?(?:void|bool) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing cloud function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const typeEnd = source.indexOf('} cloud_binary_frame_t;') + '} cloud_binary_frame_t;'.length
    const audioType = source.slice(source.lastIndexOf('typedef struct {', typeEnd), typeEnd)
    const constants = ['CLOUD_BINARY_MAX_AGE_US', 'CLOUD_COMMAND_MAX', 'CLOUD_RECONNECT_MS']
      .map(name => source.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
${header.replace('#pragma once', '')}
${constants}
#define ESP_OK 0
#define pdTRUE 1
#define portMAX_DELAY (-1)
#define pdMS_TO_TICKS(ms) (ms)
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
#define WEBSOCKET_EVENT_ANY (-1)
#define WEBSOCKET_EVENT_CONNECTED 1
#define WEBSOCKET_EVENT_DISCONNECTED 2
#define WEBSOCKET_EVENT_DATA 3
#define WEBSOCKET_EVENT_ERROR 4
typedef int TickType_t;
typedef int esp_event_base_t;
typedef void *esp_websocket_client_handle_t;
typedef struct { int esp_tls_last_esp_err,esp_tls_stack_err,esp_tls_cert_verify_flags,esp_transport_sock_errno,esp_ws_handshake_status_code,error_type; } errors_t;
typedef struct { int close_status_code,op_code,payload_offset,payload_len,data_len; const char *data_ptr; errors_t error_handle; } esp_websocket_event_data_t;
typedef struct { const char *uri; int (*crt_bundle_attach)(void *); int buffer_size,task_stack,network_timeout_ms,reconnect_timeout_ms;bool keep_alive_enable;int keep_alive_idle,keep_alive_interval,keep_alive_count,ping_interval_sec,pingpong_timeout_sec; } esp_websocket_client_config_t;
typedef struct { void *items[64];size_t count; } queue_t;
static queue_t controls,audio_queue;
static queue_t *event_queue=&controls,*binary_queue=&audio_queue;
${audioType}
static int network_lock;
static void *client,*state_lock=(void*)1,*send_lock=(void*)2,*outbound_lock=(void*)3,*lifecycle_lock=(void*)4,*sender_task=(void*)5;
static bool network_ready,online,time_ready=true,ws_connected;
static unsigned network_generation;
static int64_t last_presence_us,connected_since_us,clock_us=1000000;
static cloud_monitor_stats_t monitor_stats;
static char gateway[192]="wss://synthetic.invalid",device_id[65]="test-device",token[129]="synthetic-test-token";
static const char *TAG="test";
static int creates,starts,stops,destroys,text_sends,binary_sends,partial_send;
static void log_msg(const char *tag,const char *fmt,...) { (void)tag;(void)fmt; }
#define ESP_LOGW(...) log_msg(__VA_ARGS__)
#define ESP_LOGI(...) log_msg(__VA_ARGS__)
static int xSemaphoreTake(void *lock,int timeout) { assert(lock);(void)timeout;return pdTRUE; }
static void xSemaphoreGive(void *lock) { assert(lock); }
static int64_t esp_timer_get_time(void) { return clock_us; }
static size_t uxQueueMessagesWaiting(queue_t *q) { return q->count; }
static int xQueueReceive(queue_t *q,void *item,int wait) { assert(wait==0);if(!q->count)return 0;*(void**)item=q->items[0];memmove(q->items,q->items+1,--q->count*sizeof(void*));return pdTRUE; }
static void enqueue(queue_t *q,void *item) { assert(q->count<64);q->items[q->count++]=item; }
static bool configured(void) { return gateway[0] && device_id[0] && token[0]; }
static bool system_time_ready(void) { return time_ready; }
static bool esp_websocket_client_is_connected(void *c) { return c && ws_connected; }
static int esp_websocket_client_send_text(void *c,const char *text,size_t n,int timeout) { assert(c&&text);(void)timeout;text_sends++;return partial_send?(int)n-1:(int)n; }
static int esp_websocket_client_send_bin(void *c,const char *text,size_t n,int timeout) { assert(c&&text);(void)timeout;binary_sends++;return partial_send?(int)n-1:(int)n; }
static int esp_websocket_client_stop(void *c) { assert(c);stops++;ws_connected=false;return ESP_OK; }
static int esp_websocket_client_destroy(void *c) { assert(c);destroys++;return ESP_OK; }
static int esp_crt_bundle_attach(void *conf) { (void)conf;return ESP_OK; }
static void *esp_websocket_client_init(const esp_websocket_client_config_t *config) {
  assert(config->network_timeout_ms==10000 && config->reconnect_timeout_ms==CLOUD_RECONNECT_MS);
  assert(config->keep_alive_enable && config->ping_interval_sec==10 && config->pingpong_timeout_sec==30);
  creates++;return (void*)(uintptr_t)(100+creates);
}
static void (*ws_callback)(void*,esp_event_base_t,int32_t,void*);
static void esp_websocket_register_events(void *c,int any,void (*cb)(void*,esp_event_base_t,int32_t,void*),void *arg) { assert(c&&any==WEBSOCKET_EVENT_ANY&&!arg);ws_callback=cb; }
static int esp_websocket_client_start(void *c) { assert(c);starts++;ws_connected=true;ws_callback(NULL,0,WEBSOCKET_EVENT_CONNECTED,NULL);return ESP_OK; }
static void xTaskNotifyGive(void *task) { assert(task); }
static unsigned heap_caps_get_free_size(int caps) { (void)caps;return 24000; }
static unsigned heap_caps_get_largest_free_block(int caps) { (void)caps;return 14000; }
static void record_drop(const char *line) { assert(line);monitor_stats.dropped++; }
static void cloud_message(const char *data,size_t length) { assert(data);(void)length; }
${['cloud_monitor_set_network_ready','network_is_ready','send_text','send_text_immediate','send_binary','stop_client','cloud_event_handler','update_client_connection','take_outbound','cloud_monitor_is_online'].map(extract).join('\n')}
static cloud_binary_frame_t *packet(int64_t age) {
  cloud_binary_frame_t *p=calloc(1,sizeof(*p)+4);assert(p);p->length=4;p->queued_at_us=clock_us-age;return p;
}
int main(void) {
  // Clock validity alone never opens a socket before DHCP.
  update_client_connection();assert(!creates && !client);
  cloud_monitor_set_network_ready(true);time_ready=false;
  update_client_connection();assert(!creates);
  time_ready=true;update_client_connection();assert(creates==1&&starts==1&&cloud_monitor_is_online());
  const char payload[]="ping";
  assert(send_text(payload,4,1) && send_binary((const uint8_t*)payload,4,1));
  partial_send=1;assert(!send_text(payload,4,1)&&!send_text_immediate(payload,4)&&!send_binary((const uint8_t*)payload,4,1));partial_send=0;
  cloud_monitor_set_network_ready(false);assert(!cloud_monitor_is_online());
  int sends=text_sends;assert(!send_text(payload,4,1)&&text_sends==sends);
  // A loss/recovery wholly between worker ticks still discards the old socket.
  cloud_monitor_set_network_ready(true);update_client_connection();assert(stops==1&&destroys==1&&creates==2);
  cloud_monitor_set_network_ready(false);update_client_connection();assert(!client&&stops==2&&creates==2);
  cloud_monitor_set_network_ready(true);update_client_connection();assert(creates==3&&online);
  esp_websocket_event_data_t error={.error_handle={.esp_tls_last_esp_err=123,.esp_transport_sock_errno=104,.esp_ws_handshake_status_code=403}};
  cloud_event_handler(NULL,0,WEBSOCKET_EVENT_ERROR,&error);
  assert(monitor_stats.errors==1&&monitor_stats.last_tls_error==123&&monitor_stats.last_socket_errno==104&&monitor_stats.last_http_status==403);
  // Sustained availability of both queues cannot starve either path.
  bool turn=true;char *line;cloud_binary_frame_t *audio;
  for(int i=0;i<20;i++) { enqueue(&controls,"control");enqueue(&audio_queue,packet(0)); }
  for(int i=0;i<40;i++) {
    take_outbound(&turn,&line,&audio);
    assert(i%2?(audio&&!line):(line&&!audio));free(audio);
  }
  assert(!controls.count&&!audio_queue.count);
  turn=false;enqueue(&controls,"stop");enqueue(&audio_queue,packet(CLOUD_BINARY_MAX_AGE_US+1));enqueue(&audio_queue,packet(100000));
  take_outbound(&turn,&line,&audio);assert(audio&&!line&&monitor_stats.realtime_chunks_dropped==1);free(audio);
  take_outbound(&turn,&line,&audio);assert(line&&!audio);
  // Expired audio never goes on the wire even when the control queue is empty.
  enqueue(&audio_queue,packet(500000));take_outbound(&turn,&line,&audio);assert(!line&&!audio&&monitor_stats.realtime_chunks_dropped==2);
  char *pending=malloc(8);assert(pending);strcpy(pending,"pending");
  enqueue(&controls,pending);enqueue(&audio_queue,packet(0));
  error.close_status_code=1006;cloud_event_handler(NULL,0,WEBSOCKET_EVENT_DISCONNECTED,&error);
  assert(!online&&!controls.count&&!audio_queue.count&&monitor_stats.disconnects==1&&monitor_stats.last_close_code==1006);
  puts("cloud IP lifecycle, send integrity and scheduling passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8', timeout: 5000 })).toContain('cloud IP lifecycle, send integrity and scheduling passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
