#include "cloud.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

#define CLOUD_LINE_MAX 4096
#define CLOUD_COMMAND_MAX 512
#define CLOUD_EVENT_QUEUE_DEPTH 16
#define CLOUD_RECONNECT_MS 5000
#define LEGACY_GATEWAY "wss://easyinput-gateway.jsy96.workers.dev"
#define CURRENT_GATEWAY "wss://easy.leige.online"

static const char *TAG = "easyinput_cloud";
static esp_websocket_client_handle_t client;
static SemaphoreHandle_t state_lock;
static SemaphoreHandle_t send_lock;
static SemaphoreHandle_t outbound_lock;
static QueueHandle_t event_queue;
static TaskHandle_t sender_task;
static char *pending_status;
static bool online;
static char gateway[192];
static char device_id[65];
static char token[129];

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

static bool send_text(const char *text, size_t length, TickType_t timeout)
{
    if (send_lock == NULL || xSemaphoreTake(send_lock, pdMS_TO_TICKS(1000)) != pdTRUE) return false;
    esp_websocket_client_handle_t current = client;
    const bool sent = current != NULL && esp_websocket_client_is_connected(current) &&
        esp_websocket_client_send_text(current, text, length, timeout) >= 0;
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
    char *line = calloc(1, CLOUD_COMMAND_MAX);
    if (line == NULL) return;
    memcpy(line, payload, length);
    cJSON *command = cJSON_Parse(line);
    const cJSON *protocol = command ? cJSON_GetObjectItemCaseSensitive(command, "protocol") : NULL;
    const cJSON *type = command ? cJSON_GetObjectItemCaseSensitive(command, "type") : NULL;
    const cJSON *action = command ? cJSON_GetObjectItemCaseSensitive(command, "action") : NULL;
    const bool allowed = cJSON_IsNumber(protocol) && protocol->valueint == 2 && cJSON_IsString(type) &&
        strcmp(type->valuestring, "command") == 0 && cJSON_IsString(action) &&
        (strcmp(action->valuestring, "hello.get") == 0 || strcmp(action->valuestring, "status.get") == 0);
    if (allowed) {
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
        ESP_LOGW(TAG, "cloud WSS disconnected");
    } else if (event_id == WEBSOCKET_EVENT_DATA && event != NULL && event->op_code == 0x1) {
        cloud_message(event->data_ptr, event->data_len);
    } else if (event_id == WEBSOCKET_EVENT_ERROR) {
        ESP_LOGW(TAG, "cloud WSS error");
    }
}

static void cloud_task(void *arg)
{
    (void)arg;
    while (true) {
        if (configured() && client == NULL) {
            char url[512];
            snprintf(url, sizeof(url), "%s/ws?device=%s&role=board&token=%s", gateway, device_id, token);
            esp_websocket_client_config_t config = {
                .uri = url,
                .crt_bundle_attach = esp_crt_bundle_attach,
                .buffer_size = CLOUD_LINE_MAX,
                .task_stack = 6144,
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
        vTaskDelay(pdMS_TO_TICKS(5000));
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

        char *frame = NULL;
        xSemaphoreTake(outbound_lock, portMAX_DELAY);
        const bool have_event = uxQueueMessagesWaiting(event_queue) > 0;
        if ((prefer_status && pending_status != NULL) || !have_event) {
            frame = pending_status;
            pending_status = NULL;
            prefer_status = false;
        } else {
            (void)xQueueReceive(event_queue, &frame, 0);
            prefer_status = true;
        }
        xSemaphoreGive(outbound_lock);

        if (frame != NULL) {
            (void)send_text(frame, strlen(frame), pdMS_TO_TICKS(1000));
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
    load_config();
    xTaskCreate(cloud_task, "cloud_wss", 7168, NULL, 4, NULL);
    xTaskCreate(cloud_sender_task, "cloud_send", 4096, NULL, 5, &sender_task);
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
    char *copy = malloc(length + 2);
    if (copy == NULL) return;
    memcpy(copy, line, length);
    copy[length] = '\n';
    copy[length + 1] = '\0';

    char *discarded = NULL;
    bool queued = false;
    if (xSemaphoreTake(outbound_lock, pdMS_TO_TICKS(50)) != pdTRUE) {
        free(copy);
        return;
    }
    static const char status_prefix[] = "{\"type\":\"status\"";
    if (strncmp(line, status_prefix, sizeof(status_prefix) - 1) == 0) {
        discarded = pending_status;
        pending_status = copy;
        queued = true;
    } else if (xQueueSend(event_queue, &copy, 0) != pdTRUE) {
        (void)xQueueReceive(event_queue, &discarded, 0);
        queued = xQueueSend(event_queue, &copy, 0) == pdTRUE;
        if (!queued) free(copy);
    } else {
        queued = true;
    }
    xSemaphoreGive(outbound_lock);
    free(discarded);
    if (queued) (void)xTaskNotifyGive(sender_task);
}

bool cloud_monitor_is_online(void)
{
    if (state_lock == NULL) return false;
    xSemaphoreTake(state_lock, portMAX_DELAY); const bool value = online; xSemaphoreGive(state_lock);
    return value;
}
