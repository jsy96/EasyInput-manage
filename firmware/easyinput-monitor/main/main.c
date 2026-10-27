#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "lights.h"
#include "audio.h"
#include "cloud.h"
#include "voice_chat.h"
#include "network_setup.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "driver/usb_serial_jtag.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_private/esp_clk.h"
#include "esp_spi_flash_counters.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_gap.h"
#include "host/ble_att.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_store.h"
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

void ble_store_config_init(void);

#define PROTOCOL_VERSION 2
#define KEY_COUNT 8
#define DEBOUNCE_US 25000
#define INPUT_SCAN_MS 10
#define STATUS_INTERVAL_MS 1000
#define USB_LINE_MAX 2048
#define PARTITION_COUNT_MAX 24
#define BLE_TX_QUEUE_DEPTH 16
#define WIFI_STARTED_BIT (1U << 0)
#define WIFI_STOPPED_BIT (1U << 1)
#define WIFI_DISCONNECTED_BIT (1U << 2)
#define WIFI_TRANSITION_TIMEOUT_MS 3000
#define WIFI_WS_MAX_CLIENTS 3
#define WIFI_WS_PENDING_LIMIT 16

static const char *TAG = "easyinput";
static const gpio_num_t key_gpios[KEY_COUNT] = {2, 47, 38, 41, 1, 6, 7, 48};
static const gpio_num_t encoder_a_gpio = 17;
static const gpio_num_t encoder_b_gpio = 16;
static const gpio_num_t encoder_button_gpio = 18;

static SemaphoreHandle_t usb_tx_mutex;
static SemaphoreHandle_t ble_notify_tx_done;
static QueueHandle_t ble_tx_queue;
static QueueHandle_t board_command_queue;
static EventGroupHandle_t wifi_lifecycle_events;
static httpd_handle_t wifi_websocket_server;
static unsigned wifi_websocket_peers;
static unsigned wifi_websocket_pending;
static portMUX_TYPE state_lock = portMUX_INITIALIZER_UNLOCKED;
static char wifi_state[16] = "disconnected";
static char wifi_ssid[33] = {0};
static char wifi_ip[16] = {0};
static char wifi_netmask[16] = {0};
static char wifi_gateway[16] = {0};
static char wifi_dns[16] = {0};
static int wifi_rssi;
static int wifi_channel;
static int wifi_disconnect_code;
static uint32_t wifi_disconnects;
static uint32_t wifi_retries;
static bool wifi_configured;
static bool wifi_reconfiguring;
static int ble_peers;
static char ble_state[16] = "starting";
static uint8_t ble_address_type;
static uint16_t ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t ble_tx_value_handle;
static bool ble_link_encrypted;
static bool ble_notifications_enabled;
static uint32_t ble_connection_generation;
static int ble_notify_tx_status;
static bool sntp_started;
static char ble_command_buffer[USB_LINE_MAX];
static size_t ble_command_length;
static esp_netif_t *wifi_netif;
static adc_oneshot_unit_handle_t adc_handle;
static adc_cali_handle_t adc_cali_handle;
static bool adc_cali_ready;
static temperature_sensor_handle_t temperature_handle;
static uint32_t flash_total_bytes;
static uint32_t app_partition_bytes;
static uint32_t app_image_bytes;
static uint32_t flash_unallocated_bytes;
static esp_partition_t partition_snapshots[PARTITION_COUNT_MAX];
static size_t partition_snapshot_count;
static uint64_t last_cpu_sample_us;
static uint64_t last_idle_runtime[portNUM_PROCESSORS];
static esp_flash_counters_t last_flash_counters;
static uint64_t last_flash_sample_us;


static void start_advertising(void);
static void handle_command(const char *line);
static void time_sync_notification_cb(struct timeval *tv);

typedef struct {
    char *line;
    uint16_t conn_handle;
    uint32_t generation;
} ble_tx_frame_t;

static const ble_uuid128_t ble_service_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0xb0, 0x8d, 0x2d, 0xbc, 0xa3,
    0x51, 0x4f, 0x24, 0x6e, 0x01, 0x00, 0x00, 0xe1);
static const ble_uuid128_t ble_tx_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0xb0, 0x8d, 0x2d, 0xbc, 0xa3,
    0x51, 0x4f, 0x24, 0x6e, 0x02, 0x00, 0x00, 0xe1);
static const ble_uuid128_t ble_rx_uuid = BLE_UUID128_INIT(
    0x01, 0x00, 0x00, 0xb0, 0x8d, 0x2d, 0xbc, 0xa3,
    0x51, 0x4f, 0x24, 0x6e, 0x03, 0x00, 0x00, 0xe1);

static int ble_tx_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *context, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)context;
    (void)arg;
    return BLE_ATT_ERR_READ_NOT_PERMITTED;
}

static int ble_command_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *context, void *arg);

static const struct ble_gatt_chr_def ble_characteristics[] = {
    {
        .uuid = &ble_tx_uuid.u,
        .access_cb = ble_tx_access_cb,
        .flags = BLE_GATT_CHR_F_NOTIFY,
        .val_handle = &ble_tx_value_handle,
    },
    {
        .uuid = &ble_rx_uuid.u,
        .access_cb = ble_command_access_cb,
        .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC,
    },
    {0},
};

static const struct ble_gatt_svc_def ble_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &ble_service_uuid.u,
        .characteristics = ble_characteristics,
    },
    {0},
};

typedef struct {
    bool raw_pressed;
    bool stable_pressed;
    int64_t changed_at_us;
} debounced_input_t;

static void wifi_websocket_broadcast(void *arg)
{
    char *line = arg;
    int clients[WIFI_WS_MAX_CLIENTS];
    size_t count = WIFI_WS_MAX_CLIENTS;
    if (httpd_get_client_list(wifi_websocket_server, &count, clients) == ESP_OK) {
        httpd_ws_frame_t frame = {.type = HTTPD_WS_TYPE_TEXT, .payload = (uint8_t *)line, .len = strlen(line)};
        for (size_t i = 0; i < count; i++) {
            if (httpd_ws_get_fd_info(wifi_websocket_server, clients[i]) != HTTPD_WS_CLIENT_WEBSOCKET ||
                httpd_sess_get_ctx(wifi_websocket_server, clients[i]) == NULL) continue;
            if (httpd_ws_send_frame_async(wifi_websocket_server, clients[i], &frame) != ESP_OK) {
                (void)httpd_sess_trigger_close(wifi_websocket_server, clients[i]);
            }
        }
    }
    free(line);
    portENTER_CRITICAL(&state_lock);
    wifi_websocket_pending--;
    portEXIT_CRITICAL(&state_lock);
}

static void queue_wifi_line(const char *line)
{
    if (wifi_websocket_server == NULL) return;
    portENTER_CRITICAL(&state_lock);
    const bool ready = wifi_websocket_peers > 0 && wifi_websocket_pending < WIFI_WS_PENDING_LIMIT;
    if (ready) wifi_websocket_pending++;
    portEXIT_CRITICAL(&state_lock);
    if (!ready) return;

    const size_t length = strlen(line);
    char *copy = malloc(length + 2);
    if (copy != NULL) {
        memcpy(copy, line, length);
        copy[length] = '\n';
        copy[length + 1] = '\0';
        // Queueing keeps network writes out of the input scanner and USB/BLE tasks.
        if (httpd_queue_work(wifi_websocket_server, wifi_websocket_broadcast, copy) == ESP_OK) return;
        free(copy);
    }
    portENTER_CRITICAL(&state_lock);
    wifi_websocket_pending--;
    portEXIT_CRITICAL(&state_lock);
}

static bool wifi_websocket_origin_allowed(httpd_req_t *request)
{
    char origin[96];
    if (httpd_req_get_hdr_value_str(request, "Origin", origin, sizeof(origin)) != ESP_OK) return false;
    const char *hosts[] = {"http://127.0.0.1", "http://localhost", "http://[::1]"};
    for (size_t i = 0; i < sizeof(hosts) / sizeof(hosts[0]); i++) {
        const size_t length = strlen(hosts[i]);
        if (strncmp(origin, hosts[i], length) != 0) continue;
        const char *suffix = origin + length;
        if (*suffix == '\0') return true;
        if (*suffix++ != ':' || *suffix == '\0') continue;
        char *end;
        const unsigned long port = strtoul(suffix, &end, 10);
        if (*suffix >= '0' && *suffix <= '9' && *end == '\0' && port > 0 && port <= 65535) return true;
    }
    return false;
}

static void wifi_websocket_session_free(void *context)
{
    free(context);
    portENTER_CRITICAL(&state_lock);
    wifi_websocket_peers--;
    portEXIT_CRITICAL(&state_lock);
}

static esp_err_t wifi_websocket_pre_handshake(httpd_req_t *request)
{
    if (wifi_websocket_origin_allowed(request)) return ESP_OK;
    httpd_resp_set_status(request, "403 Forbidden");
    (void)httpd_resp_sendstr(request, "Use the local EasyInput Studio page.");
    return ESP_FAIL;
}

static esp_err_t wifi_websocket_post_handshake(httpd_req_t *request)
{
    request->sess_ctx = malloc(1);
    if (request->sess_ctx == NULL) return ESP_ERR_NO_MEM;
    request->free_ctx = wifi_websocket_session_free;
    portENTER_CRITICAL(&state_lock);
    wifi_websocket_peers++;
    portEXIT_CRITICAL(&state_lock);
    return ESP_OK;
}

