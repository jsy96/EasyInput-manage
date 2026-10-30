import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps actual input scanning responsive while telemetry blocks or its queue fills', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-scan-tests-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/main.c'), 'utf8')
    const extractFunction = (name: string): string => {
      const start = source.search(new RegExp(`static (?:void|bool) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing input function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const extractType = (name: string): string => {
      const end = source.indexOf(`} ${name};`) + `} ${name};`.length
      return source.slice(source.lastIndexOf('typedef struct {', end), end)
    }
    const constants = ['KEY_COUNT', 'DEBOUNCE_US', 'INPUT_SCAN_MS', 'INPUT_MONITOR_QUEUE_DEPTH', 'PROTOCOL_VERSION']
      .map(name => source.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    const pins = source.match(/^static const gpio_num_t (?:key_gpios|encoder_a_gpio|encoder_b_gpio|encoder_button_gpio).*;$/gm)?.join('\n')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include <setjmp.h>
#include <time.h>
${constants}
#define pdTRUE 1
#define portMAX_DELAY (-1)
#define pdMS_TO_TICKS(ms) (ms)
typedef int gpio_num_t;
${pins}
${extractType('debounced_input_t')}
${extractType('input_monitor_event_t')}
typedef struct {
  input_monitor_event_t events[INPUT_MONITOR_QUEUE_DEPTH];
  size_t head, count;
  pthread_mutex_t mutex;
  pthread_cond_t changed;
  bool stop;
} queue_t;
static queue_t queue = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
static queue_t *input_monitor_queue = &queue;
static uint32_t input_monitor_dropped;
static pthread_mutex_t state_lock = PTHREAD_MUTEX_INITIALIZER;
#define portENTER_CRITICAL(lock) pthread_mutex_lock(lock)
#define portEXIT_CRITICAL(lock) pthread_mutex_unlock(lock)
static int xQueueSend(queue_t *q, const void *event, int wait) {
  // Scanner calls must always use zero wait, including a full queue.
  assert(wait == 0);
  pthread_mutex_lock(&q->mutex);
  int ok = q->count < INPUT_MONITOR_QUEUE_DEPTH;
  if (ok) {
    q->events[(q->head + q->count) % INPUT_MONITOR_QUEUE_DEPTH] = *(const input_monitor_event_t *)event;
    q->count++;
    pthread_cond_signal(&q->changed);
  }
  pthread_mutex_unlock(&q->mutex);
  return ok;
}
static int xQueueReceive(queue_t *q, void *event, int wait) {
  assert(wait == portMAX_DELAY);
  pthread_mutex_lock(&q->mutex);
  while (!q->count && !q->stop) pthread_cond_wait(&q->changed, &q->mutex);
  if (q->stop && !q->count) { pthread_mutex_unlock(&q->mutex); pthread_exit(NULL); }
  *(input_monitor_event_t *)event = q->events[q->head];
  q->head = (q->head + 1) % INPUT_MONITOR_QUEUE_DEPTH;
  q->count--;
  pthread_mutex_unlock(&q->mutex);
  return pdTRUE;
}
static int64_t monotonic_us;
static input_monitor_event_t local_events[256];
static size_t local_count;
static void voice_chat_key(int key, bool pressed) {
  assert(local_count < 256);
  local_events[local_count++] = (input_monitor_event_t){.key = key, .pressed = pressed, .at_us = monotonic_us};
}
static void voice_chat_rotate(int delta) {
  assert(local_count < 256);
  local_events[local_count++] = (input_monitor_event_t){.key = KEY_COUNT, .delta = delta, .at_us = monotonic_us};
}
static pthread_mutex_t output_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t output_changed = PTHREAD_COND_INITIALIZER;
static bool output_blocked, output_release;
static char sent[8][160];
static size_t sent_count;
static void send_line(const char *line) {
  pthread_mutex_lock(&output_mutex);
  output_blocked = true;
  pthread_cond_signal(&output_changed);
  // Emulate an output transport that remains blocked for the entire double click.
  while (!output_release) pthread_cond_wait(&output_changed, &output_mutex);
  assert(sent_count < 8);
  snprintf(sent[sent_count++], sizeof sent[0], "%s", line);
  pthread_mutex_unlock(&output_mutex);
}
static int64_t esp_timer_get_time(void) { return monotonic_us; }
static int gpio_get_level(gpio_num_t pin) {
  const bool s5_down = (monotonic_us >= 100000 && monotonic_us < 180000) ||
                       (monotonic_us >= 300000 && monotonic_us < 380000);
  return pin == key_gpios[4] && s5_down ? 0 : 1;
}
static jmp_buf scan_done;
static void vTaskDelay(int ms) {
  if (local_count == 1) {
    pthread_mutex_lock(&output_mutex);
    struct timespec deadline; timespec_get(&deadline, TIME_UTC); deadline.tv_sec += 2;
    while (!output_blocked) assert(pthread_cond_timedwait(&output_changed, &output_mutex, &deadline) == 0);
    pthread_mutex_unlock(&output_mutex);
  }
  monotonic_us += (int64_t)ms * 1000;
  if (monotonic_us >= 600000) longjmp(scan_done, 1);
}
${['send_input_event', 'input_monitor_task', 'dispatch_input_event', 'read_pressed', 'update_debounced_input', 'input_task'].map(extractFunction).join('\n')}
static void *run_monitor(void *arg) { input_monitor_task(arg); return NULL; }
int main(void) {
  pthread_t monitor;
  assert(pthread_create(&monitor, NULL, run_monitor, NULL) == 0);
  if (!setjmp(scan_done)) input_task(NULL);
  assert(output_blocked && !output_release && !sent_count);
  assert(local_count == 4 && !input_monitor_dropped);
  const int64_t expected[] = {130000, 210000, 330000, 410000};
  for (size_t i = 0; i < 4; i++) {
    assert(local_events[i].key == 4 && local_events[i].pressed == !(i % 2));
    assert(local_events[i].at_us == expected[i]);
  }
  // Both debounced presses survive while the sender is still blocked; their
  // release-to-next-press interval remains within the double-click window.
  assert(local_events[2].at_us - local_events[1].at_us <= 400000);
  pthread_mutex_lock(&output_mutex);
  output_release = true;
  pthread_cond_signal(&output_changed);
  pthread_mutex_unlock(&output_mutex);
  pthread_mutex_lock(&queue.mutex);
  queue.stop = true;
  pthread_cond_signal(&queue.changed);
  pthread_mutex_unlock(&queue.mutex);
  assert(pthread_join(monitor, NULL) == 0);
  assert(sent_count == 4);
  for (size_t i = 0; i < 4; i++) {
    char timestamp[40]; snprintf(timestamp, sizeof timestamp, "\\\"uptime_ms\\\":%lld", (long long)(expected[i] / 1000));
    assert(strstr(sent[i], "\\\"key\\\":\\\"S5\\\"") && strstr(sent[i], timestamp));
    assert(strstr(sent[i], i % 2 ? "\\\"action\\\":\\\"up\\\"" : "\\\"action\\\":\\\"down\\\""));
  }
  queue.head = queue.count = 0;
  local_count = 0;
  for (int i = 0; i < INPUT_MONITOR_QUEUE_DEPTH + 20; i++) {
    monotonic_us += 10000;
    dispatch_input_event(4, !(i % 2), 0, monotonic_us);
  }
  assert(local_count == INPUT_MONITOR_QUEUE_DEPTH + 20);
  assert(queue.count == INPUT_MONITOR_QUEUE_DEPTH && input_monitor_dropped == 20);
  for (size_t i = 0; i < queue.count; i++) {
    assert(queue.events[i].at_us == local_events[i].at_us);
    assert(queue.events[i].pressed == local_events[i].pressed);
  }
  // Allocation failure disables only telemetry, with a visible drop count.
  input_monitor_queue = NULL;
  dispatch_input_event(KEY_COUNT, true, 0, ++monotonic_us);
  dispatch_input_event(KEY_COUNT, false, -1, ++monotonic_us);
  assert(local_count == INPUT_MONITOR_QUEUE_DEPTH + 22 && input_monitor_dropped == 22);
  assert(local_events[local_count - 1].delta == -1);
  send_input_event(&(input_monitor_event_t){.key = KEY_COUNT, .delta = -1, .at_us = 1234000});
  send_input_event(&(input_monitor_event_t){.key = KEY_COUNT, .pressed = true, .at_us = 1256000});
  assert(strstr(sent[4], "\\\"source\\\":\\\"encoder\\\"") && strstr(sent[4], "\\\"delta\\\":-1"));
  assert(strstr(sent[4], "\\\"uptime_ms\\\":1234") && !strstr(sent[4], "\\\"key\\\""));
  assert(strstr(sent[5], "\\\"action\\\":\\\"down\\\"") && strstr(sent[5], "\\\"uptime_ms\\\":1256"));
  puts("input scanning remains independent of telemetry passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pthread', join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8', timeout: 5000 })).toContain('input scanning remains independent of telemetry passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('backs off and rescans saved Wi-Fi, preserves DHCP DNS and gates cloud on valid IP', () => {
  const root = mkdtempSync(join(tmpdir(), 'easyinput-wifi-tests-'))
  try {
    const source = readFileSync(resolve('firmware/easyinput-monitor/main/main.c'), 'utf8')
    const extract = (name: string): string => {
      const start = source.search(new RegExp(`static (?:void|unsigned|esp_err_t) ${name}\\([^;]*?\\)\\n\\{`))
      if (start < 0) throw new Error(`Missing Wi-Fi function ${name}`)
      return source.slice(start, source.indexOf('\n}\n', start) + 3)
    }
    const constants = ['WIFI_FAST_RETRY_LIMIT', 'WIFI_RETRY_MAX_MS', 'WIFI_STARTED_BIT', 'WIFI_STOPPED_BIT', 'WIFI_DISCONNECTED_BIT']
      .map(name => source.match(new RegExp(`^#define ${name} .+$`, 'm'))?.[0]).join('\n')
    writeFileSync(join(root, 'test.c'), `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
${constants}
#define ESP_OK 0
#define WIFI_EVENT 1
#define IP_EVENT 2
#define WIFI_EVENT_STA_START 1
#define WIFI_EVENT_STA_STOP 2
#define WIFI_EVENT_STA_CONNECTED 3
#define WIFI_EVENT_STA_DISCONNECTED 4
#define WIFI_EVENT_SCAN_DONE 5
#define IP_EVENT_STA_GOT_IP 6
#define IP_EVENT_STA_LOST_IP 7
#define WIFI_IF_STA 0
#define ESP_NETIF_DNS_MAIN 0
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
typedef int esp_err_t;
typedef int esp_event_base_t;
typedef struct { struct { uint8_t ssid[32],password[64]; } sta; } wifi_config_t;
typedef struct { uint8_t *ssid; bool show_hidden; } wifi_scan_config_t;
typedef struct { int rssi,primary; } wifi_ap_record_t;
typedef struct { int reason; } wifi_event_sta_disconnected_t;
typedef struct { int unused; } ip_event_got_ip_t;
typedef struct { unsigned addr; } esp_ip4_addr_t;
typedef struct { esp_ip4_addr_t ip,netmask,gw; } esp_netif_ip_info_t;
typedef struct { struct { struct { esp_ip4_addr_t ip4; } u_addr; } ip; } esp_netif_dns_info_t;
static int state_lock, wifi_lifecycle_events;
static void *wifi_retry_timer=(void*)1, *wifi_netif=(void*)1;
static bool wifi_configured=true,wifi_reconfiguring,wifi_retry_rescan,wifi_scan_pending,sntp_started;
static unsigned wifi_retry_failures,wifi_retries,wifi_disconnects;
static int wifi_disconnect_code,wifi_rssi,wifi_channel;
static char wifi_state[16]="connecting",wifi_ssid[33]="saved-network",wifi_ip[16],wifi_netmask[16],wifi_gateway[16],wifi_dns[16];
static const char *TAG="test";
static void log_msg(const char *tag,const char *fmt,...) { (void)tag;(void)fmt; }
#define ESP_LOGW(...) log_msg(__VA_ARGS__)
#define ESP_LOGI(...) log_msg(__VA_ARGS__)
static int connects,scans,scan_clears,connect_result,scan_result;
static bool cloud_ready;
static unsigned ready_changes;
static uint64_t scheduled_us;
static void cloud_monitor_set_network_ready(bool value) { cloud_ready=value; ready_changes++; }
static const char *esp_err_to_name(int code) { return code ? "FAIL" : "OK"; }
static int esp_timer_stop(void *timer) { assert(timer);scheduled_us=0;return ESP_OK; }
static int esp_timer_start_once(void *timer,uint64_t us) { assert(timer);scheduled_us=us;return ESP_OK; }
static uint32_t esp_random(void) { return 0; }
static int esp_wifi_connect(void) { connects++;return connect_result; }
static int esp_wifi_scan_start(const wifi_scan_config_t *scan,bool blocking) { assert(!blocking && scan->show_hidden && !strcmp((char*)scan->ssid,"saved-network"));scans++;return scan_result; }
static int esp_wifi_scan_stop(void) { return ESP_OK; }
static int esp_wifi_clear_ap_list(void) { scan_clears++;return ESP_OK; }
static int esp_wifi_get_config(int mode,wifi_config_t *cfg) { (void)mode;strcpy((char*)cfg->sta.ssid,"saved-network");return ESP_OK; }
static int esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap) { ap->rssi=-55;ap->primary=6;return ESP_OK; }
static void xEventGroupSetBits(int group,unsigned bits) { (void)group;(void)bits; }
static void xEventGroupClearBits(int group,unsigned bits) { (void)group;(void)bits; }
static unsigned heap_caps_get_free_size(int caps) { (void)caps;return 20000; }
static unsigned heap_caps_get_largest_free_block(int caps) { (void)caps;return 10000; }
static int esp_netif_get_ip_info(void *n,esp_netif_ip_info_t *info) { assert(n);info->ip.addr=2;info->netmask.addr=255;info->gw.addr=1;return ESP_OK; }
static void esp_ip4addr_ntoa(const esp_ip4_addr_t *ip,char *out,size_t length) { snprintf(out,length,"192.168.1.%u",ip->addr); }
static int esp_netif_get_dns_info(void *n,int type,esp_netif_dns_info_t *info) { assert(n && type==ESP_NETIF_DNS_MAIN);info->ip.u_addr.ip4.addr=1;return ESP_OK; }
static int esp_netif_sntp_start(void) { return ESP_OK; }
#undef strlcpy
#define strlcpy test_strlcpy
static size_t test_strlcpy(char *dest,const char *src,size_t size) { size_t n=strlen(src);if(size) { size_t take=n<size-1?n:size-1;memcpy(dest,src,take);dest[take]=0; }return n; }
static void wifi_schedule_retry(void);
${['wifi_retry_delay_ms','wifi_cancel_retry','wifi_connect_attempt','wifi_retry_callback','wifi_schedule_retry','wifi_event_handler'].map(extract).join('\n')}
int main(void) {
  const unsigned expected[]={250,500,750,1000,2000,4000,8000,16000,30000,30000};
  for(unsigned i=0;i<sizeof(expected)/sizeof(expected[0]);i++) {
    wifi_schedule_retry();assert(scheduled_us==(uint64_t)expected[i]*1000);
    wifi_retry_callback(NULL);
    assert(connects==(int)(i<3?i+1:i));
    if(i>=3) { assert(wifi_scan_pending);wifi_event_handler(NULL,WIFI_EVENT,WIFI_EVENT_SCAN_DONE,NULL);assert(!wifi_scan_pending); }
  }
  assert(scans==7 && scan_clears==7 && connects==10 && wifi_retries==10);
  wifi_reconfiguring=true;unsigned retries=wifi_retries;wifi_cancel_retry();
  wifi_schedule_retry();wifi_retry_callback(NULL);assert(!scheduled_us && wifi_retries==retries && connects==10);
  wifi_reconfiguring=false;strcpy(wifi_state,"disconnected");wifi_retry_callback(NULL);assert(connects==10);
  strcpy(wifi_state,"connecting");
  wifi_event_handler(NULL,IP_EVENT,IP_EVENT_STA_GOT_IP,NULL);
  assert(cloud_ready && wifi_retry_failures==0 && !wifi_retry_rescan && !scheduled_us && sntp_started);
  assert(!strcmp(wifi_dns,"192.168.1.1") && !strcmp(wifi_ip,"192.168.1.2"));
  wifi_event_handler(NULL,IP_EVENT,IP_EVENT_STA_LOST_IP,NULL);assert(!cloud_ready && !wifi_ip[0]);
  wifi_event_sta_disconnected_t lost={.reason=201};
  wifi_event_handler(NULL,WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,&lost);
  assert(!cloud_ready && wifi_disconnect_code==201 && wifi_disconnects==1 && scheduled_us==250000);
  wifi_retry_callback(NULL);assert(connects==11);
  // Failure to even start connecting also retries, without a disconnect event.
  connect_result=-1;assert(wifi_connect_attempt()!=ESP_OK && scheduled_us==500000);
  wifi_event_handler(NULL,WIFI_EVENT,WIFI_EVENT_STA_STOP,NULL);assert(!scheduled_us && !cloud_ready);
  assert(ready_changes>=4);
  puts("Wi-Fi recovery and DHCP DNS passed");
}
`)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', join(root, 'test.c'), '-o', join(root, 'test')], { encoding: 'utf8' })
    expect(execFileSync(join(root, 'test'), { encoding: 'utf8', timeout: 5000 })).toContain('Wi-Fi recovery and DHCP DNS passed')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
