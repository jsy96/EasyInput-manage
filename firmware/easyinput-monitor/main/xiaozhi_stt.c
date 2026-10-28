// Protocol adapted from the verified xiaozhi-waytoagi OTA/WebSocket client.
// Only the user's STT event is retained. Incoming TTS/audio is never played.
#include "xiaozhi_stt.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "audio.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_flash.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_opus_enc.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

#define PCM_BYTES (16000 * 2 * 20)
#define OTA_URL "https://api.tenclass.net/xiaozhi/ota/"
#define JSON_BYTES 16384
static const char *TAG = "xiaozhi_stt";
static SemaphoreHandle_t guard;
static QueueHandle_t notifications, incoming;
static TaskHandle_t worker;
static bool busy, cancelled, storage_ready, capturing;
static uint8_t *pcm;
static size_t pcm_length;
static portMUX_TYPE capture_lock = portMUX_INITIALIZER_UNLOCKED;
static stt_text_t pending;
static char device[18], client[37];
// Callback assembly is bounded, and owned exclusively by the WebSocket task.
static char ws_json[4096];
static size_t ws_used, ws_expected, ws_frame_start;
static bool ws_accepting;
typedef struct { char json[4096]; } incoming_t;

static bool is_cancelled(void)
{
    xSemaphoreTake(guard, portMAX_DELAY);
    const bool value = cancelled;
    xSemaphoreGive(guard);
    return value;
}
static void notify(stt_event_kind_t kind, const char *code)
{
    stt_event_t event = {.kind = kind};
    if (code) strlcpy(event.code, code, sizeof(event.code));
    (void)xQueueSend(notifications, &event, 0);
}
static void sink(const uint8_t *data, size_t length)
{
    portENTER_CRITICAL(&capture_lock);
    if (capturing && length <= PCM_BYTES - pcm_length) {
        memcpy(pcm + pcm_length, data, length);
        pcm_length += length;
    }
    portEXIT_CRITICAL(&capture_lock);
}
static bool persist_text(const stt_text_t *text)
{
    nvs_handle_t h;
    if (nvs_open("stt", NVS_READWRITE, &h) != ESP_OK) return false;
    const esp_err_t result = text ? nvs_set_blob(h, "pending", text, sizeof(*text)) : nvs_erase_key(h, "pending");
    const bool ok = (result == ESP_OK || (!text && result == ESP_ERR_NVS_NOT_FOUND)) && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}