static esp_err_t wifi_websocket_handler(httpd_req_t *request)
{
    char line[USB_LINE_MAX] = {0};
    httpd_ws_frame_t frame = {0};
    esp_err_t result = httpd_ws_recv_frame(request, &frame, 0);
    if (result != ESP_OK) return result;
    if (frame.type == HTTPD_WS_TYPE_PING || frame.type == HTTPD_WS_TYPE_PONG || frame.type == HTTPD_WS_TYPE_CLOSE) return ESP_OK;
    if (frame.type != HTTPD_WS_TYPE_TEXT || !frame.final || frame.len == 0 || frame.len >= sizeof(line)) return ESP_FAIL;
    frame.payload = (uint8_t *)line;
    result = httpd_ws_recv_frame(request, &frame, sizeof(line) - 1);
    if (result != ESP_OK) return result;

    // Monitoring only: credentials and network changes require USB or encrypted BLE.
    cJSON *command = cJSON_Parse(line);
    const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(command, "protocol");
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(command, "action");
    const bool allowed = cJSON_IsNumber(protocol) && protocol->valueint == PROTOCOL_VERSION && cJSON_IsString(action) &&
        (strcmp(action->valuestring, "hello.get") == 0 || strcmp(action->valuestring, "status.get") == 0);
    cJSON_Delete(command);
    result = allowed && xQueueSend(board_command_queue, line, 0) == pdTRUE ? ESP_OK : ESP_FAIL;
    memset(line, 0, sizeof(line));
    return result;
}

static void init_wifi_websocket(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_open_sockets = WIFI_WS_MAX_CLIENTS;
    config.max_uri_handlers = 6;
    config.stack_size = 6144;
    config.send_wait_timeout = 1;
    config.recv_wait_timeout = 1;
    config.lru_purge_enable = true;
    esp_err_t result = httpd_start(&wifi_websocket_server, &config);
    if (result == ESP_OK) {
        const httpd_uri_t endpoint = {
            .uri = "/ws", .method = HTTP_GET, .handler = wifi_websocket_handler, .is_websocket = true,
            .ws_pre_handshake_cb = wifi_websocket_pre_handshake,
            .ws_post_handshake_cb = wifi_websocket_post_handshake,
        };
        result = httpd_register_uri_handler(wifi_websocket_server, &endpoint);
        if (result != ESP_OK) {
            (void)httpd_stop(wifi_websocket_server);
            wifi_websocket_server = NULL;
        }
    }
    if (result != ESP_OK) ESP_LOGE(TAG, "Wi-Fi monitoring server unavailable: %s", esp_err_to_name(result));
    else ESP_LOGI(TAG, "Wi-Fi monitoring available at ws://<station-ip>/ws (local Studio origins)");
}

static void queue_ble_line(const char *line)
{
    if (ble_tx_queue == NULL || line == NULL) return;

    ble_tx_frame_t frame = {0};
    portENTER_CRITICAL(&state_lock);
    const bool ready = ble_conn_handle != BLE_HS_CONN_HANDLE_NONE && ble_link_encrypted && ble_notifications_enabled;
    frame.conn_handle = ble_conn_handle;
    frame.generation = ble_connection_generation;
    portEXIT_CRITICAL(&state_lock);
    if (!ready) return;

    const size_t line_length = strlen(line);
    frame.line = malloc(line_length + 2);
    if (frame.line == NULL) return;
    memcpy(frame.line, line, line_length + 1);
    frame.line[line_length] = '\n';
    frame.line[line_length + 1] = '\0';
    if (xQueueSend(ble_tx_queue, &frame, 0) != pdTRUE) {
        free(frame.line);
        ESP_LOGW(TAG, "BLE transmit queue full; frame dropped");
    }
}

static void send_line(const char *line)
{
    if (line == NULL) return;
    queue_ble_line(line);
    queue_wifi_line(line);
    cloud_monitor_send(line);
    if (usb_serial_jtag_is_connected() && usb_tx_mutex != NULL && xSemaphoreTake(usb_tx_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        usb_serial_jtag_write_bytes(line, strlen(line), pdMS_TO_TICKS(80));
        usb_serial_jtag_write_bytes("\n", 1, pdMS_TO_TICKS(80));
        xSemaphoreGive(usb_tx_mutex);
    }
}

bool cloud_monitor_queue_command(const char *line)
{
    if (line == NULL || board_command_queue == NULL || strlen(line) >= USB_LINE_MAX) return false;
    char copy[USB_LINE_MAX] = {0};
    strlcpy(copy, line, sizeof(copy));
    return xQueueSend(board_command_queue, copy, 0) == pdTRUE;
}

static void send_chat_line(const char *line)
{
    if (cloud_monitor_is_online()) cloud_monitor_send(line);
    else queue_ble_line(line);
}

static bool ble_frame_is_current(const ble_tx_frame_t *frame)
{
    bool current;
    portENTER_CRITICAL(&state_lock);
    current = frame->conn_handle == ble_conn_handle &&
              frame->generation == ble_connection_generation &&
              ble_link_encrypted && ble_notifications_enabled;
    portEXIT_CRITICAL(&state_lock);
    return current;
}

static void ble_tx_task(void *arg)
{
    (void)arg;
    ble_tx_frame_t frame;
    while (true) {
        if (xQueueReceive(ble_tx_queue, &frame, portMAX_DELAY) != pdTRUE) continue;
        const size_t line_length = strlen(frame.line);
        const uint16_t mtu = ble_att_mtu(frame.conn_handle);
        const size_t max_payload = mtu > 3 ? mtu - 3 : 20;
        size_t offset = 0;

        while (offset < line_length && ble_frame_is_current(&frame)) {
            const size_t remaining = line_length - offset;
            const uint16_t chunk_length = (uint16_t)(remaining < max_payload ? remaining : max_payload);
            struct os_mbuf *packet = ble_hs_mbuf_from_flat(frame.line + offset, chunk_length);
            if (packet == NULL) {
                ESP_LOGW(TAG, "Unable to allocate BLE notification packet");
                break;
            }

            while (xSemaphoreTake(ble_notify_tx_done, 0) == pdTRUE) {}
            portENTER_CRITICAL(&state_lock);
            ble_notify_tx_status = BLE_HS_EUNKNOWN;
            portEXIT_CRITICAL(&state_lock);
            const int rc = ble_gatts_notify_custom(frame.conn_handle, ble_tx_value_handle, packet);
            if (rc != 0) {
                ESP_LOGW(TAG, "BLE notification failed: %d", rc);
                break;
            }
            if (xSemaphoreTake(ble_notify_tx_done, pdMS_TO_TICKS(1500)) != pdTRUE) {
                ESP_LOGW(TAG, "BLE notification timed out");
                break;
            }
            portENTER_CRITICAL(&state_lock);
            const int notify_status = ble_notify_tx_status;
            portEXIT_CRITICAL(&state_lock);
            if (notify_status != 0) break;
            offset += chunk_length;
        }
        free(frame.line);
    }
}

static void send_result_with_id(const char *action, bool ok, const char *message, const char *request_id)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return;
    cJSON_AddStringToObject(root, "type", "result");
    cJSON_AddNumberToObject(root, "protocol", PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "action", action);
    cJSON_AddBoolToObject(root, "ok", ok);
    if (request_id != NULL) cJSON_AddStringToObject(root, "request_id", request_id);
    if (message != NULL) cJSON_AddStringToObject(root, "message", message);
    char *line = cJSON_PrintUnformatted(root);
    if (line != NULL) {
        send_line(line);
        cJSON_free(line);
    }
    cJSON_Delete(root);
}

static void send_result(const char *action, bool ok, const char *message)
{
    send_result_with_id(action, ok, message, NULL);
}

static void clear_command_password(cJSON *command)
{
    cJSON *password = cJSON_GetObjectItemCaseSensitive(command, "password");
    if (cJSON_IsString(password) && password->valuestring != NULL) {
        volatile char *secret = password->valuestring;
        for (size_t index = 0; secret[index] != '\0'; index++) secret[index] = '\0';
    }
}

static void clear_command_secret(cJSON *command, const char *name)
{
    cJSON *secret = cJSON_GetObjectItemCaseSensitive(command, name);
    if (cJSON_IsString(secret) && secret->valuestring != NULL) {
        volatile char *value = secret->valuestring;
        for (size_t index = 0; value[index] != '\0'; index++) value[index] = '\0';
    }
}

static void send_input_event(const char *source, const char *action, const char *key, int delta)
{
    char line[160];
    const int64_t uptime_ms = esp_timer_get_time() / 1000;
    if (key != NULL) {
        snprintf(line, sizeof(line),
                 "{\"type\":\"event\",\"protocol\":%d,\"source\":\"%s\",\"key\":\"%s\",\"action\":\"%s\",\"uptime_ms\":%lld}",
                 PROTOCOL_VERSION, source, key, action, (long long)uptime_ms);
    } else if (strcmp(action, "rotate") == 0) {
        snprintf(line, sizeof(line),
                 "{\"type\":\"event\",\"protocol\":%d,\"source\":\"%s\",\"action\":\"rotate\",\"delta\":%d,\"uptime_ms\":%lld}",
                 PROTOCOL_VERSION, source, delta, (long long)uptime_ms);
    } else {
        snprintf(line, sizeof(line),
                 "{\"type\":\"event\",\"protocol\":%d,\"source\":\"%s\",\"action\":\"%s\",\"uptime_ms\":%lld}",
                 PROTOCOL_VERSION, source, action, (long long)uptime_ms);
    }
    send_line(line);
}

static void emit_hello(void)
{
    char line[192];
    const int64_t uptime_ms = esp_timer_get_time() / 1000;
    const esp_app_desc_t *app_description = esp_app_get_description();
    snprintf(line, sizeof(line),
             "{\"type\":\"hello\",\"protocol\":%d,\"board\":\"easyinput-v2\",\"chip\":\"ESP32-S3\",\"firmware\":\"%s\",\"uptime_ms\":%lld}",
             PROTOCOL_VERSION, app_description->version, (long long)uptime_ms);
    send_line(line);
}

