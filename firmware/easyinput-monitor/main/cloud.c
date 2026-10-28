#include "cloud.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "voice_chat.h"

#define CLOUD_LINE_MAX 4096
#define CLOUD_COMMAND_MAX 2048
#define CLOUD_EVENT_QUEUE_DEPTH 16
#define CLOUD_BINARY_QUEUE_DEPTH 32
#define CLOUD_BINARY_SEND_TIMEOUT_MS 1000
#define CLOUD_RECONNECT_MS 5000
#define CHAT_PROTOCOL 2
#define LEGACY_GATEWAY "wss://easyinput-gateway.jsy96.workers.dev"
#define CURRENT_GATEWAY "wss://easy.leige.online"

static const char *TAG = "easyinput_cloud";
static esp_websocket_client_handle_t client;
static SemaphoreHandle_t state_lock;
static SemaphoreHandle_t send_lock;
static SemaphoreHandle_t outbound_lock;
static QueueHandle_t event_queue;
static QueueHandle_t binary_queue;
static TaskHandle_t sender_task;
static char *pending_status;
static bool online;
static char gateway[192];
static char device_id[65];
static char token[129];
static int64_t last_presence_us;
static cloud_monitor_stats_t monitor_stats;

typedef struct {
    size_t length;
    uint8_t data[];
} cloud_binary_frame_t;

static void record_send_result(const char *line, bool sent)
{
    const bool realtime_start = strstr(line, "\"op\":\"realtime.start\"") != NULL;
    const bool realtime_chunk = strstr(line, "\"op\":\"realtime.chunk\"") != NULL;
    if (state_lock == NULL) return;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (sent) monitor_stats.sent++;
    else monitor_stats.failed++;
    if (realtime_start) {
        if (sent) monitor_stats.realtime_starts_sent++;
        else monitor_stats.realtime_starts_failed++;
    }
    if (realtime_chunk) {
        if (sent) monitor_stats.realtime_chunks_sent++;
        else monitor_stats.realtime_chunks_failed++;
    }
    xSemaphoreGive(state_lock);
}

static void record_drop(const char *line)
{
    const bool realtime_chunk = strstr(line, "\"op\":\"realtime.chunk\"") != NULL;
    if (state_lock == NULL) return;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    monitor_stats.dropped++;
    if (realtime_chunk) monitor_stats.realtime_chunks_dropped++;
    xSemaphoreGive(state_lock);
}

static bool valid_text(const char *value, size_t min_length, size_t max_length)
{
    if (value == NULL) return false;
    const size_t length = strlen(value);
    if (length < min_length || length > max_length) return false;
    for (size_t index = 0; index < length; index++) {
        const char ch = value[index];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || strchr("._-:/?=&", ch) != NULL)) return false;
    }
    return true;
}

static bool configured(void) { return gateway[0] != '\0' && device_id[0] != '\0' && token[0] != '\0'; }
static bool system_time_ready(void)
{
    const time_t now = time(NULL);
    // A cold-boot clock can make current TLS certificates look not yet valid.
    return now >= 1735689600; // 2025-01-01T00:00:00Z
}