static bool identity(void)
{
    uint8_t mac[6];
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return false;
    snprintf(device, sizeof(device), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0],mac[1],mac[2],mac[3],mac[4],mac[5]);
    nvs_handle_t h;
    if (nvs_open("board", NVS_READWRITE, &h) != ESP_OK) return false;
    size_t length = sizeof(client);
    if (nvs_get_str(h, "uuid", client, &length) != ESP_OK || strlen(client) != 36) {
        uint8_t r[16]; esp_fill_random(r, sizeof(r)); r[6] = (r[6] & 15) | 64; r[8] = (r[8] & 63) | 128;
        snprintf(client, sizeof(client), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[12],r[13],r[14],r[15]);
        if (nvs_set_str(h, "uuid", client) != ESP_OK || nvs_commit(h) != ESP_OK) { nvs_close(h); return false; }
    }
    nvs_close(h); return true;
}
static cJSON *http_post(const char *url, const char *body, int *status)
{
    *status = 0;
    esp_http_client_config_t config = {.url=url, .crt_bundle_attach=esp_crt_bundle_attach, .timeout_ms=12000,
        .disable_auto_redirect=true, .buffer_size=2048};
    esp_http_client_handle_t h = esp_http_client_init(&config);
    if (!h) return NULL;
    esp_http_client_set_method(h, HTTP_METHOD_POST);
    esp_http_client_set_header(h, "Activation-Version", "1");
    esp_http_client_set_header(h, "Device-Id", device);
    esp_http_client_set_header(h, "Client-Id", client);
    esp_http_client_set_header(h, "User-Agent", esp_app_get_description()->version);
    esp_http_client_set_header(h, "Accept-Language", "zh-CN");
    esp_http_client_set_header(h, "Content-Type", "application/json");
    cJSON *result = NULL;
    char *buffer = malloc(JSON_BYTES);
    const int body_length = strlen(body);
    if (buffer && esp_http_client_open(h, body_length) == ESP_OK && esp_http_client_write(h, body, body_length) == body_length) {
        esp_http_client_fetch_headers(h);
        *status = esp_http_client_get_status_code(h);
        size_t used = 0;
        int n;
        while (!is_cancelled() && used < JSON_BYTES - 1 && (n = esp_http_client_read(h, buffer + used, JSON_BYTES - 1 - used)) > 0) used += n;
        buffer[used] = 0;
        if (esp_http_client_is_complete_data_received(h)) result = cJSON_ParseWithLength(buffer, used);
    }
    free(buffer); esp_http_client_close(h); esp_http_client_cleanup(h); return result;
}
static cJSON *provision(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    esp_chip_info_t chip; esp_chip_info(&chip);
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "version", 2);
    cJSON_AddStringToObject(root, "language", "zh-CN");
    uint32_t flash_size = 0;
    (void)esp_flash_get_size(NULL, &flash_size);
    cJSON_AddNumberToObject(root, "flash_size", flash_size);
    cJSON_AddNumberToObject(root, "minimum_free_heap_size", esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(root, "psram_size", heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    cJSON_AddStringToObject(root, "mac_address", device);
    cJSON_AddStringToObject(root, "uuid", client);
    cJSON_AddStringToObject(root, "chip_model_name", "esp32s3");
    cJSON *info = cJSON_AddObjectToObject(root, "chip_info");
    cJSON_AddNumberToObject(info, "model", chip.model); cJSON_AddNumberToObject(info, "cores", chip.cores);
    cJSON_AddNumberToObject(info, "revision", chip.revision); cJSON_AddNumberToObject(info, "features", chip.features);
    info = cJSON_AddObjectToObject(root, "application");
    cJSON_AddStringToObject(info, "name", app->project_name); cJSON_AddStringToObject(info, "version", app->version);
    cJSON_AddStringToObject(info, "idf_version", app->idf_ver);
    info = cJSON_AddObjectToObject(root, "board");
    cJSON_AddStringToObject(info, "type", "easyinput-v2");
    cJSON_AddStringToObject(info, "name", "easyinput-v2");
    char *body = cJSON_PrintUnformatted(root); cJSON_Delete(root);
    int status; cJSON *response = body ? http_post(OTA_URL, body, &status) : NULL;
    free(body);
    if (status != 200) { cJSON_Delete(response); return NULL; }
    return response;
}
static void ws_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    if (id != WEBSOCKET_EVENT_DATA) return;
    const esp_websocket_event_data_t *e = data;
    // Control frames may be interleaved with a fragmented text message.
    if (e->op_code >= 8) return;
    if (e->payload_offset == 0) {
        if (e->op_code == 1) {
            ws_used = ws_expected = 0;
            ws_accepting = true;
        } else if (e->op_code != 0 || !ws_accepting || ws_used != ws_expected) {
            ws_accepting = false;
            return;
        }
        if (e->payload_len < 0 || (size_t)e->payload_len >= sizeof(ws_json) - ws_used) {
            ws_accepting = false;
            return;
        }
        ws_frame_start = ws_used;
        ws_expected = ws_used + e->payload_len;
    }
    if (!ws_accepting || e->payload_len < 0 ||
        (size_t)e->payload_len != ws_expected - ws_frame_start ||
        e->payload_offset < 0 || (size_t)e->payload_offset != ws_used - ws_frame_start ||
        e->data_len < 0 || (size_t)e->data_len > ws_expected - ws_used) {
        ws_accepting = false;
        return;
    }
    if (e->data_len) memcpy(ws_json + ws_used, e->data_ptr, e->data_len);
    ws_used += e->data_len;
    if (ws_used == ws_expected && e->fin) {
        ws_json[ws_used] = 0;
        incoming_t event;
        strlcpy(event.json, ws_json, sizeof(event.json));
        (void)xQueueSend(incoming, &event, 0);
        ws_accepting = false;
    }
}
static bool send_json(esp_websocket_client_handle_t ws, cJSON *json)
{
    char *line = cJSON_PrintUnformatted(json); cJSON_Delete(json);
    const bool ok = line && esp_websocket_client_send_text(ws, line, strlen(line), pdMS_TO_TICKS(3000)) == (int)strlen(line);
    free(line); return ok;
}
static cJSON *wait_type(const char *type, int timeout_ms)
{
    const int64_t end = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    incoming_t *event = malloc(sizeof(*event));
    if (!event) return NULL;
    cJSON *result = NULL;
    while (!is_cancelled() && esp_timer_get_time() < end) {
        if (xQueueReceive(incoming, event, pdMS_TO_TICKS(100)) != pdTRUE) continue;
        cJSON *json = cJSON_Parse(event->json);
        const cJSON *t = cJSON_GetObjectItemCaseSensitive(json, "type");
        if (cJSON_IsString(t) && strcmp(t->valuestring, type) == 0) { result = json; break; }
        cJSON_Delete(json);
    }
    free(event); return result;
}
static cJSON *listen_frame(const char *session, const char *state)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "session_id", session); cJSON_AddStringToObject(j, "type", "listen");
    cJSON_AddStringToObject(j, "state", state); cJSON_AddStringToObject(j, "mode", "manual"); return j;
}
// Match the gateway limit in UTF-16 units; reject whitespace-only and malformed UTF-8.
static bool valid_text(const char *text)
{
    if (!text || !text[0] || strlen(text) >= STT_TEXT_BYTES) return false;
    const unsigned char *p = (const unsigned char *)text;
    unsigned units = 0;
    bool content = false;
    while (*p) {
        uint32_t c = *p++;
        unsigned continuation = 0;
        uint32_t minimum = 0;
        if (c >= 0xf0 && c <= 0xf4) { c &= 7; continuation = 3; minimum = 0x10000; }
        else if (c >= 0xe0 && c <= 0xef) { c &= 15; continuation = 2; minimum = 0x800; }
        else if (c >= 0xc2 && c <= 0xdf) { c &= 31; continuation = 1; minimum = 0x80; }
        else if (c >= 0x80) return false;
        for (unsigned i = 0; i < continuation; i++) {
            if ((*p & 0xc0) != 0x80) return false;
            c = (c << 6) | (*p++ & 63);
        }
        if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return false;
        if (c < 32 && c != 9 && c != 10 && c != 13) return false;
        units += c > 0xffff ? 2 : 1;
        if (units > 1000) return false;
        const bool space = c == 9 || c == 10 || c == 13 || c == 32 || c == 0xa0 || c == 0x1680 ||
            (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
        if (!space) content = true;
    }
    return content;
}

static bool transcribe(cJSON *provisioning, stt_text_t *text)
{
    const cJSON *config = cJSON_GetObjectItemCaseSensitive(provisioning, "websocket");
    const cJSON *url = cJSON_GetObjectItemCaseSensitive(config, "url"), *token = cJSON_GetObjectItemCaseSensitive(config, "token");
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(config, "version");
    int protocol = cJSON_IsNumber(version) ? version->valueint : 1;
    if (!cJSON_IsString(url) || strncmp(url->valuestring,"wss://",6) || protocol < 1 || protocol > 3) {
        ESP_LOGW(TAG,"Provisioning has no supported secure WebSocket transport"); return false;
    }
    esp_websocket_client_config_t cfg = {.uri=url->valuestring,.crt_bundle_attach=esp_crt_bundle_attach,
        .disable_auto_reconnect=true,.network_timeout_ms=5000,.buffer_size=2048,.task_stack=8192};
    esp_websocket_client_handle_t ws = esp_websocket_client_init(&cfg);
    if (!ws) return false;
    char pv[4]; snprintf(pv,sizeof(pv),"%d",protocol);
    esp_websocket_client_append_header(ws,"Protocol-Version",pv);
    esp_websocket_client_append_header(ws,"Device-Id",device);
    esp_websocket_client_append_header(ws,"Client-Id",client);
    if (cJSON_IsString(token) && strlen(token->valuestring) < 2000) {
        char authorization[2010]; snprintf(authorization,sizeof(authorization),"%s%s",strchr(token->valuestring,' ') ? "" : "Bearer ",token->valuestring);
        esp_websocket_client_append_header(ws,"Authorization",authorization);
    }
    xQueueReset(incoming); ws_used=ws_expected=ws_frame_start=0; ws_accepting=false;
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, ws_event, NULL);
    bool ok = esp_websocket_client_start(ws) == ESP_OK;
    const int64_t deadline=esp_timer_get_time()+12000000;
    while(ok && !is_cancelled() && !esp_websocket_client_is_connected(ws) && esp_timer_get_time()<deadline) vTaskDelay(pdMS_TO_TICKS(50));
    cJSON *hello=cJSON_CreateObject();
    cJSON_AddStringToObject(hello,"type","hello"); cJSON_AddNumberToObject(hello,"version",protocol);
    cJSON_AddStringToObject(hello,"transport","websocket");
    cJSON *params=cJSON_AddObjectToObject(hello,"audio_params");
    cJSON_AddStringToObject(params,"format","opus"); cJSON_AddNumberToObject(params,"sample_rate",16000);
    cJSON_AddNumberToObject(params,"channels",1); cJSON_AddNumberToObject(params,"frame_duration",60);
    ok = ok && !is_cancelled() && esp_websocket_client_is_connected(ws);
    if (ok) ok=send_json(ws,hello); else cJSON_Delete(hello);
    cJSON *reply=ok ? wait_type("hello",10000) : NULL;
    const cJSON *sid=cJSON_GetObjectItemCaseSensitive(reply,"session_id"), *transport=cJSON_GetObjectItemCaseSensitive(reply,"transport");
    char session[128]={0};
    ok=reply && cJSON_IsString(sid) && strlen(sid->valuestring)<sizeof(session) && cJSON_IsString(transport) && !strcmp(transport->valuestring,"websocket");
    if(ok) strlcpy(session,sid->valuestring,sizeof(session));
    cJSON_Delete(reply);
    void *encoder=NULL; uint8_t *encoded=NULL;
    esp_opus_enc_config_t enc=ESP_OPUS_ENC_CONFIG_DEFAULT();
    enc.sample_rate=16000; enc.channel=1; enc.bitrate=24000; enc.frame_duration=ESP_OPUS_ENC_FRAME_DURATION_60_MS;
    int input_size=0,output_size=0;
    if(ok) ok=esp_opus_enc_open(&enc,sizeof(enc),&encoder)==ESP_AUDIO_ERR_OK;
    if(ok) ok=esp_opus_enc_get_frame_size(encoder,&input_size,&output_size)==ESP_AUDIO_ERR_OK && input_size==1920 && output_size>0 && output_size<=4000;
    if(ok) { encoded=malloc(output_size+16); ok=encoded && send_json(ws,listen_frame(session,"start")); }
    for(size_t offset=0;ok && !is_cancelled() && offset<pcm_length;offset+=input_size) {
        uint8_t last[1920]; uint8_t *input=pcm+offset;
        if(pcm_length-offset<(size_t)input_size) { memset(last,0,sizeof(last)); memcpy(last,input,pcm_length-offset); input=last; }
        const int header=protocol==2?16:protocol==3?4:0;
        esp_audio_enc_in_frame_t in={.buffer=input,.len=input_size};
        esp_audio_enc_out_frame_t out={.buffer=encoded+header,.len=output_size};
        ok=esp_opus_enc_process(encoder,&in,&out)==ESP_AUDIO_ERR_OK && out.encoded_bytes > 0 && out.encoded_bytes <= (unsigned)output_size;
        if(!ok) break;
        memset(encoded,0,header);
        if(protocol==2) {
            encoded[1]=2; const uint32_t timestamp=offset/32, size=out.encoded_bytes;
            for(int i=0;i<4;i++) { encoded[8+i]=(timestamp>>(24-i*8))&255; encoded[12+i]=(size>>(24-i*8))&255; }
        } else if(protocol==3) { encoded[2]=out.encoded_bytes>>8; encoded[3]=out.encoded_bytes&255; }
        const int bytes=header+out.encoded_bytes;
        ok=esp_websocket_client_send_bin(ws,(char *)encoded,bytes,pdMS_TO_TICKS(3000))==bytes;
        // Respect the platform's realtime audio pacing even though capture is buffered.
        vTaskDelay(pdMS_TO_TICKS(60));
    }
    if(encoder) esp_opus_enc_close(encoder);
    free(encoded);
    if(ok && !is_cancelled()) ok=send_json(ws,listen_frame(session,"stop"));
    reply=ok && !is_cancelled()?wait_type("stt",20000):NULL;
    const cJSON *value=cJSON_GetObjectItemCaseSensitive(reply,"text");
    ok=cJSON_IsString(value) && valid_text(value->valuestring);
    if(ok) strlcpy(text->text,value->valuestring,sizeof(text->text));
    cJSON_Delete(reply);
    if(session[0] && esp_websocket_client_is_connected(ws)) {
        cJSON *abort=cJSON_CreateObject(); cJSON_AddStringToObject(abort,"type","abort"); cJSON_AddStringToObject(abort,"session_id",session);
        (void)send_json(ws,abort);
    }
    esp_websocket_client_stop(ws); esp_websocket_client_destroy(ws); return ok;
}
static void run(void *arg)
{
    (void)arg;
    for(;;) {
        ulTaskNotifyTake(pdTRUE,portMAX_DELAY);
        stt_event_kind_t outcome=STT_FAILED;
        char activation[17]={0};
        const int64_t start=esp_timer_get_time(); int64_t last_voice=start; bool heard=false;
        while(!is_cancelled() && esp_timer_get_time()-start<20000000) {
            audio_snapshot_t a; audio_get_snapshot(&a);
            // The audio VAD already includes a 300 ms hold, leaving 1.2 s here.
            if(a.vad) { heard=true; last_voice=esp_timer_get_time(); }
            if(heard && esp_timer_get_time()-last_voice>=1200000) break;
            if(!heard && esp_timer_get_time()-start>=5000000) break;
            vTaskDelay(pdMS_TO_TICKS(20));
        }
        portENTER_CRITICAL(&capture_lock); capturing=false; portEXIT_CRITICAL(&capture_lock);
        const bool stopped = audio_live_stop() == ESP_OK;
        if(!stopped) outcome=STT_FAILED;
        else if(!heard) outcome=STT_EMPTY;
        else if(!is_cancelled()) {
            notify(STT_WAIT,NULL);
            cJSON *provisioning=identity()?provision():NULL;
            const cJSON *act=cJSON_GetObjectItemCaseSensitive(provisioning,"activation");
            const cJSON *code=cJSON_GetObjectItemCaseSensitive(act,"code");
            if(cJSON_IsString(code) && code->valuestring[0]) {
                strlcpy(activation,code->valuestring,sizeof(activation));
                ESP_LOGI(TAG,"Bind at xiaozhi.me using activation code: %s",activation);
                int status;
                cJSON *r = http_post(OTA_URL "activate", "{}", &status);
                cJSON_Delete(r);
                if (status == 200 && !is_cancelled()) {
                    cJSON_Delete(provisioning);
                    provisioning = provision();
                    act = cJSON_GetObjectItemCaseSensitive(provisioning, "activation");
                    code = cJSON_GetObjectItemCaseSensitive(act, "code");
                    if (!cJSON_IsString(code) || !code->valuestring[0]) activation[0] = 0;
                }
                outcome = STT_ACTIVATE;
            }
            if (provisioning && !activation[0]) {
                stt_text_t *text=calloc(1,sizeof(*text));
                if(text && transcribe(provisioning,text) && !is_cancelled()) {
                    uint32_t r[4]; esp_fill_random(r,sizeof(r));
                    snprintf(text->id,sizeof(text->id),"%08lx%08lx%08lx%08lx",(unsigned long)r[0],(unsigned long)r[1],(unsigned long)r[2],(unsigned long)r[3]);
                    xSemaphoreTake(guard,portMAX_DELAY);
                    if(!cancelled && persist_text(text)) { pending=*text; outcome=STT_DONE; }
                    xSemaphoreGive(guard);
                }
                free(text);
            }
            cJSON_Delete(provisioning);
        }
        xSemaphoreTake(guard,portMAX_DELAY);
        if(cancelled) outcome=STT_CANCELLED;
        busy=false;
        notify(outcome,activation);
        xSemaphoreGive(guard);
    }
}
void xiaozhi_stt_init(void)
{
    guard=xSemaphoreCreateMutex(); notifications=xQueueCreate(4,sizeof(stt_event_t)); incoming=xQueueCreateWithCaps(4,sizeof(incoming_t),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    pcm=heap_caps_malloc(PCM_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    if(!guard || !notifications || !incoming || !pcm) return;
    nvs_handle_t h;
    if(nvs_open("stt",NVS_READWRITE,&h)==ESP_OK) {
        size_t n=sizeof(pending); esp_err_t e=nvs_get_blob(h,"pending",&pending,&n);
        storage_ready=e==ESP_ERR_NVS_NOT_FOUND || (e==ESP_OK && n==sizeof(pending) && strnlen(pending.id,sizeof(pending.id))==32 && strnlen(pending.text,sizeof(pending.text))<sizeof(pending.text) && valid_text(pending.text));
        nvs_close(h);
    }
    if(xTaskCreate(run,"xiaozhi_stt",16384,NULL,4,&worker)!=pdPASS) worker=NULL;
}
esp_err_t xiaozhi_stt_start(void)
{
    if(!guard || !worker || !storage_ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(guard,portMAX_DELAY);
    if(busy || pending.id[0]) { xSemaphoreGive(guard); return ESP_ERR_INVALID_STATE; }
    xQueueReset(notifications); cancelled=false; busy=true;
    portENTER_CRITICAL(&capture_lock); pcm_length=0; capturing=true; portEXIT_CRITICAL(&capture_lock);
    const esp_err_t result=audio_live_start(sink);
    if(result==ESP_OK) xTaskNotifyGive(worker);
    else { busy=false; portENTER_CRITICAL(&capture_lock); capturing=false; portEXIT_CRITICAL(&capture_lock); }
    xSemaphoreGive(guard); return result;
}
bool xiaozhi_stt_busy(void)
{
    if(!guard) return false;
    xSemaphoreTake(guard,portMAX_DELAY); bool value=busy; xSemaphoreGive(guard); return value;
}
bool xiaozhi_stt_poll(stt_event_t *event) { return notifications && xQueueReceive(notifications,event,0)==pdTRUE; }
bool xiaozhi_stt_pending(stt_text_t *text)
{
    if(!guard) return false;
    xSemaphoreTake(guard,portMAX_DELAY); bool value=storage_ready && pending.id[0]; if(value && text) *text=pending; xSemaphoreGive(guard); return value;
}
bool xiaozhi_stt_ack(const char *id)
{
    if(!guard) return false;
    xSemaphoreTake(guard,portMAX_DELAY);
    bool ok=storage_ready && pending.id[0] && !strcmp(id,pending.id) && persist_text(NULL);
    if(ok) memset(&pending,0,sizeof(pending));
    xSemaphoreGive(guard); return ok;
}
bool xiaozhi_stt_cancel(void)
{
    if(!guard) return false;
    xSemaphoreTake(guard,portMAX_DELAY);
    cancelled=true; bool ok=!pending.id[0] || persist_text(NULL);
    if(ok) memset(&pending,0,sizeof(pending));
    xSemaphoreGive(guard); return ok;
}