static void queue_ble_hello(void)
{
    char line[192];
    const int64_t uptime_ms = esp_timer_get_time() / 1000;
    const esp_app_desc_t *app_description = esp_app_get_description();
    snprintf(line, sizeof(line),
             "{\"type\":\"hello\",\"protocol\":%d,\"board\":\"easyinput-v2\",\"chip\":\"ESP32-S3\",\"firmware\":\"%s\",\"uptime_ms\":%lld}",
             PROTOCOL_VERSION, app_description->version, (long long)uptime_ms);
    queue_ble_line(line);
}

static void collect_partition_info(void)
{
    uint32_t max_end = 0;
    esp_partition_iterator_t iterator = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    while (iterator != NULL && partition_snapshot_count < PARTITION_COUNT_MAX) {
        const esp_partition_t *partition = esp_partition_get(iterator);
        if (partition != NULL) {
            partition_snapshots[partition_snapshot_count++] = *partition;
            const uint32_t end = partition->address + partition->size;
            if (end > max_end) max_end = end;
        }
        iterator = esp_partition_next(iterator);
    }
    if (iterator != NULL) esp_partition_iterator_release(iterator);
    flash_unallocated_bytes = flash_total_bytes > max_end ? flash_total_bytes - max_end : 0;

    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running != NULL) {
        app_partition_bytes = running->size;
        esp_partition_pos_t position = {.offset = running->address, .size = running->size};
        esp_image_metadata_t metadata = {0};
        if (esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &position, &metadata) == ESP_OK) {
            app_image_bytes = metadata.image_len;
        }
    }
}

static void update_cpu_usage(double usage[portNUM_PROCESSORS])
{
    const uint64_t now_us = esp_timer_get_time();
    bool valid_sample = last_cpu_sample_us != 0;
    const uint64_t elapsed = valid_sample ? now_us - last_cpu_sample_us : 0;
    for (int core = 0; core < portNUM_PROCESSORS; core++) {
        const uint64_t idle_now = (uint64_t)ulTaskGetIdleRunTimeCounterForCore(core);
        if (valid_sample && elapsed > 0 && idle_now >= last_idle_runtime[core]) {
            const uint64_t idle_delta = idle_now - last_idle_runtime[core];
            double percent = 100.0 - ((double)idle_delta * 100.0 / (double)elapsed);
            if (percent < 0.0) percent = 0.0;
            if (percent > 100.0) percent = 100.0;
            usage[core] = percent;
        } else {
            usage[core] = 0.0;
        }
        last_idle_runtime[core] = idle_now;
    }
    last_cpu_sample_us = now_us;
}

static uint32_t sample_flash_rate(uint32_t current, uint32_t previous, uint64_t elapsed_us)
{
    if (elapsed_us == 0) return 0;
    const uint32_t delta = current - previous;
    const uint64_t rate = (uint64_t)delta * 1000000ULL / elapsed_us;
    return rate > UINT32_MAX ? UINT32_MAX : (uint32_t)rate;
}

static void sample_battery(int *battery_mv, bool *has_battery)
{
    *has_battery = false;
    if (adc_handle == NULL || !adc_cali_ready) return;
    if (gpio_set_level(GPIO_NUM_5, 1) != ESP_OK) return;
    vTaskDelay(pdMS_TO_TICKS(50)); /* Project sampling window; verify against the assembled board. */
    int raw_total = 0;
    int samples = 0;
    for (int index = 0; index < 8; index++) {
        int raw = 0;
        if (adc_oneshot_read(adc_handle, ADC_CHANNEL_3, &raw) == ESP_OK) {
            raw_total += raw;
            samples++;
        }
    }
    (void)gpio_set_level(GPIO_NUM_5, 0);
    if (samples == 0) return;
    int pin_mv = 0;
    if (adc_cali_raw_to_voltage(adc_cali_handle, raw_total / samples, &pin_mv) == ESP_OK) {
        *battery_mv = pin_mv * 2;
        *has_battery = true;
    }
}