static bool send_text(const char *text, size_t length, TickType_t timeout)
{
    if (send_lock == NULL || xSemaphoreTake(send_lock, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
    esp_websocket_client_handle_t current = client;
    const bool sent = current != NULL && esp_websocket_client_is_connected(current) &&
        esp_websocket_client_send_text(current, text, length, timeout) >= 0;
    xSemaphoreGive(send_lock);
    return sent;
}

static bool send_text_immediate(const char *text, size_t length)
{
    if (send_lock == NULL || xSemaphoreTake(send_lock, pdMS_TO_TICKS(20)) != pdTRUE) return false;
    esp_websocket_client_handle_t current = client;
    const bool sent = current != NULL && esp_websocket_client_is_connected(current) &&
        esp_websocket_client_send_text(current, text, length, pdMS_TO_TICKS(50)) >= 0;
    xSemaphoreGive(send_lock);
    return sent;
}

static bool send_binary(const uint8_t *data, size_t length, TickType_t timeout)
{
    if (send_lock == NULL || xSemaphoreTake(send_lock, pdMS_TO_TICKS(10)) != pdTRUE) return false;
    esp_websocket_client_handle_t current = client;
    const bool sent = current != NULL && esp_websocket_client_is_connected(current) &&
        esp_websocket_client_send_bin(current, (const char *)data, length, timeout) >= 0;
    xSemaphoreGive(send_lock);
    return sent;
}

static void stop_client(void)
{
    if (send_lock != NULL) xSemaphoreTake(send_lock, portMAX_DELAY);
    esp_websocket_client_handle_t current = client;
    client = NULL;
    if (current != NULL) {
        (void)esp_websocket_client_stop(current);
        (void)esp_websocket_client_destroy(current);
    }
    if (send_lock != NULL) xSemaphoreGive(send_lock);
}

static void load_config(void)
{
    nvs_handle_t handle;
    if (nvs_open("cloud", NVS_READONLY, &handle) != ESP_OK) return;
    size_t length = sizeof(gateway); (void)nvs_get_str(handle, "gateway", gateway, &length);
    length = sizeof(device_id); (void)nvs_get_str(handle, "device", device_id, &length);
    length = sizeof(token); (void)nvs_get_str(handle, "token", token, &length);
    nvs_close(handle);

    if (strcmp(gateway, LEGACY_GATEWAY) == 0) {
        nvs_handle_t write_handle;
        if (nvs_open("cloud", NVS_READWRITE, &write_handle) == ESP_OK) {
            if (nvs_set_str(write_handle, "gateway", CURRENT_GATEWAY) == ESP_OK && nvs_commit(write_handle) == ESP_OK) {
                strlcpy(gateway, CURRENT_GATEWAY, sizeof(gateway));
                ESP_LOGI(TAG, "migrated cloud gateway to custom domain");
            }
            nvs_close(write_handle);
        }
    }
}

static void cloud_message(const char *payload, size_t length)
{
    if (length >= CLOUD_COMMAND_MAX) return;
    char *line = heap_caps_calloc(1, CLOUD_COMMAND_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (line == NULL) return;
    memcpy(line, payload, length);
    cJSON *command = cJSON_Parse(line);
    const cJSON *protocol = command ? cJSON_GetObjectItemCaseSensitive(command, "protocol") : NULL;
    const cJSON *type = command ? cJSON_GetObjectItemCaseSensitive(command, "type") : NULL;
    const cJSON *action = command ? cJSON_GetObjectItemCaseSensitive(command, "action") : NULL;
    const bool allowed = cJSON_IsNumber(protocol) && protocol->valueint == 2 && cJSON_IsString(type) &&
        strcmp(type->valuestring, "command") == 0 && cJSON_IsString(action) &&
        (strcmp(action->valuestring, "hello.get") == 0 || strcmp(action->valuestring, "status.get") == 0);
    const bool chat = command && cJSON_IsString(type) && strcmp(type->valuestring, "chat") == 0 &&
        cJSON_IsNumber(protocol) && protocol->valueint == CHAT_PROTOCOL;
    if (chat) {
        // Audio windows can contain twenty-four chunks followed by an acknowledgement;
        // keep chat frames out of the small USB/BLE command queue.
        (void)voice_chat_receive(command);
    } else if (allowed) {
        extern bool cloud_monitor_queue_command(const char *line);
        (void)cloud_monitor_queue_command(line);
    }
    cJSON_Delete(command);
    free(line);
}

static void cloud_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)arg; (void)base;
    esp_websocket_event_data_t *event = event_data;
    if (event_id == WEBSOCKET_EVENT_CONNECTED) {
        ESP_LOGI(TAG, "cloud WSS connected");
        const char *hello = "{\"type\":\"command\",\"protocol\":2,\"action\":\"hello.get\"}\n";
        (void)send_text(hello, strlen(hello), pdMS_TO_TICKS(1000));
        xSemaphoreTake(state_lock, portMAX_DELAY); online = true; xSemaphoreGive(state_lock);
        if (sender_task != NULL) (void)xTaskNotifyGive(sender_task);
    } else if (event_id == WEBSOCKET_EVENT_DISCONNECTED) {
        xSemaphoreTake(state_lock, portMAX_DELAY); online = false; xSemaphoreGive(state_lock);
        // Free queued frames while the link is down: status copies pin internal
        // RAM that the TLS reconnect handshake needs.
        if (outbound_lock != NULL) {
            xSemaphoreTake(outbound_lock, portMAX_DELAY);
            char *stale = NULL;
            while (event_queue != NULL && xQueueReceive(event_queue, &stale, 0) == pdTRUE) {
                record_drop(stale);
                free(stale);
            }
            cloud_binary_frame_t *stale_binary = NULL;
            unsigned stale_binary_count = 0;
            while (binary_queue != NULL && xQueueReceive(binary_queue, &stale_binary, 0) == pdTRUE) {
                free(stale_binary);
                stale_binary_count++;
            }
            if (stale_binary_count > 0) {
                xSemaphoreTake(state_lock, portMAX_DELAY);
                monitor_stats.realtime_chunks_dropped += stale_binary_count;
                xSemaphoreGive(state_lock);
            }
            xSemaphoreGive(outbound_lock);
        }
        ESP_LOGW(TAG, "cloud WSS disconnected");
    } else if (event_id == WEBSOCKET_EVENT_DATA && event != NULL && (event->op_code == 0x1 || event->op_code == 0x0)) {
        static char incoming[CLOUD_COMMAND_MAX];
        static size_t received;
        if (event->payload_offset == 0) received = 0;
        if (event->payload_len > 0 && event->payload_len < CLOUD_COMMAND_MAX && event->payload_offset == received && received + event->data_len < sizeof(incoming)) {
            memcpy(incoming + received, event->data_ptr, event->data_len);
            received += event->data_len;
            if (received == event->payload_len) { incoming[received] = '\0'; cloud_message(incoming, received); received = 0; }
        } else received = 0;
    } else if (event_id == WEBSOCKET_EVENT_ERROR) {
        ESP_LOGW(TAG, "cloud WSS error");
    }
}

static void cloud_task(void *arg)
{
    (void)arg;
    while (true) {
        if (configured() && system_time_ready() && client == NULL) {
            char url[512];
            snprintf(url, sizeof(url), "%s/ws?device=%s&role=board&token=%s", gateway, device_id, token);
            esp_websocket_client_config_t config = {
                .uri = url,
                .crt_bundle_attach = esp_crt_bundle_attach,
                .buffer_size = 2048,
                .task_stack = 6144,
                .network_timeout_ms = 10000,
                .reconnect_timeout_ms = CLOUD_RECONNECT_MS,
            };
            client = esp_websocket_client_init(&config);
            if (client != NULL) {
                esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, cloud_event_handler, NULL);
                if (esp_websocket_client_start(client) != ESP_OK) {
                    esp_websocket_client_destroy(client); client = NULL;
                }
            }
        }
        xSemaphoreTake(state_lock, portMAX_DELAY);
        const bool connected = online;
        xSemaphoreGive(state_lock);
        const int64_t now = esp_timer_get_time();
        if (connected && (last_presence_us == 0 || now - last_presence_us >= 3000000)) {
            voice_chat_snapshot_t voice_state;
            voice_chat_get_snapshot(&voice_state);
            // This low-rate state heartbeat repairs a lost realtime start/stop frame.
            char presence[160];
            const int length = snprintf(presence, sizeof(presence),
                "{\"type\":\"status\",\"protocol\":2,\"uptime_ms\":%lld,\"realtime_active\":%s}",
                (long long)(now / 1000), voice_state.realtime_active ? "true" : "false");
            if (length > 0 && (size_t)length < sizeof(presence) && send_text(presence, (size_t)length, pdMS_TO_TICKS(1000))) {
                if (last_presence_us == 0) ESP_LOGI(TAG, "cloud presence heartbeat active");
                last_presence_us = now;
            } else {
                ESP_LOGW(TAG, "cloud presence heartbeat failed");
                last_presence_us = 0;
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

static void cloud_sender_task(void *arg)
{
    (void)arg;
    bool prefer_status = false;
    while (true) {
        xSemaphoreTake(state_lock, portMAX_DELAY);
        const bool ready = online;
        xSemaphoreGive(state_lock);
        if (!ready) {
            (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));
            continue;
        }

        cloud_binary_frame_t *binary_frame = NULL;
        char *frame = NULL;
        xSemaphoreTake(outbound_lock, portMAX_DELAY);
        const bool have_binary = xQueueReceive(binary_queue, &binary_frame, 0) == pdTRUE;
        if (!have_binary) {
            const bool have_event = uxQueueMessagesWaiting(event_queue) > 0;
            if ((prefer_status && pending_status != NULL) || !have_event) {
                frame = pending_status;
                pending_status = NULL;
                prefer_status = false;
            } else {
                (void)xQueueReceive(event_queue, &frame, 0);
                prefer_status = true;
            }
        }
        xSemaphoreGive(outbound_lock);

        if (binary_frame != NULL) {
            // Realtime audio is latency-sensitive: a failed frame is dropped,
            // and the generous timeout keeps transient Wi-Fi stalls from
            // tripping the library's abort-on-error behavior.
            const bool sent = send_binary(binary_frame->data, binary_frame->length,
                                          pdMS_TO_TICKS(CLOUD_BINARY_SEND_TIMEOUT_MS));
            if (state_lock != NULL) {
                xSemaphoreTake(state_lock, portMAX_DELAY);
                if (sent) monitor_stats.realtime_chunks_sent++;
                else monitor_stats.realtime_chunks_failed++;
                xSemaphoreGive(state_lock);
            }
            free(binary_frame);
            continue;
        }
        if (frame != NULL) {
            const bool sent = send_text(frame, strlen(frame), pdMS_TO_TICKS(1000));
            record_send_result(frame, sent);
            free(frame);
            continue;
        }
        (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
}

void cloud_monitor_init(void)
{
    state_lock = xSemaphoreCreateMutex();
    send_lock = xSemaphoreCreateMutex();
    outbound_lock = xSemaphoreCreateMutex();
    event_queue = xQueueCreate(CLOUD_EVENT_QUEUE_DEPTH, sizeof(char *));
    binary_queue = xQueueCreateWithCaps(CLOUD_BINARY_QUEUE_DEPTH, sizeof(cloud_binary_frame_t *),
                                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    load_config();
    if (xTaskCreateWithCaps(cloud_task, "cloud_wss", 7168, NULL, 4, NULL,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS ||
        xTaskCreateWithCaps(cloud_sender_task, "cloud_send", 4096, NULL, 5, &sender_task,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        ESP_LOGE(TAG, "Unable to create cloud worker tasks");
    }
}

bool cloud_monitor_configure(const char *gateway_url, const char *device, const char *pairing_token)
{
    if (!valid_text(gateway_url, 12, sizeof(gateway) - 1) || strncmp(gateway_url, "wss://", 6) != 0 ||
        !valid_text(device, 3, sizeof(device_id) - 1) || !valid_text(pairing_token, 16, sizeof(token) - 1)) return false;
    nvs_handle_t handle;
    if (nvs_open("cloud", NVS_READWRITE, &handle) != ESP_OK) return false;
    const esp_err_t result = nvs_set_str(handle, "gateway", gateway_url) == ESP_OK &&
        nvs_set_str(handle, "device", device) == ESP_OK && nvs_set_str(handle, "token", pairing_token) == ESP_OK && nvs_commit(handle) == ESP_OK ? ESP_OK : ESP_FAIL;
    nvs_close(handle);
    if (result != ESP_OK) return false;
    stop_client();
    strlcpy(gateway, gateway_url, sizeof(gateway));
    strlcpy(device_id, device, sizeof(device_id));
    strlcpy(token, pairing_token, sizeof(token));
    return true;
}

bool cloud_monitor_clear(void)
{
    nvs_handle_t handle;
    if (nvs_open("cloud", NVS_READWRITE, &handle) != ESP_OK) return false;
    const esp_err_t result = nvs_erase_all(handle) == ESP_OK && nvs_commit(handle) == ESP_OK ? ESP_OK : ESP_FAIL;
    nvs_close(handle);
    if (result != ESP_OK) return false;
    stop_client();
    gateway[0] = device_id[0] = token[0] = '\0';
    return true;
}

void cloud_monitor_send(const char *line)
{
    if (line == NULL || outbound_lock == NULL || event_queue == NULL || sender_task == NULL) return;
    const size_t length = strlen(line);
    if (length >= CLOUD_LINE_MAX) return;
    if (state_lock != NULL) {
        xSemaphoreTake(state_lock, portMAX_DELAY);
        const bool connected_now = online;
        xSemaphoreGive(state_lock);
        if (!connected_now) {
            record_drop(line);
            return;
        }
    }
    char *copy = heap_caps_malloc(length + 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (copy == NULL) {
        record_drop(line);
        return;
    }
    memcpy(copy, line, length);
    copy[length] = '\n';
    copy[length + 1] = '\0';

    char *discarded = NULL;
    bool queued = false;
    if (xSemaphoreTake(outbound_lock, pdMS_TO_TICKS(50)) != pdTRUE) {
        free(copy);
        record_drop(line);
        return;
    }
    static const char status_prefix[] = "{\"type\":\"status\"";
    if (strncmp(line, status_prefix, sizeof(status_prefix) - 1) == 0) {
        // Full telemetry stays on USB/BLE. The cloud path only needs the small
        // heartbeat sent by cloud_task, which avoids overloading the TLS socket.
        discarded = copy;
    } else if (xQueueSend(event_queue, &copy, 0) != pdTRUE) {
        (void)xQueueReceive(event_queue, &discarded, 0);
        queued = xQueueSend(event_queue, &copy, 0) == pdTRUE;
        if (!queued) {
            free(copy);
            record_drop(line);
        }
    } else {
        queued = true;
    }
    xSemaphoreGive(outbound_lock);
    if (discarded != NULL) record_drop(discarded);
    free(discarded);
    if (queued) (void)xTaskNotifyGive(sender_task);
}

bool cloud_monitor_send_immediate(const char *line)
{
    const bool sent = line != NULL && send_text_immediate(line, strlen(line));
    if (line != NULL) record_send_result(line, sent);
    return sent;
}

bool cloud_monitor_send_binary(const uint8_t *data, size_t length)
{
    // Realtime audio frames are handed to the cloud sender task (single writer),
    // so a stalled or reconnecting link drops frames instead of aborting it.
    if (data == NULL || length == 0 || length > 4096 || binary_queue == NULL || sender_task == NULL) return false;
    cloud_binary_frame_t *frame = heap_caps_malloc(sizeof(cloud_binary_frame_t) + length,
                                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (frame == NULL) return false;
    frame->length = length;
    memcpy(frame->data, data, length);
    if (xQueueSend(binary_queue, &frame, 0) != pdTRUE) {
        free(frame);
        return false;
    }
    (void)xTaskNotifyGive(sender_task);
    return true;
}

void cloud_monitor_get_stats(cloud_monitor_stats_t *stats)
{
    if (stats == NULL) return;
    if (state_lock == NULL) {
        memset(stats, 0, sizeof(*stats));
        return;
    }
    xSemaphoreTake(state_lock, portMAX_DELAY);
    *stats = monitor_stats;
    xSemaphoreGive(state_lock);
}

bool cloud_monitor_is_online(void)
{
    if (state_lock == NULL) return false;
    xSemaphoreTake(state_lock, portMAX_DELAY); const bool value = online; xSemaphoreGive(state_lock);
    return value;
}

bool cloud_monitor_is_configured(void) { return configured(); }
