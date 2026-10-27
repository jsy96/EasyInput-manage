#include "network_setup.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "cloud.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static esp_netif_t *ap_netif;
static network_setup_save_t save_config;
static void (*reconnect_station)(void);
static QueueHandle_t begin_queue;
static SemaphoreHandle_t gate;
static int64_t deadline, reconnect_at;
static char nonce[33], ap_name[33];
static bool available;
static portMUX_TYPE state_lock = portMUX_INITIALIZER_UNLOCKED;
extern const char setup_html_start[] asm("_binary_setup_html_start");

bool network_setup_active(void)
{
    portENTER_CRITICAL(&state_lock);
    const bool active = deadline > esp_timer_get_time();
    portEXIT_CRITICAL(&state_lock);
    return active;
}
static bool local_request(httpd_req_t *req)
{
    if (!network_setup_active() || !ap_netif) return false;
    struct sockaddr_in address = {0}; socklen_t length = sizeof(address);
    esp_netif_ip_info_t ip;
    return getsockname(httpd_req_to_sockfd(req), (struct sockaddr *)&address, &length) == 0 &&
        esp_netif_get_ip_info(ap_netif, &ip) == ESP_OK && address.sin_addr.s_addr == ip.ip.addr;
}
static esp_err_t index_handler(httpd_req_t *req)
{
    if (!local_request(req)) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
    xSemaphoreTake(gate, portMAX_DELAY);
    const char *marker = strstr(setup_html_start, "__TOKEN__");
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t rc = marker ? httpd_resp_send_chunk(req, setup_html_start, marker - setup_html_start) : ESP_FAIL;
    if (rc == ESP_OK) rc = httpd_resp_sendstr_chunk(req, nonce);
    if (rc == ESP_OK) rc = httpd_resp_sendstr_chunk(req, marker + strlen("__TOKEN__"));
    if (rc == ESP_OK) rc = httpd_resp_send_chunk(req, NULL, 0);
    xSemaphoreGive(gate); return rc;
}
static esp_err_t status_handler(httpd_req_t *req)
{
    if (!local_request(req)) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
    char response[180];
    snprintf(response, sizeof(response), "{\"name\":\"%s\",\"configured\":%s,\"online\":%s}", ap_name,
        cloud_monitor_is_configured() ? "true" : "false", cloud_monitor_is_online() ? "true" : "false");
    httpd_resp_set_type(req, "application/json"); httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_sendstr(req, response);
}
static esp_err_t save_handler(httpd_req_t *req)
{
    if (!local_request(req)) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
    char body[768] = {0}, token[40] = {0};
    if (req->content_len <= 0 || req->content_len >= sizeof(body)) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid form");
    size_t received = 0;
    while (received < req->content_len) {
        int n = httpd_req_recv(req, body + received, req->content_len - received);
        if (n <= 0) { memset(body, 0, sizeof(body)); return ESP_FAIL; }
        received += n;
    }
    cJSON *form = cJSON_Parse(body);
    cJSON *ssid = cJSON_GetObjectItemCaseSensitive(form, "ssid"), *password = cJSON_GetObjectItemCaseSensitive(form, "password"), *code = cJSON_GetObjectItemCaseSensitive(form, "code");
    bool valid = cJSON_IsString(ssid) && strlen(ssid->valuestring) > 0 && strlen(ssid->valuestring) <= 32 &&
        cJSON_IsString(password) && (strlen(password->valuestring) == 0 || (strlen(password->valuestring) >= 8 && strlen(password->valuestring) <= 63)) &&
        cJSON_IsString(code) && strlen(code->valuestring) <= 128;
    xSemaphoreTake(gate, portMAX_DELAY);
    valid = valid && local_request(req) && httpd_req_get_hdr_value_str(req, "X-Setup-Token", token, sizeof(token)) == ESP_OK && strcmp(token, nonce) == 0;
    const bool saved = valid && save_config(ssid->valuestring, password->valuestring, code->valuestring);
    if (saved) reconnect_at = esp_timer_get_time() + 2000000;
    xSemaphoreGive(gate);
    // No passwords in responses, diagnostics, telemetry or browser storage.
    if (password && cJSON_IsString(password)) memset(password->valuestring, 0, strlen(password->valuestring));
    if (code && cJSON_IsString(code)) memset(code->valuestring, 0, strlen(code->valuestring));
    cJSON_Delete(form); memset(body, 0, sizeof(body));
    httpd_resp_set_type(req, "application/json"); httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    if (!saved) httpd_resp_set_status(req, "400 Bad Request");
    return httpd_resp_sendstr(req, saved ? "{\"ok\":true}" : "{\"ok\":false,\"message\":\"保存失败，请检查 Wi-Fi 信息和首次配对码，或重新长按旋钮进入配网。\"}");
}
static void setup_task(void *arg)
{
    (void)arg; bool begin;
    while (true) {
        if (xQueueReceive(begin_queue, &begin, pdMS_TO_TICKS(200)) == pdTRUE) {
            xSemaphoreTake(gate, portMAX_DELAY);
            if (!network_setup_active()) {
                uint8_t random[16]; esp_fill_random(random, sizeof(random));
                for (int i = 0; i < 16; i++) snprintf(nonce + i * 2, 3, "%02x", random[i]);
                wifi_config_t config = {0};
                strlcpy((char *)config.ap.ssid, ap_name, sizeof(config.ap.ssid));
                strlcpy((char *)config.ap.password, "easyinput", sizeof(config.ap.password));
                config.ap.ssid_len = strlen(ap_name); config.ap.channel = 1; config.ap.max_connection = 2;
                config.ap.authmode = WIFI_AUTH_WPA2_PSK;
                // Station configuration and the current station link remain intact.
                if (esp_wifi_set_mode(WIFI_MODE_APSTA) != ESP_OK || esp_wifi_set_config(WIFI_IF_AP, &config) != ESP_OK) {
                    (void)esp_wifi_set_mode(WIFI_MODE_STA); xSemaphoreGive(gate); continue;
                }
            }
            portENTER_CRITICAL(&state_lock); deadline = esp_timer_get_time() + 120000000; portEXIT_CRITICAL(&state_lock);
            xSemaphoreGive(gate);
        }
        xSemaphoreTake(gate, portMAX_DELAY);
        const int64_t now = esp_timer_get_time();
        if (reconnect_at && now >= reconnect_at) { reconnect_at = 0; reconnect_station(); }
        portENTER_CRITICAL(&state_lock); const bool expired = deadline && now >= deadline; if (expired) deadline = 0; portEXIT_CRITICAL(&state_lock);
        if (expired) { memset(nonce, 0, sizeof(nonce)); (void)esp_wifi_set_mode(WIFI_MODE_STA); }
        xSemaphoreGive(gate);
    }
}
void network_setup_begin(void)
{
    if (available) { const bool begin = true; (void)xQueueOverwrite(begin_queue, &begin); }
}
void network_setup_init(httpd_handle_t server, network_setup_save_t save, void (*reconnect)(void))
{
    if (!server || !save || !reconnect) return;
    save_config = save; reconnect_station = reconnect;
    ap_netif = esp_netif_create_default_wifi_ap();
    uint8_t mac[6] = {0}; (void)esp_wifi_get_mac(WIFI_IF_STA, mac);
    snprintf(ap_name, sizeof(ap_name), "EasyInput-Setup-%02X%02X", mac[4], mac[5]);
    gate = xSemaphoreCreateMutex(); begin_queue = xQueueCreate(1, sizeof(bool));
    if (!gate || !begin_queue || !ap_netif) return;
    const httpd_uri_t index = {.uri = "/", .method = HTTP_GET, .handler = index_handler};
    const httpd_uri_t status = {.uri = "/setup-status", .method = HTTP_GET, .handler = status_handler};
    const httpd_uri_t form = {.uri = "/setup", .method = HTTP_POST, .handler = save_handler};
    if (httpd_register_uri_handler(server, &index) != ESP_OK || httpd_register_uri_handler(server, &status) != ESP_OK ||
        httpd_register_uri_handler(server, &form) != ESP_OK) return;
    available = xTaskCreate(setup_task, "phone_setup", 6144, NULL, 4, NULL) == pdPASS;
}