static void emit_status(void)
{
    char wifi_state_copy[16], wifi_ssid_copy[33], wifi_ip_copy[16], wifi_netmask_copy[16];
    char wifi_gateway_copy[16], wifi_dns_copy[16], ble_state_copy[16];
    int wifi_rssi_copy, wifi_channel_copy, wifi_disconnect_code_copy, ble_peers_copy;
    uint32_t wifi_disconnects_copy, wifi_retries_copy;
    bool wifi_configured_copy;
    portENTER_CRITICAL(&state_lock);
    strlcpy(wifi_state_copy, wifi_state, sizeof(wifi_state_copy));
    strlcpy(wifi_ssid_copy, wifi_ssid, sizeof(wifi_ssid_copy));
    strlcpy(wifi_ip_copy, wifi_ip, sizeof(wifi_ip_copy));
    strlcpy(wifi_netmask_copy, wifi_netmask, sizeof(wifi_netmask_copy));
    strlcpy(wifi_gateway_copy, wifi_gateway, sizeof(wifi_gateway_copy));
    strlcpy(wifi_dns_copy, wifi_dns, sizeof(wifi_dns_copy));
    strlcpy(ble_state_copy, ble_state, sizeof(ble_state_copy));
    wifi_rssi_copy = wifi_rssi;
    wifi_channel_copy = wifi_channel;
    wifi_disconnect_code_copy = wifi_disconnect_code;
    wifi_disconnects_copy = wifi_disconnects;
    wifi_retries_copy = wifi_retries;
    wifi_configured_copy = wifi_configured;
    ble_peers_copy = ble_peers;
    portEXIT_CRITICAL(&state_lock);

    const uint64_t now_us = esp_timer_get_time();
    const uint64_t elapsed_us = last_flash_sample_us == 0 ? 0 : now_us - last_flash_sample_us;
    const esp_flash_counters_t *counters_ptr = esp_flash_get_counters();
    esp_flash_counters_t counters = counters_ptr == NULL ? (esp_flash_counters_t){0} : *counters_ptr;
    const uint32_t read_bps = sample_flash_rate(counters.read.bytes, last_flash_counters.read.bytes, elapsed_us);
    const uint32_t write_bps = sample_flash_rate(counters.write.bytes, last_flash_counters.write.bytes, elapsed_us);
    const uint32_t erase_bps = sample_flash_rate(counters.erase.bytes, last_flash_counters.erase.bytes, elapsed_us);
    last_flash_counters = counters;
    last_flash_sample_us = now_us;

    double cpu_usage[portNUM_PROCESSORS] = {0};
    update_cpu_usage(cpu_usage);
    const int cpu_frequency_mhz = esp_clk_cpu_freq() / 1000000;
    const size_t internal_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t internal_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t psram_total = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
    const size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    const size_t internal_largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const size_t psram_largest = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
    const size_t internal_minimum = heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    nvs_stats_t current_nvs_stats = {0};
    const bool nvs_stats_ready = nvs_get_stats("nvs", &current_nvs_stats) == ESP_OK;

    int battery_mv = 0;
    bool has_battery = false;
    sample_battery(&battery_mv, &has_battery);
    const bool external_power = gpio_get_level(GPIO_NUM_40) == 0;
    const bool charging = external_power && gpio_get_level(GPIO_NUM_39) != 0;
    float temperature_c = 0.0f;
    const bool has_temperature = temperature_handle != NULL && temperature_sensor_get_celsius(temperature_handle, &temperature_c) == ESP_OK;

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return;
    cJSON_AddStringToObject(root, "type", "status");
    cJSON_AddNumberToObject(root, "protocol", PROTOCOL_VERSION);
    cJSON_AddNumberToObject(root, "uptime_ms", now_us / 1000);

    cJSON *wifi = cJSON_AddObjectToObject(root, "wifi");
    cJSON_AddStringToObject(wifi, "state", wifi_state_copy);
    cJSON_AddBoolToObject(wifi, "configured", wifi_configured_copy);
    cJSON_AddNumberToObject(wifi, "rssi", wifi_rssi_copy);
    cJSON_AddNumberToObject(wifi, "channel", wifi_channel_copy);
    cJSON_AddNumberToObject(wifi, "disconnect_code", wifi_disconnect_code_copy);
    cJSON_AddNumberToObject(wifi, "disconnects", wifi_disconnects_copy);
    cJSON_AddNumberToObject(wifi, "retries", wifi_retries_copy);
    if (wifi_ssid_copy[0]) cJSON_AddStringToObject(wifi, "ssid", wifi_ssid_copy);
    if (wifi_ip_copy[0]) cJSON_AddStringToObject(wifi, "ip", wifi_ip_copy);
    if (wifi_netmask_copy[0]) cJSON_AddStringToObject(wifi, "netmask", wifi_netmask_copy);
    if (wifi_gateway_copy[0]) cJSON_AddStringToObject(wifi, "gateway", wifi_gateway_copy);
    if (wifi_dns_copy[0]) cJSON_AddStringToObject(wifi, "dns", wifi_dns_copy);

    cJSON *ble = cJSON_AddObjectToObject(root, "ble");
    cJSON_AddStringToObject(ble, "state", ble_state_copy);
    cJSON_AddStringToObject(ble, "name", "EasyInput");
    cJSON_AddNumberToObject(ble, "peers", ble_peers_copy);
    lights_snapshot_t light_state;
    lights_get_snapshot(&light_state);
    cJSON *peripherals = cJSON_AddObjectToObject(root, "peripherals");
    cJSON_AddStringToObject(peripherals, "shared_rail", light_state.rail_on ? "on" : "off");
    cJSON *lights = cJSON_AddObjectToObject(root, "lights");
    cJSON_AddStringToObject(lights, "status_led", light_state.ready ? (light_state.status_brightness ? "on" : "off") : "unknown");
    cJSON *pixels = cJSON_AddArrayToObject(lights, "pixels");
    cJSON *control = cJSON_AddObjectToObject(lights, "control");
    cJSON_AddBoolToObject(control, "ready", light_state.ready);
    cJSON_AddNumberToObject(control, "status_led_brightness", light_state.status_brightness);
    if (light_state.error != ESP_OK) cJSON_AddStringToObject(control, "error", esp_err_to_name(light_state.error));
    cJSON *settings = cJSON_AddArrayToObject(control, "pixels");
    for (int index = 0; index < LIGHT_PIXEL_COUNT; index++) {
        const light_pixel_t *pixel = &light_state.pixels[index];
        const bool lit = light_state.rail_on && lights_pixel_is_lit(pixel);
        cJSON_AddItemToArray(pixels, cJSON_CreateString(!light_state.ready && light_state.rail_on ? "unknown" : lit ? "on" : "off"));
        cJSON *setting = cJSON_CreateObject();
        char color[8];
        snprintf(color, sizeof(color), "#%06lX", (unsigned long)pixel->rgb);
        cJSON_AddStringToObject(setting, "color", color);
        cJSON_AddNumberToObject(setting, "brightness", pixel->brightness);
        cJSON_AddBoolToObject(setting, "on", pixel->on);
        cJSON_AddItemToArray(settings, setting);
    }
    audio_snapshot_t audio_state;
    audio_get_snapshot(&audio_state);
    cJSON *cloud = cJSON_AddObjectToObject(root, "cloud");
    cJSON_AddBoolToObject(cloud, "configured", cloud_monitor_is_configured());
    cJSON_AddBoolToObject(cloud, "online", cloud_monitor_is_online());
    voice_chat_snapshot_t voice_state;
    voice_chat_get_snapshot(&voice_state);
    cJSON *voice = cJSON_AddObjectToObject(root, "voice");
    cJSON_AddNumberToObject(voice, "pending", voice_state.pending);
    cJSON_AddBoolToObject(voice, "sending", voice_state.sending);
    cJSON_AddBoolToObject(voice, "storage_error", voice_state.storage_error);
    cJSON_AddBoolToObject(voice, "s8_enabled", voice_state.s8_enabled);
    cJSON_AddBoolToObject(voice, "setup_active", network_setup_active());
    cJSON *audio = cJSON_AddObjectToObject(root, "audio");
    cJSON_AddBoolToObject(audio, "ready", audio_state.ready && light_state.ready);
    cJSON_AddNumberToObject(audio, "sample_rate_hz", AUDIO_SAMPLE_RATE);
    cJSON *speaker = cJSON_AddObjectToObject(root, "speaker");
    cJSON_AddStringToObject(speaker, "state", !audio_state.ready || audio_state.speaker_error != ESP_OK ? "unavailable" : audio_state.speaker_playing ? "playing" : "idle");
    cJSON_AddNumberToObject(speaker, "volume", audio_state.volume);
    if (audio_state.speaker_error != ESP_OK) cJSON_AddStringToObject(speaker, "error", esp_err_to_name(audio_state.speaker_error));
    cJSON *microphone = cJSON_AddObjectToObject(root, "microphone");
    cJSON_AddStringToObject(microphone, "state", !audio_state.ready || audio_state.microphone_error != ESP_OK ? "unavailable" : audio_state.microphone_active ? "active" : "idle");
    cJSON_AddNumberToObject(microphone, "rms", audio_state.rms);
    cJSON_AddBoolToObject(microphone, "vad", audio_state.vad);
    if (audio_state.microphone_error != ESP_OK) cJSON_AddStringToObject(microphone, "error", esp_err_to_name(audio_state.microphone_error));

    cJSON *cpu = cJSON_AddObjectToObject(root, "cpu");
    cJSON_AddNumberToObject(cpu, "frequency_mhz", cpu_frequency_mhz);
    cJSON *usage = cJSON_AddArrayToObject(cpu, "usage_percent");
    for (int core = 0; core < portNUM_PROCESSORS; core++) cJSON_AddItemToArray(usage, cJSON_CreateNumber(cpu_usage[core]));
    if (has_temperature) cJSON_AddNumberToObject(cpu, "temperature_c", temperature_c);

    cJSON *memory = cJSON_AddObjectToObject(root, "memory");
    cJSON *internal = cJSON_AddObjectToObject(memory, "internal");
    cJSON_AddNumberToObject(internal, "total_bytes", internal_total);
    cJSON_AddNumberToObject(internal, "free_bytes", internal_free);
    cJSON_AddNumberToObject(internal, "minimum_free_bytes", internal_minimum);
    cJSON_AddNumberToObject(internal, "largest_block_bytes", internal_largest);
    cJSON *psram = cJSON_AddObjectToObject(memory, "psram");
    cJSON_AddNumberToObject(psram, "total_bytes", psram_total);
    cJSON_AddNumberToObject(psram, "free_bytes", psram_free);
    cJSON_AddNumberToObject(psram, "largest_block_bytes", psram_largest);

    cJSON *storage = cJSON_AddObjectToObject(root, "storage");
    cJSON *flash = cJSON_AddObjectToObject(storage, "flash");
    cJSON_AddStringToObject(flash, "state", flash_total_bytes > 0 ? "ready" : "unknown");
    cJSON_AddNumberToObject(flash, "total_bytes", flash_total_bytes);
    cJSON_AddNumberToObject(flash, "unallocated_bytes", flash_unallocated_bytes);
    cJSON_AddNumberToObject(flash, "read_bytes_per_second", read_bps);
    cJSON_AddNumberToObject(flash, "write_bytes_per_second", write_bps);
    cJSON_AddNumberToObject(flash, "erase_bytes_per_second", erase_bps);
    cJSON *partitions = cJSON_AddArrayToObject(storage, "partitions");
    for (size_t index = 0; index < partition_snapshot_count; index++) {
        const esp_partition_t *partition = &partition_snapshots[index];
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "label", partition->label);
        cJSON_AddNumberToObject(entry, "address", partition->address);
        cJSON_AddNumberToObject(entry, "size_bytes", partition->size);
        cJSON_AddNumberToObject(entry, "type", partition->type);
        cJSON_AddNumberToObject(entry, "subtype", partition->subtype);
        cJSON_AddItemToArray(partitions, entry);
    }
    cJSON *app = cJSON_AddObjectToObject(storage, "app");
    cJSON_AddStringToObject(app, "state", app_partition_bytes > 0 ? "running" : "unknown");
    cJSON_AddNumberToObject(app, "partition_bytes", app_partition_bytes);
    cJSON_AddNumberToObject(app, "image_bytes", app_image_bytes);
    cJSON_AddNumberToObject(app, "free_bytes", app_partition_bytes > app_image_bytes ? app_partition_bytes - app_image_bytes : 0);
    cJSON *nvs = cJSON_AddObjectToObject(storage, "nvs");
    const esp_partition_t *nvs_partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "nvs");
    cJSON_AddStringToObject(nvs, "state", nvs_stats_ready ? "ready" : "unavailable");
    cJSON_AddNumberToObject(nvs, "total_bytes", nvs_partition == NULL ? 0 : nvs_partition->size);
    cJSON_AddNumberToObject(nvs, "used_entries", current_nvs_stats.used_entries);
    cJSON_AddNumberToObject(nvs, "free_entries", current_nvs_stats.free_entries);
    cJSON_AddNumberToObject(nvs, "total_entries", current_nvs_stats.total_entries);

    cJSON *power = cJSON_AddObjectToObject(root, "power");
    if (has_battery) cJSON_AddNumberToObject(power, "battery_mv", battery_mv);
    cJSON_AddBoolToObject(power, "external_power", external_power);
    if (external_power) cJSON_AddBoolToObject(power, "charging", charging);

    char *line = cJSON_PrintUnformatted(root);
    if (line != NULL) {
        send_line(line);
        cJSON_free(line);
    }
    cJSON_Delete(root);
}

static void configure_board_gpio(void)
{
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_8, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_9, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_10, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_12, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_13, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_14, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_15, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_42, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_5, 0));

    const gpio_config_t safe_outputs = {
        .pin_bit_mask = (1ULL << GPIO_NUM_8) | (1ULL << GPIO_NUM_9) | (1ULL << GPIO_NUM_10) |
                        (1ULL << GPIO_NUM_12) | (1ULL << GPIO_NUM_13) | (1ULL << GPIO_NUM_14) |
                        (1ULL << GPIO_NUM_15) | (1ULL << GPIO_NUM_42) | (1ULL << GPIO_NUM_5),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&safe_outputs));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_8, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_42, 0));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_NUM_5, 0));

    const gpio_config_t sense_inputs = {
        .pin_bit_mask = (1ULL << GPIO_NUM_40) | (1ULL << GPIO_NUM_39),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&sense_inputs));

    const gpio_config_t microphone_data_input = {
        .pin_bit_mask = 1ULL << GPIO_NUM_11,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&microphone_data_input));

    uint64_t key_mask = (1ULL << encoder_a_gpio) | (1ULL << encoder_b_gpio) | (1ULL << encoder_button_gpio);
    for (size_t index = 0; index < KEY_COUNT; index++) key_mask |= 1ULL << key_gpios[index];
    const gpio_config_t key_inputs = {
        .pin_bit_mask = key_mask,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&key_inputs));
}

