#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
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
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_netif.h"
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
#include "host/ble_uuid.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#define PROTOCOL_VERSION 2
#define KEY_COUNT 8
#define DEBOUNCE_US 25000
#define INPUT_SCAN_MS 10
#define STATUS_INTERVAL_MS 1000
#define USB_LINE_MAX 512
#define PARTITION_COUNT_MAX 24
#define BLE_TX_QUEUE_DEPTH 16
#define WIFI_STARTED_BIT (1U << 0)
#define WIFI_STOPPED_BIT (1U << 1)
#define WIFI_TRANSITION_TIMEOUT_MS 3000

static const char *TAG = "easyinput";
static const gpio_num_t key_gpios[KEY_COUNT] = {2, 47, 38, 41, 1, 6, 7, 48};
static const gpio_num_t encoder_a_gpio = 17;
static const gpio_num_t encoder_b_gpio = 16;
static const gpio_num_t encoder_button_gpio = 18;

static SemaphoreHandle_t usb_tx_mutex;
static SemaphoreHandle_t ble_notify_tx_done;
static QueueHandle_t ble_tx_queue;
static QueueHandle_t ble_command_queue;
static EventGroupHandle_t wifi_lifecycle_events;
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
    if (usb_tx_mutex != NULL && xSemaphoreTake(usb_tx_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        usb_serial_jtag_write_bytes(line, strlen(line), pdMS_TO_TICKS(80));
        usb_serial_jtag_write_bytes("\n", 1, pdMS_TO_TICKS(80));
        xSemaphoreGive(usb_tx_mutex);
    }
    queue_ble_line(line);
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

static void send_result(const char *action, bool ok, const char *message)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return;
    cJSON_AddStringToObject(root, "type", "result");
    cJSON_AddNumberToObject(root, "protocol", PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "action", action);
    cJSON_AddBoolToObject(root, "ok", ok);
    if (message != NULL) cJSON_AddStringToObject(root, "message", message);
    char *line = cJSON_PrintUnformatted(root);
    if (line != NULL) {
        send_line(line);
        cJSON_free(line);
    }
    cJSON_Delete(root);
}

static void clear_command_password(cJSON *command)
{
    cJSON *password = cJSON_GetObjectItemCaseSensitive(command, "password");
    if (cJSON_IsString(password) && password->valuestring != NULL) {
        volatile char *secret = password->valuestring;
        for (size_t index = 0; secret[index] != '\0'; index++) secret[index] = '\0';
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
    cJSON *peripherals = cJSON_AddObjectToObject(root, "peripherals");
    cJSON_AddStringToObject(peripherals, "shared_rail", "off");
    cJSON *lights = cJSON_AddObjectToObject(root, "lights");
    cJSON_AddStringToObject(lights, "status_led", "off");
    cJSON *pixels = cJSON_AddArrayToObject(lights, "pixels");
    for (int index = 0; index < 5; index++) cJSON_AddItemToArray(pixels, cJSON_CreateString("off"));
    cJSON *speaker = cJSON_AddObjectToObject(root, "speaker");
    cJSON_AddStringToObject(speaker, "state", "unavailable");
    cJSON *microphone = cJSON_AddObjectToObject(root, "microphone");
    cJSON_AddStringToObject(microphone, "state", "unavailable");
    cJSON_AddNumberToObject(microphone, "rms", 0);
    cJSON_AddBoolToObject(microphone, "vad", false);

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
            detent = 0;
        } else if (detent <= -4) {
            send_input_event("encoder", "rotate", NULL, -1);
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

static void handle_command(const char *line)
{
    cJSON *command = cJSON_Parse(line);
    if (command == NULL) return;
    const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(command, "protocol");
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(command, "action");
    if (!cJSON_IsNumber(protocol) || protocol->valueint != PROTOCOL_VERSION || !cJSON_IsString(action)) {
        clear_command_password(command);
        cJSON_Delete(command);
        return;
    }

    if (strcmp(action->valuestring, "status.get") == 0) {
        emit_status();
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
    if (packet_length > USB_LINE_MAX - 1) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    char chunk[USB_LINE_MAX];
    uint16_t chunk_length = 0;
    const int rc = ble_hs_mbuf_to_flat(context->om, chunk, sizeof(chunk), &chunk_length);
    if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

    for (uint16_t index = 0; index < chunk_length; index++) {
        const char byte = chunk[index];
        if (byte == '\r') continue;
        if (byte == '\n') {
            if (ble_command_length > 0) {
                ble_command_buffer[ble_command_length] = '\0';
                if (ble_command_queue == NULL || xQueueSend(ble_command_queue, ble_command_buffer, 0) != pdTRUE) {
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
        if (ble_command_queue != NULL && xQueueReceive(ble_command_queue, ble_line, 0) == pdTRUE) {
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

static void status_task(void *arg)
{
    (void)arg;
    while (true) {
        emit_status();
        vTaskDelay(pdMS_TO_TICKS(STATUS_INTERVAL_MS));
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
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
    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&config));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
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
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 0;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
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
    nimble_port_freertos_init(ble_host_task);
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
    if (!init_nvs_safely()) return;

    usb_tx_mutex = xSemaphoreCreateMutex();
    if (usb_tx_mutex == NULL) {
        ESP_LOGE(TAG, "USB transmit mutex allocation failed");
        return;
    }
    ble_tx_queue = xQueueCreate(BLE_TX_QUEUE_DEPTH, sizeof(ble_tx_frame_t));
    ble_command_queue = xQueueCreate(4, USB_LINE_MAX);
    ble_notify_tx_done = xSemaphoreCreateBinary();
    if (ble_tx_queue == NULL || ble_command_queue == NULL || ble_notify_tx_done == NULL) {
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
    init_wifi_monitor();
    init_ble_monitor();
    xTaskCreate(ble_tx_task, "ble_tx", 4096, NULL, 6, NULL);
    emit_hello();
    xTaskCreate(input_task, "input_scan", 4096, NULL, 8, NULL);
    xTaskCreate(usb_task, "usb_command", 6144, NULL, 6, NULL);
    xTaskCreate(status_task, "status_stream", 6144, NULL, 5, NULL);
    ESP_LOGI(TAG, "EasyInput monitor firmware started; GPIO8 shared rail stays off pending board qualification");
}