static void configure_system_sensors(void)
{
    ESP_ERROR_CHECK(esp_flash_get_size(NULL, &flash_total_bytes));
    collect_partition_info();

    adc_oneshot_unit_init_cfg_t adc_init = {.unit_id = ADC_UNIT_1, .ulp_mode = ADC_ULP_MODE_DISABLE};
    if (adc_oneshot_new_unit(&adc_init, &adc_handle) == ESP_OK) {
        adc_oneshot_chan_cfg_t channel_config = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
        if (adc_oneshot_config_channel(adc_handle, ADC_CHANNEL_3, &channel_config) == ESP_OK) {
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
            adc_cali_curve_fitting_config_t calibration = {
                .unit_id = ADC_UNIT_1, .chan = ADC_CHANNEL_3, .atten = ADC_ATTEN_DB_12,
                .bitwidth = ADC_BITWIDTH_DEFAULT,
            };
            adc_cali_ready = adc_cali_create_scheme_curve_fitting(&calibration, &adc_cali_handle) == ESP_OK;
#endif
        }
    }

    temperature_sensor_config_t temperature_config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(10, 50);
    if (temperature_sensor_install(&temperature_config, &temperature_handle) == ESP_OK) {
        (void)temperature_sensor_enable(temperature_handle);
    } else {
        temperature_handle = NULL;
    }
}

static bool read_pressed(gpio_num_t pin)
{
    return gpio_get_level(pin) == 0;
}

static void update_debounced_input(debounced_input_t *input, bool pressed, int64_t now_us,
                                   const char *source, const char *key)
{
    if (pressed != input->raw_pressed) {
        input->raw_pressed = pressed;
        input->changed_at_us = now_us;
    }
    if (input->stable_pressed != input->raw_pressed && now_us - input->changed_at_us >= DEBOUNCE_US) {
        input->stable_pressed = input->raw_pressed;
        send_input_event(source, input->stable_pressed ? "down" : "up", key, 0);
        if (key != NULL && strcmp(source, "key") == 0) voice_chat_key(atoi(key + 1) - 1, input->stable_pressed);
        else if (strcmp(source, "encoder") == 0) voice_chat_key(8, input->stable_pressed);
    }
}

static void input_task(void *arg)
{
    (void)arg;
    debounced_input_t keys[KEY_COUNT] = {0};
    debounced_input_t encoder_button = {0};
    static const int8_t quadrature[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
    int previous_ab = ((gpio_get_level(encoder_a_gpio) != 0) << 1) | (gpio_get_level(encoder_b_gpio) != 0);
    int detent = 0;
    char key_name[4];

    for (size_t index = 0; index < KEY_COUNT; index++) {
        keys[index].raw_pressed = read_pressed(key_gpios[index]);
        keys[index].stable_pressed = keys[index].raw_pressed;
    }
    encoder_button.raw_pressed = read_pressed(encoder_button_gpio);
    encoder_button.stable_pressed = encoder_button.raw_pressed;
    while (true) {
        const int64_t now_us = esp_timer_get_time();
        for (size_t index = 0; index < KEY_COUNT; index++) {
            snprintf(key_name, sizeof(key_name), "S%u", (unsigned)(index + 1));
            update_debounced_input(&keys[index], read_pressed(key_gpios[index]), now_us, "key", key_name);
        }
        update_debounced_input(&encoder_button, read_pressed(encoder_button_gpio), now_us, "encoder", NULL);
        const int current_ab = ((gpio_get_level(encoder_a_gpio) != 0) << 1) | (gpio_get_level(encoder_b_gpio) != 0);
        detent += quadrature[(previous_ab << 2) | current_ab];
        previous_ab = current_ab;
        if (detent >= 4) {
            send_input_event("encoder", "rotate", NULL, 1);
            voice_chat_rotate(1);
            detent = 0;
        } else if (detent <= -4) {
            send_input_event("encoder", "rotate", NULL, -1);
            voice_chat_rotate(-1);
            detent = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(INPUT_SCAN_MS));
    }
}

static void send_wifi_failure(const char *action, const char *stage, esp_err_t error, esp_err_t recovery_error)
{
    char message[256];
    if (recovery_error == ESP_OK) {
        snprintf(message, sizeof(message), "%s：%s (0x%X)。", stage, esp_err_to_name(error), (unsigned)error);
    } else {
        snprintf(message, sizeof(message), "%s：%s (0x%X)。恢复 Wi-Fi 失败：%s (0x%X)。",
                 stage, esp_err_to_name(error), (unsigned)error,
                 esp_err_to_name(recovery_error), (unsigned)recovery_error);
    }
    send_result(action, false, message);
}

static esp_err_t pause_wifi_for_command(void)
{
    portENTER_CRITICAL(&state_lock);
    wifi_reconfiguring = true;
    portEXIT_CRITICAL(&state_lock);

    if ((xEventGroupGetBits(wifi_lifecycle_events) & WIFI_STOPPED_BIT) != 0) return ESP_OK;

    const esp_err_t result = esp_wifi_stop();
    if (result != ESP_OK) return result;

    // Drain earlier connection/disconnection callbacks before changing configuration.
    const EventBits_t bits = xEventGroupWaitBits(wifi_lifecycle_events, WIFI_STOPPED_BIT,
                                               pdFALSE, pdTRUE, pdMS_TO_TICKS(WIFI_TRANSITION_TIMEOUT_MS));
    return (bits & WIFI_STOPPED_BIT) != 0 ? ESP_OK : ESP_ERR_TIMEOUT;
}

static esp_err_t resume_wifi_after_command(void)
{
    xEventGroupClearBits(wifi_lifecycle_events, WIFI_STARTED_BIT | WIFI_STOPPED_BIT);
    esp_err_t result = esp_wifi_start();
    if (result == ESP_OK) {
        // Keep automatic connection paused until the START callback has finished.
        const EventBits_t bits = xEventGroupWaitBits(wifi_lifecycle_events, WIFI_STARTED_BIT,
                                                   pdFALSE, pdTRUE, pdMS_TO_TICKS(WIFI_TRANSITION_TIMEOUT_MS));
        if ((bits & WIFI_STARTED_BIT) == 0) result = ESP_ERR_TIMEOUT;
    } else {
        xEventGroupSetBits(wifi_lifecycle_events, WIFI_STOPPED_BIT);
    }

    portENTER_CRITICAL(&state_lock);
    wifi_reconfiguring = false;
    const bool connect = result == ESP_OK && wifi_configured;
    strlcpy(wifi_state, connect ? "connecting" : "disconnected", sizeof(wifi_state));
    portEXIT_CRITICAL(&state_lock);

    if (connect) {
        result = esp_wifi_connect();
        if (result != ESP_OK) {
            portENTER_CRITICAL(&state_lock);
            strlcpy(wifi_state, "disconnected", sizeof(wifi_state));
            portEXIT_CRITICAL(&state_lock);
        }
    }
    return result;
}

static void run_wifi_command(const char *action, wifi_config_t *config, const char *success_message)
{
    const esp_err_t pause_result = pause_wifi_for_command();
    if (pause_result != ESP_OK) {
        portENTER_CRITICAL(&state_lock);
        wifi_reconfiguring = false;
        portEXIT_CRITICAL(&state_lock);
        send_wifi_failure(action, "暂停 Wi-Fi 连接失败", pause_result, ESP_OK);
        return;
    }

    esp_err_t set_result = ESP_OK;
    if (config != NULL) {
        set_result = esp_wifi_set_config(WIFI_IF_STA, config);
        memset(config->sta.password, 0, sizeof(config->sta.password));
    }
    if (set_result == ESP_OK) {
        portENTER_CRITICAL(&state_lock);
        if (config != NULL) {
            wifi_configured = config->sta.ssid[0] != 0;
            memcpy(wifi_ssid, config->sta.ssid, sizeof(config->sta.ssid));
            wifi_ssid[sizeof(config->sta.ssid)] = '\0';
        }
        wifi_retries = 0;
        wifi_disconnect_code = 0;
        portEXIT_CRITICAL(&state_lock);
    } else {
        wifi_config_t remaining_config = {0};
        if (esp_wifi_get_config(WIFI_IF_STA, &remaining_config) == ESP_OK) {
            portENTER_CRITICAL(&state_lock);
            wifi_configured = remaining_config.sta.ssid[0] != 0;
            memcpy(wifi_ssid, remaining_config.sta.ssid, sizeof(remaining_config.sta.ssid));
            wifi_ssid[sizeof(remaining_config.sta.ssid)] = '\0';
            portEXIT_CRITICAL(&state_lock);
        }
        memset(remaining_config.sta.password, 0, sizeof(remaining_config.sta.password));
    }

    // Also resume the station with its remaining configuration if saving failed.
    const esp_err_t resume_result = resume_wifi_after_command();
    if (set_result != ESP_OK) {
        const char *stage = strcmp(action, "wifi.clear") == 0 ? "删除 Wi-Fi 配置失败" : "保存 Wi-Fi 配置失败";
        send_wifi_failure(action, stage, set_result, resume_result);
    } else if (resume_result != ESP_OK) {
        const char *stage = config == NULL ? "启动已保存的 Wi-Fi 连接失败"
            : config->sta.ssid[0] != 0 ? "配置已保存，但恢复 Wi-Fi 连接失败" : "配置已删除，但恢复 Wi-Fi 失败";
        send_wifi_failure(action, stage, resume_result, ESP_OK);
    } else {
        send_result(action, true, success_message);
    }
}

static bool command_integer(const cJSON *command, const char *name, int maximum, int *value)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(command, name);
    if (!cJSON_IsNumber(item) || !(item->valuedouble >= 0 && item->valuedouble <= maximum) || item->valuedouble != item->valueint) return false;
    *value = item->valueint;
    return true;
}

static bool handle_light_command(const cJSON *command, const char *action)
{
    const bool single = strcmp(action, "lights.pixel.set") == 0;
    const bool all = strcmp(action, "lights.all.set") == 0;
    const bool off = strcmp(action, "lights.off") == 0;
    const bool indicator = strcmp(action, "lights.status.set") == 0;
    const bool power = strcmp(action, "peripherals.power.set") == 0;
    if (!single && !all && !off && !indicator && !power) return false;
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(command, "request_id");
    if (id && (!cJSON_IsString(id) || strlen(id->valuestring) == 0 || strlen(id->valuestring) > 64)) {
        send_result(action, false, "request_id 必须为 1～64 字节字符串。");
        return true;
    }
    const char *request_id = id ? id->valuestring : NULL;
    esp_err_t result = ESP_ERR_INVALID_ARG;
    int brightness = 0;
    if (off) {
        result = lights_off();
    } else if (power) {
        const cJSON *on = cJSON_GetObjectItemCaseSensitive(command, "on");
        if (cJSON_IsBool(on)) result = lights_set_power(cJSON_IsTrue(on));
    } else if (command_integer(command, "brightness", 100, &brightness)) {
        if (indicator) {
            result = lights_set_status(brightness);
        } else {
            const cJSON *color = cJSON_GetObjectItemCaseSensitive(command, "color");
            const cJSON *on = cJSON_GetObjectItemCaseSensitive(command, "on");
            int index = 0;
            bool valid_color = cJSON_IsString(color) && strlen(color->valuestring) == 7 && color->valuestring[0] == '#';
            if (valid_color) {
                for (int i = 1; i < 7; i++) {
                    const char ch = color->valuestring[i];
                    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F'))) valid_color = false;
                }
            }
            if (valid_color && cJSON_IsBool(on) && (!single || command_integer(command, "index", LIGHT_PIXEL_COUNT - 1, &index))) {
                const light_pixel_t pixel = {
                    .rgb = strtoul(color->valuestring + 1, NULL, 16), .brightness = brightness, .on = cJSON_IsTrue(on),
                };
                result = single ? lights_set_pixel(index, &pixel) : lights_set_all(&pixel);
            }
        }
    }
    // Broadcast the committed state before acknowledging the command.
    emit_status();
    const char *message = result == ESP_OK ? "设置已应用。" : result == ESP_ERR_INVALID_ARG ? "参数无效：灯珠编号 0～4，颜色 #RRGGBB，亮度整数 0～100，开关为布尔值。" : esp_err_to_name(result);
    send_result_with_id(action, result == ESP_OK, message, request_id);
    return true;
}

static bool handle_audio_command(const cJSON *command, const char *action)
{
    const bool microphone = strcmp(action, "audio.microphone.set") == 0;
    const bool test = strcmp(action, "audio.speaker.test") == 0;
    const bool stop = strcmp(action, "audio.speaker.stop") == 0;
    if (!microphone && !test && !stop) return false;
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(command, "request_id");
    if (id && (!cJSON_IsString(id) || strlen(id->valuestring) == 0 || strlen(id->valuestring) > 64)) {
        send_result(action, false, "request_id 必须为 1～64 字节字符串。");
        return true;
    }
    esp_err_t result = ESP_ERR_INVALID_ARG;
    if (microphone) {
        const cJSON *on = cJSON_GetObjectItemCaseSensitive(command, "on");
        if (cJSON_IsBool(on)) result = audio_set_microphone(cJSON_IsTrue(on));
    } else if (test) {
        int volume = 10;
        if (!cJSON_HasObjectItem(command, "volume") || command_integer(command, "volume", AUDIO_TEST_VOLUME_MAX, &volume)) {
            result = audio_play_test(volume);
        }
    } else {
        result = audio_stop_speaker();
    }
    emit_status();
    const char *message = result == ESP_OK ? (test ? "测试音已开始，约 1 秒后自动停止。" : "音频设置已应用。")
        : result == ESP_ERR_INVALID_ARG ? "参数无效：采集开关为布尔值，测试音量为 1～20 的整数。" : esp_err_to_name(result);
    send_result_with_id(action, result == ESP_OK, message, id ? id->valuestring : NULL);
    return true;
}

static void handle_command(const char *line)
{
    cJSON *command = cJSON_Parse(line);
    if (command != NULL && voice_chat_receive(command)) { cJSON_Delete(command); return; }
    if (command == NULL) return;
    const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(command, "protocol");
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(command, "action");
    if (!cJSON_IsNumber(protocol) || protocol->valueint != PROTOCOL_VERSION || !cJSON_IsString(action)) {
        clear_command_password(command);
        cJSON_Delete(command);
        return;
    }

    if (strcmp(action->valuestring, "hello.get") == 0) {
        emit_hello();
        emit_status();
    } else if (strcmp(action->valuestring, "status.get") == 0) {
        emit_status();
    } else if (handle_light_command(command, action->valuestring)) {
        // Light commands share the serialized USB/BLE command task.
    } else if (handle_audio_command(command, action->valuestring)) {
        // Audio commands use the same command task and shared-power gate.
    } else if (strcmp(action->valuestring, "wifi.configure") == 0) {
        const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(command, "ssid");
        cJSON *password = cJSON_GetObjectItemCaseSensitive(command, "password");
        const size_t ssid_len = cJSON_IsString(ssid) ? strlen(ssid->valuestring) : 0;
        const size_t password_len = cJSON_IsString(password) ? strlen(password->valuestring) : 0;
        if (ssid_len == 0 || ssid_len > 32 || !cJSON_IsString(password) || password_len > 63 || (password_len > 0 && password_len < 8)) {
            send_result("wifi.configure", false, "SSID 或密码长度无效。开放网络可留空密码。");
        } else {
            wifi_config_t config = {0};
            memcpy(config.sta.ssid, ssid->valuestring, ssid_len);
            memcpy(config.sta.password, password->valuestring, password_len);
            config.sta.threshold.authmode = password_len == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
            config.sta.pmf_cfg.capable = true;
            config.sta.pmf_cfg.required = false;
            run_wifi_command("wifi.configure", &config, "已保存配置，正在连接。密码保存在开发板 NVS 中。");
            memset(config.sta.password, 0, sizeof(config.sta.password));
        }
    } else if (strcmp(action->valuestring, "wifi.clear") == 0) {
        wifi_config_t empty_config = {0};
        run_wifi_command("wifi.clear", &empty_config, "已删除板端 Wi-Fi 配置。");
    } else if (strcmp(action->valuestring, "wifi.connect_saved") == 0) {
        portENTER_CRITICAL(&state_lock);
        const bool configured = wifi_configured;
        portEXIT_CRITICAL(&state_lock);
        if (!configured) {
            send_result("wifi.connect_saved", false, "开发板没有已保存的 Wi-Fi 配置。");
        } else {
            run_wifi_command("wifi.connect_saved", NULL, "正在使用开发板已保存的配置连接 Wi-Fi。");
        }
    } else if (strcmp(action->valuestring, "cloud.configure") == 0) {
        const cJSON *gateway = cJSON_GetObjectItemCaseSensitive(command, "gateway");
        const cJSON *device = cJSON_GetObjectItemCaseSensitive(command, "device");
        const cJSON *token = cJSON_GetObjectItemCaseSensitive(command, "token");
        const bool ok = cJSON_IsString(gateway) && cJSON_IsString(device) && cJSON_IsString(token) &&
            cloud_monitor_configure(gateway->valuestring, device->valuestring, token->valuestring);
        send_result("cloud.configure", ok, ok ? "云端 WSS 配置已保存，开发板将在 Wi-Fi 可用时连接。" : "云端 WSS 配置无效或保存失败。");
        clear_command_secret(command, "token");
    } else if (strcmp(action->valuestring, "cloud.clear") == 0) {
        const bool ok = cloud_monitor_clear();
        send_result("cloud.clear", ok, ok ? "云端 WSS 配置已清除。" : "云端 WSS 配置清除失败。");
    }
    clear_command_password(command);
    cJSON_Delete(command);
}

static int ble_command_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *context, void *arg)
{
    (void)attr_handle;
    (void)arg;
    if (context->op != BLE_GATT_ACCESS_OP_WRITE_CHR || context->om == NULL) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    portENTER_CRITICAL(&state_lock);
    const bool encrypted = ble_conn_handle == conn_handle && ble_link_encrypted;
    portEXIT_CRITICAL(&state_lock);
    if (!encrypted) return BLE_ATT_ERR_INSUFFICIENT_ENC;

    const uint16_t packet_length = OS_MBUF_PKTLEN(context->om);
    if (packet_length > 256) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    char chunk[256];
    uint16_t chunk_length = 0;
    const int rc = ble_hs_mbuf_to_flat(context->om, chunk, sizeof(chunk), &chunk_length);
    if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

    for (uint16_t index = 0; index < chunk_length; index++) {
        const char byte = chunk[index];
        if (byte == '\r') continue;
        if (byte == '\n') {
            if (ble_command_length > 0) {
                ble_command_buffer[ble_command_length] = '\0';
                if (board_command_queue == NULL || xQueueSend(board_command_queue, ble_command_buffer, 0) != pdTRUE) {
                    memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
                    ble_command_length = 0;
                    memset(chunk, 0, sizeof(chunk));
                    return BLE_ATT_ERR_INSUFFICIENT_RES;
                }
            }
            memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
            ble_command_length = 0;
        } else {
            if (ble_command_length >= sizeof(ble_command_buffer) - 1) {
                memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
                ble_command_length = 0;
                memset(chunk, 0, sizeof(chunk));
                return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
            }
            ble_command_buffer[ble_command_length++] = byte;
        }
    }
    memset(chunk, 0, sizeof(chunk));
    return 0;
}

static void usb_task(void *arg)
{
    (void)arg;
    char chunk[USB_LINE_MAX];
    char line[USB_LINE_MAX];
    char ble_line[USB_LINE_MAX];
    size_t line_length = 0;
    while (true) {
        if (board_command_queue != NULL && xQueueReceive(board_command_queue, ble_line, 0) == pdTRUE) {
            handle_command(ble_line);
            memset(ble_line, 0, sizeof(ble_line));
        }
        const int read = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(20));
        if (read <= 0) continue;
        for (int index = 0; index < read; index++) {
            const char ch = chunk[index];
            if (ch == '\n') {
                line[line_length] = '\0';
                handle_command(line);
                memset(line, 0, line_length + 1);
                line_length = 0;
            } else if (ch != '\r') {
                if (line_length + 1 < sizeof(line)) line[line_length++] = ch;
                else {
                    memset(line, 0, sizeof(line));
                    line_length = 0;
                }
            }
        }
        memset(chunk, 0, (size_t)read);
    }
}

static void send_microphone_event(const char *action, const audio_snapshot_t *audio)
{
    char line[224];
    snprintf(line, sizeof(line),
             "{\"type\":\"event\",\"protocol\":%d,\"source\":\"microphone\",\"action\":\"%s\",\"rms\":%u,\"vad\":%s,\"uptime_ms\":%lld}",
             PROTOCOL_VERSION, action, audio->rms, audio->vad ? "true" : "false", (long long)(esp_timer_get_time() / 1000));
    send_line(line);
}

static void status_task(void *arg)
{
    (void)arg;
    int64_t last_status_us = -STATUS_INTERVAL_MS * 1000LL;
    int64_t last_level_us = 0;
    bool previous_vad = false;
    bool previous_active = false;
    while (true) {
        const int64_t now = esp_timer_get_time();
        audio_snapshot_t audio;
        audio_get_snapshot(&audio);
        if (audio.vad != previous_vad) send_microphone_event(audio.vad ? "vad_start" : "vad_end", &audio);
        if (audio.microphone_active && (!previous_active || now - last_level_us >= 250000)) {
            send_microphone_event("level", &audio);
            last_level_us = now;
        } else if (!audio.microphone_active && previous_active) {
            send_microphone_event("level", &audio);
        }
        previous_vad = audio.vad;
        previous_active = audio.microphone_active;
        if (now - last_status_us >= STATUS_INTERVAL_MS * 1000LL) {
            emit_status();
            last_status_us = now;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) xEventGroupSetBits(wifi_lifecycle_events, WIFI_DISCONNECTED_BIT);
    portENTER_CRITICAL(&state_lock);
    const bool reconfiguring = wifi_reconfiguring;
    portEXIT_CRITICAL(&state_lock);
    if (reconfiguring && !(event_base == WIFI_EVENT &&
        (event_id == WIFI_EVENT_STA_START || event_id == WIFI_EVENT_STA_STOP))) return;

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        if (reconfiguring) {
            xEventGroupClearBits(wifi_lifecycle_events, WIFI_STOPPED_BIT);
            xEventGroupSetBits(wifi_lifecycle_events, WIFI_STARTED_BIT);
            return;
        }
        wifi_config_t config = {0};
        const bool have_config = esp_wifi_get_config(WIFI_IF_STA, &config) == ESP_OK && config.sta.ssid[0] != 0;
        portENTER_CRITICAL(&state_lock);
        wifi_configured = have_config;
        if (have_config) {
            memcpy(wifi_ssid, config.sta.ssid, sizeof(config.sta.ssid));
            wifi_ssid[sizeof(config.sta.ssid)] = '\0';
            strlcpy(wifi_state, "connecting", sizeof(wifi_state));
        } else {
            wifi_ssid[0] = '\0';
            strlcpy(wifi_state, "disconnected", sizeof(wifi_state));
        }
        portEXIT_CRITICAL(&state_lock);
        memset(config.sta.password, 0, sizeof(config.sta.password));
        if (have_config) (void)esp_wifi_connect();
        xEventGroupClearBits(wifi_lifecycle_events, WIFI_STOPPED_BIT);
        xEventGroupSetBits(wifi_lifecycle_events, WIFI_STARTED_BIT);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_STOP) {
        portENTER_CRITICAL(&state_lock);
        wifi_rssi = 0;
        wifi_channel = 0;
        wifi_ip[0] = wifi_netmask[0] = wifi_gateway[0] = wifi_dns[0] = '\0';
        strlcpy(wifi_state, "disconnected", sizeof(wifi_state));
        portEXIT_CRITICAL(&state_lock);
        xEventGroupClearBits(wifi_lifecycle_events, WIFI_STARTED_BIT);
        xEventGroupSetBits(wifi_lifecycle_events, WIFI_STOPPED_BIT);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        wifi_ap_record_t ap = {0};
        (void)esp_wifi_sta_get_ap_info(&ap);
        portENTER_CRITICAL(&state_lock);
        strlcpy(wifi_state, "connected", sizeof(wifi_state));
        wifi_rssi = ap.rssi;
        wifi_channel = ap.primary;
        portEXIT_CRITICAL(&state_lock);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *event = event_data;
        portENTER_CRITICAL(&state_lock);
        wifi_disconnect_code = event == NULL ? 0 : event->reason;
        wifi_disconnects++;
        wifi_rssi = 0;
        wifi_channel = 0;
        wifi_ip[0] = wifi_netmask[0] = wifi_gateway[0] = wifi_dns[0] = '\0';
        if (wifi_configured) {
            wifi_retries++;
            strlcpy(wifi_state, "connecting", sizeof(wifi_state));
        } else {
            strlcpy(wifi_state, "disconnected", sizeof(wifi_state));
        }
        const bool reconnect = wifi_configured && !wifi_reconfiguring;
        portEXIT_CRITICAL(&state_lock);
        if (reconnect) (void)esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = event_data;
        esp_netif_ip_info_t info = {0};
        if (wifi_netif != NULL && esp_netif_get_ip_info(wifi_netif, &info) == ESP_OK && info.ip.addr != 0) {
            char ip[16], netmask[16], gateway[16], dns[16] = {0};
            esp_ip4addr_ntoa(&info.ip, ip, sizeof(ip));
            esp_ip4addr_ntoa(&info.netmask, netmask, sizeof(netmask));
            esp_ip4addr_ntoa(&info.gw, gateway, sizeof(gateway));
            esp_netif_dns_info_t public_dns = {0};
            public_dns.ip.type = ESP_IPADDR_TYPE_V4;
            public_dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("1.1.1.1");
            (void)esp_netif_set_dns_info(wifi_netif, ESP_NETIF_DNS_MAIN, &public_dns);
            public_dns.ip.u_addr.ip4.addr = esp_ip4addr_aton("8.8.8.8");
            (void)esp_netif_set_dns_info(wifi_netif, ESP_NETIF_DNS_BACKUP, &public_dns);
            esp_netif_dns_info_t dns_info = {0};
            if (esp_netif_get_dns_info(wifi_netif, ESP_NETIF_DNS_MAIN, &dns_info) == ESP_OK) {
                esp_ip4addr_ntoa((const esp_ip4_addr_t *)&dns_info.ip.u_addr.ip4, dns, sizeof(dns));
            }
            portENTER_CRITICAL(&state_lock);
            strlcpy(wifi_state, "connected", sizeof(wifi_state));
            strlcpy(wifi_ip, ip, sizeof(wifi_ip));
            strlcpy(wifi_netmask, netmask, sizeof(wifi_netmask));
            strlcpy(wifi_gateway, gateway, sizeof(wifi_gateway));
            strlcpy(wifi_dns, dns, sizeof(wifi_dns));
            portEXIT_CRITICAL(&state_lock);
            if (!sntp_started) {
                const esp_err_t sntp_result = esp_netif_sntp_start();
                if (sntp_result == ESP_OK) {
                    sntp_started = true;
                    ESP_LOGI(TAG, "SNTP time synchronization started");
                } else {
                    ESP_LOGW(TAG, "Unable to start SNTP: %s", esp_err_to_name(sntp_result));
                }
            }
        }
        (void)event;
    }
}

static void init_wifi_monitor(void)
{
    wifi_lifecycle_events = xEventGroupCreate();
    ESP_ERROR_CHECK(wifi_lifecycle_events != NULL ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_netif = esp_netif_create_default_wifi_sta();
    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("ntp.aliyun.com");
    sntp_config.start = false;
    sntp_config.sync_cb = time_sync_notification_cb;
    const esp_err_t sntp_result = esp_netif_sntp_init(&sntp_config);
    if (sntp_result != ESP_OK) ESP_LOGE(TAG, "SNTP initialization failed: %s", esp_err_to_name(sntp_result));
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void time_sync_notification_cb(struct timeval *tv)
{
    (void)tv;
    ESP_LOGI(TAG, "SNTP time synchronized");
}

static void start_advertising(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    const char name[] = "EasyInput";
    fields.name = (uint8_t *)name;
    fields.name_len = sizeof(name) - 1;
    fields.name_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGW(TAG, "BLE advertising data setup failed: %d", rc);
        return;
    }
    struct ble_gap_adv_params parameters = {0};
    parameters.conn_mode = BLE_GAP_CONN_MODE_UND;
    parameters.disc_mode = BLE_GAP_DISC_MODE_GEN;
    extern int ble_gap_event_handler(struct ble_gap_event *event, void *context);
    rc = ble_gap_adv_start(ble_address_type, NULL, BLE_HS_FOREVER, &parameters, ble_gap_event_handler, NULL);
    if (rc != 0) {
        ESP_LOGW(TAG, "BLE advertising start failed: %d", rc);
        return;
    }
    portENTER_CRITICAL(&state_lock);
    strlcpy(ble_state, "advertising", sizeof(ble_state));
    ble_peers = 0;
    portEXIT_CRITICAL(&state_lock);
}

int ble_gap_event_handler(struct ble_gap_event *event, void *context)
{
    (void)context;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            portENTER_CRITICAL(&state_lock);
            strlcpy(ble_state, "connected", sizeof(ble_state));
            ble_peers = 1;
            ble_conn_handle = event->connect.conn_handle;
            ble_link_encrypted = false;
            ble_notifications_enabled = false;
            ble_connection_generation++;
            portEXIT_CRITICAL(&state_lock);
            memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
            ble_command_length = 0;
            const int rc = ble_gap_security_initiate(event->connect.conn_handle);
            if (rc != 0) {
                ESP_LOGW(TAG, "BLE security negotiation failed to start: %d", rc);
                (void)ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            }
        } else {
            start_advertising();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        portENTER_CRITICAL(&state_lock);
        ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        ble_link_encrypted = false;
        ble_notifications_enabled = false;
        ble_connection_generation++;
        ble_peers = 0;
        portEXIT_CRITICAL(&state_lock);
        memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
        ble_command_length = 0;
        start_advertising();
        break;
    case BLE_GAP_EVENT_ENC_CHANGE:
        if (event->enc_change.status == 0) {
            portENTER_CRITICAL(&state_lock);
            ble_link_encrypted = true;
            const bool notifications_enabled = ble_notifications_enabled;
            portEXIT_CRITICAL(&state_lock);
            if (notifications_enabled) queue_ble_hello();
        } else {
            ESP_LOGW(TAG, "BLE link encryption failed: %d", event->enc_change.status);
            (void)ble_gap_terminate(event->enc_change.conn_handle, BLE_ERR_AUTH_FAIL);
        }
        break;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == ble_tx_value_handle) {
            portENTER_CRITICAL(&state_lock);
            ble_notifications_enabled = event->subscribe.cur_notify != 0;
            const bool ready = ble_notifications_enabled && ble_link_encrypted;
            portEXIT_CRITICAL(&state_lock);
            if (ready) queue_ble_hello();
        }
        break;
    case BLE_GAP_EVENT_NOTIFY_TX:
        if (event->notify_tx.attr_handle == ble_tx_value_handle) {
            portENTER_CRITICAL(&state_lock);
            ble_notify_tx_status = event->notify_tx.status;
            portEXIT_CRITICAL(&state_lock);
            if (ble_notify_tx_done != NULL) xSemaphoreGive(ble_notify_tx_done);
        }
        break;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        start_advertising();
        break;
    default:
        break;
    }
    return 0;
}

static void ble_sync_handler(void)
{
    const int rc = ble_hs_id_infer_auto(0, &ble_address_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE address setup failed: %d", rc);
        portENTER_CRITICAL(&state_lock);
        strlcpy(ble_state, "disabled", sizeof(ble_state));
        portEXIT_CRITICAL(&state_lock);
        return;
    }
    start_advertising();
}

static void ble_reset_handler(int reason)
{
    ESP_LOGW(TAG, "BLE host reset: %d", reason);
    portENTER_CRITICAL(&state_lock);
    strlcpy(ble_state, "disconnected", sizeof(ble_state));
    ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    ble_link_encrypted = false;
    ble_notifications_enabled = false;
    ble_connection_generation++;
    ble_peers = 0;
    portEXIT_CRITICAL(&state_lock);
    memset(ble_command_buffer, 0, sizeof(ble_command_buffer));
    ble_command_length = 0;
}

static void ble_host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void init_ble_monitor(void)
{
    const esp_err_t result = nimble_port_init();
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "NimBLE init failed: %s", esp_err_to_name(result));
        portENTER_CRITICAL(&state_lock);
        strlcpy(ble_state, "disabled", sizeof(ble_state));
        portEXIT_CRITICAL(&state_lock);
        return;
    }
    ble_hs_cfg.sync_cb = ble_sync_handler;
    ble_hs_cfg.reset_cb = ble_reset_handler;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set("EasyInput"));
    int rc = ble_gatts_count_cfg(ble_services);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE GATT service count failed: %d", rc);
        strlcpy(ble_state, "disabled", sizeof(ble_state));
        return;
    }
    rc = ble_gatts_add_svcs(ble_services);
    if (rc != 0) {
        ESP_LOGE(TAG, "BLE GATT service registration failed: %d", rc);
        strlcpy(ble_state, "disabled", sizeof(ble_state));
        return;
    }
    ble_store_config_init();
    nimble_port_freertos_init(ble_host_task);
}

static bool save_phone_config(const char *ssid, const char *password, const char *pairing_code)
{
    // Reuse a saved cloud identity. A new board needs its initial pairing code once.
    if (pairing_code[0] && !cloud_monitor_configure("wss://easy.leige.online", "easyinput-v2", pairing_code)) return false;
    if (!cloud_monitor_is_configured()) return false;
    portENTER_CRITICAL(&state_lock); wifi_reconfiguring = true; portEXIT_CRITICAL(&state_lock);
    xEventGroupClearBits(wifi_lifecycle_events, WIFI_DISCONNECTED_BIT);
    const esp_err_t disconnect = esp_wifi_disconnect();
    if (disconnect == ESP_OK) {
        const EventBits_t bits = xEventGroupWaitBits(wifi_lifecycle_events, WIFI_DISCONNECTED_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(3000));
        if (!(bits & WIFI_DISCONNECTED_BIT)) {
            portENTER_CRITICAL(&state_lock); wifi_reconfiguring = false; portEXIT_CRITICAL(&state_lock);
            (void)esp_wifi_connect(); return false;
        }
    }
    wifi_config_t config = {0};
    strlcpy((char *)config.sta.ssid, ssid, sizeof(config.sta.ssid));
    // A 32-byte SSID has no trailing NUL in wifi_config_t.
    if (strlen(ssid) == sizeof(config.sta.ssid)) memcpy(config.sta.ssid, ssid, sizeof(config.sta.ssid));
    strlcpy((char *)config.sta.password, password, sizeof(config.sta.password));
    const esp_err_t rc = esp_wifi_set_config(WIFI_IF_STA, &config);
    memset(config.sta.password, 0, sizeof(config.sta.password));
    portENTER_CRITICAL(&state_lock);
    wifi_reconfiguring = false;
    if (rc == ESP_OK) {
        strlcpy(wifi_ssid, ssid, sizeof(wifi_ssid)); wifi_configured = true;
        strlcpy(wifi_state, "connecting", sizeof(wifi_state));
        wifi_ip[0] = wifi_netmask[0] = wifi_gateway[0] = wifi_dns[0] = '\0';
    }
    portEXIT_CRITICAL(&state_lock);
    if (rc != ESP_OK) (void)esp_wifi_connect();
    return rc == ESP_OK;
}

static void reconnect_phone_wifi(void)
{
    // Keep the temporary AP available while the station joins the saved network.
    // Event callbacks handle reconnecting after the disconnect acknowledgement.
    (void)esp_wifi_connect();
}

static bool init_nvs_safely(void)
{
    esp_err_t result = nvs_flash_init();
    if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGE(TAG, "NVS needs maintenance; refusing to erase stored data: %s", esp_err_to_name(result));
        return false;
    }
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "NVS init failed: %s", esp_err_to_name(result));
        return false;
    }
    return true;
}

void app_main(void)
{
    configure_board_gpio();
    const esp_err_t light_result = lights_init();
    if (light_result != ESP_OK) ESP_LOGE(TAG, "Light control init failed: %s", esp_err_to_name(light_result));
    if (!init_nvs_safely()) return;

    usb_tx_mutex = xSemaphoreCreateMutex();
    if (usb_tx_mutex == NULL) {
        ESP_LOGE(TAG, "USB transmit mutex allocation failed");
        return;
    }
    ble_tx_queue = xQueueCreate(BLE_TX_QUEUE_DEPTH, sizeof(ble_tx_frame_t));
    board_command_queue = xQueueCreate(4, USB_LINE_MAX);
    ble_notify_tx_done = xSemaphoreCreateBinary();
    if (ble_tx_queue == NULL || board_command_queue == NULL || ble_notify_tx_done == NULL) {
        ESP_LOGE(TAG, "BLE transport queue allocation failed");
        return;
    }
    usb_serial_jtag_driver_config_t usb_config = {.rx_buffer_size = 512, .tx_buffer_size = 4096};
    const esp_err_t usb_result = usb_serial_jtag_driver_install(&usb_config);
    if (usb_result != ESP_OK) {
        ESP_LOGE(TAG, "USB Serial/JTAG init failed: %s", esp_err_to_name(usb_result));
        return;
    }

    configure_system_sensors();
    const esp_err_t audio_result = audio_init();
    if (audio_result != ESP_OK) ESP_LOGE(TAG, "Audio init failed: %s", esp_err_to_name(audio_result));
    init_wifi_monitor();
    init_wifi_websocket();
    cloud_monitor_init();
    network_setup_init(wifi_websocket_server, save_phone_config, reconnect_phone_wifi);
    voice_chat_init(send_chat_line);
    init_ble_monitor();
    xTaskCreateWithCaps(ble_tx_task, "ble_tx", 4096, NULL, 6, NULL,
                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    emit_hello();
    xTaskCreate(input_task, "input_scan", 4096, NULL, 8, NULL);
    xTaskCreate(usb_task, "usb_command", 12288, NULL, 6, NULL);
    xTaskCreateWithCaps(status_task, "status_stream", 6144, NULL, 5, NULL,
                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_LOGI(TAG, "Worker memory: internal free=%u largest=%u, PSRAM free=%u largest=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
    ESP_LOGI(TAG, "EasyInput monitor firmware started; lights/audio controllable, shared rail off until requested");
}
