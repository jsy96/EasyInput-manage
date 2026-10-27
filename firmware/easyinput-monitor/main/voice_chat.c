#include "voice_chat.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "audio.h"
#include "lights.h"
#include "network_setup.h"
#include "voice_outbox.h"
#include "voice_prompts.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mbedtls/base64.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#define CHUNK 768
#define MAX_AUDIO 480000
#define MAX_MESSAGES 100
#define LONG_US 1200000
#define RETRY_US 3000000
#define ACK_TIMEOUT_US 12000000

typedef struct { char id[65]; int slot; size_t samples; bool read, cleared, seen, pending_read; } message_t;
typedef struct { int key, delta; bool down; char *json; } event_t;
typedef enum { IDLE, INDEX, DOWNLOAD, READY_PLAY, PLAYING, RECORDING, CACHE, UP_BEGIN, UP_CHUNK, UP_COMMIT, MARK_READ, CLEAR } job_t;
static QueueHandle_t events;
static void (*send_line)(const char *);
static message_t messages[MAX_MESSAGES];
static int count;
static job_t job;
static char active_id[65];
static int active_slot;
static uint8_t *audio_data;
static size_t audio_size;
static unsigned chunk_index;
static int index_offset;
static bool outbox_ready, s8_enabled = true;
static bool slot_owned[5];
static int64_t sync_at, retry_at, cache_at, settings_at;
static int64_t key_down[9];
static bool key_held[9];
static char request_line[1600], request_id[24], probe_id[24];
static uint32_t sequence;
static int64_t sent_at, started_at, probe_at, last_network_at, announce_at;
static int64_t recording_started_at;
static int network_via; // 0 = no fresh cloud acknowledgement; 1 = Wi-Fi; 2 = BLE gateway.
static int pending_prompt = -1;
static bool prompt_playing;
static int64_t setup_wait_until;
static uint8_t volume = 20;
static voice_outbox_item_t outgoing;
static voice_chat_snapshot_t snapshot = {.s8_enabled = true};
static portMUX_TYPE snapshot_lock = portMUX_INITIALIZER_UNLOCKED;
static const char *TAG = "voice_chat";

static bool uploading(void) { return job == UP_BEGIN || job == UP_CHUNK || job == UP_COMMIT; }
static bool network_fresh(int64_t now) { return last_network_at && now - last_network_at < 8000000; }
static cJSON *new_frame(const char *op)
{
    cJSON *v = cJSON_CreateObject();
    if (!v) return NULL;
    cJSON_AddStringToObject(v, "type", "chat"); cJSON_AddNumberToObject(v, "protocol", 1); cJSON_AddStringToObject(v, "op", op);
    return v;
}
static void request(cJSON *v)
{
    if (!v) return;
    snprintf(request_id, sizeof(request_id), "board-%lu", (unsigned long)++sequence);
    cJSON_AddStringToObject(v, "req", request_id);
    char *line = cJSON_PrintUnformatted(v);
    if (line) { strlcpy(request_line, line, sizeof(request_line)); send_line(request_line); free(line); }
    cJSON_Delete(v); sent_at = started_at = esp_timer_get_time();
}
static void probe(int64_t now)
{
    snprintf(probe_id, sizeof(probe_id), "net-%lu", (unsigned long)++sequence);
    char line[128];
    snprintf(line, sizeof(line), "{\"type\":\"chat\",\"protocol\":1,\"op\":\"ping\",\"req\":\"%s\"}", probe_id);
    send_line(line); probe_at = now + RETRY_US;
}
static message_t *find_message(const char *id)
{
    for (int i = 0; i < count; i++) if (strcmp(messages[i].id, id) == 0) return &messages[i];
    return NULL;
}
static int slot_for_key(int key) { return key < 4 ? key : key == 7 ? 4 : -1; }
static void refresh_lights(int64_t now)
{
    const bool recording = job == RECORDING;
    const bool waiting = voice_outbox_count() || job == CACHE;
    for (int slot = 0; slot < 5; slot++) {
        int color = 0;
        for (int i = 0; i < count; i++) if (messages[i].slot == slot && !messages[i].cleared) {
            if (!messages[i].read) { color = 0xff0000; break; }
            color = 0x00ff00;
        }
        const bool override = slot == 4 && (recording || waiting);
        if (override) {
            if (recording) color = ((now - recording_started_at) / 350000) % 2 == 0 ? 0xff8000 : 0;
            else color = uploading() ? ((now / 350000) % 2 ? 0xffff00 : 0) : 0xffff00;
        }
        if (!color && !slot_owned[slot] && !override) continue;
        slot_owned[slot] = color != 0 || override;
        const light_pixel_t pixel = {.rgb = color, .brightness = 20, .on = color != 0};
        lights_snapshot_t current; lights_get_snapshot(&current);
        if (current.pixels[slot].rgb != pixel.rgb || current.pixels[slot].on != pixel.on || current.pixels[slot].brightness != pixel.brightness)
            (void)lights_set_pixel(slot, &pixel);
    }
}
static void add_item(cJSON *v)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(v, "id"), *slot = cJSON_GetObjectItemCaseSensitive(v, "slot"), *samples = cJSON_GetObjectItemCaseSensitive(v, "samples");
    if (!cJSON_IsString(id) || strlen(id->valuestring) > 64 || !cJSON_IsNumber(slot) || slot->valueint < 0 || slot->valueint > 4 || !cJSON_IsNumber(samples) || samples->valuedouble < 1 || samples->valuedouble > MAX_AUDIO) return;
    message_t *m = find_message(id->valuestring);
    if (!m && count < MAX_MESSAGES) { m = &messages[count++]; memset(m, 0, sizeof(*m)); }
    if (!m) for (int i = 0; i < count; i++) if (messages[i].read || messages[i].cleared) {
        memmove(&messages[i], &messages[i + 1], (count - i - 1) * sizeof(message_t)); m = &messages[count - 1]; memset(m, 0, sizeof(*m)); break;
    }
    if (!m) return;
    strlcpy(m->id, id->valuestring, sizeof(m->id)); m->slot = slot->valueint; m->samples = samples->valueint;
    m->read = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v, "read")); m->cleared = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v, "cleared")); m->seen = true;
    if (m->read || m->cleared) m->pending_read = false;
}
static void release_audio(void) { free(audio_data); audio_data = NULL; audio_size = 0; }
static void finish(void) { request_line[0] = '\0'; job = IDLE; sync_at = esp_timer_get_time() + 30000000; }
static void pause_background(void)
{
    if (uploading()) { retry_at = esp_timer_get_time() + RETRY_US; finish(); }
    else if (job == INDEX || job == MARK_READ) finish();
}
static void pull_chunk(void)
{
    cJSON *v = new_frame("pull"); cJSON_AddStringToObject(v, "id", active_id); cJSON_AddNumberToObject(v, "index", chunk_index); request(v);
}
static void upload_begin(void)
{
    if (!voice_outbox_oldest(&outgoing)) return;
    job = UP_BEGIN;
    cJSON *v = new_frame("begin"); cJSON_AddStringToObject(v, "id", outgoing.id); cJSON_AddNumberToObject(v, "samples", outgoing.samples); request(v);
}
static void upload_failed(void) { finish(); retry_at = esp_timer_get_time() + RETRY_US; }
static void upload_chunk(void)
{
    if (chunk_index * CHUNK >= outgoing.samples) {
        job = UP_COMMIT; cJSON *v = new_frame("commit"); cJSON_AddStringToObject(v, "id", outgoing.id); request(v); return;
    }
    uint8_t bytes[CHUNK]; const size_t n = outgoing.samples - chunk_index * CHUNK < CHUNK ? outgoing.samples - chunk_index * CHUNK : CHUNK;
    if (voice_outbox_read(&outgoing, chunk_index * CHUNK, bytes, n) != ESP_OK) { upload_failed(); return; }
    char encoded[1028]; size_t length = 0;
    mbedtls_base64_encode((unsigned char *)encoded, sizeof(encoded), &length, bytes, n); encoded[length] = 0;
    job = UP_CHUNK;
    cJSON *v = new_frame("chunk"); cJSON_AddStringToObject(v, "id", outgoing.id); cJSON_AddNumberToObject(v, "index", chunk_index); cJSON_AddStringToObject(v, "data", encoded); request(v);
}
static void request_index(void)
{
    cJSON *v = new_frame("index"); cJSON_AddNumberToObject(v, "offset", index_offset); request(v);
}
static void mark_read(message_t *m)
{
    strlcpy(active_id, m->id, sizeof(active_id)); job = MARK_READ;
    cJSON *v = new_frame("read"); cJSON_AddStringToObject(v, "id", active_id); request(v);
}
static void play_slot(int slot)
{
    if (slot == 4 && !s8_enabled) { pending_prompt = PROMPT_S8_OFF; return; }
    pause_background(); if (job != IDLE || prompt_playing) return;
    message_t *selected = NULL;
    for (int i = 0; i < count; i++) if (messages[i].slot == slot && !messages[i].cleared) {
        selected = &messages[i]; if (!selected->read && !selected->pending_read) break;
    }
    if (!selected) return;
    audio_data = heap_caps_malloc(selected->samples, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!audio_data) return;
    audio_size = selected->samples; strlcpy(active_id, selected->id, sizeof(active_id)); active_slot = slot;
    chunk_index = 0; job = DOWNLOAD; pull_chunk();
}
static void clear_slot(int slot)
{
    pause_background(); if (job != IDLE) return;
    active_slot = slot; job = CLEAR;
    cJSON *v = new_frame("clear"); cJSON_AddNumberToObject(v, "slot", slot); request(v);
}
static void receive(cJSON *v)
{
    cJSON *op = cJSON_GetObjectItemCaseSensitive(v, "op"), *req = cJSON_GetObjectItemCaseSensitive(v, "req");
    if (!cJSON_IsString(op)) return;
    if (strcmp(op->valuestring, "pong") == 0 && cJSON_IsString(req) && strcmp(req->valuestring, probe_id) == 0) {
        const cJSON *via = cJSON_GetObjectItemCaseSensitive(v, "via");
        if (cJSON_IsString(via) && (strcmp(via->valuestring, "wifi") == 0 || strcmp(via->valuestring, "ble") == 0)) {
            network_via = strcmp(via->valuestring, "wifi") == 0 ? 1 : 2; last_network_at = esp_timer_get_time();
        }
        return;
    }
    if (strcmp(op->valuestring, "item") == 0) { add_item(v); return; }
    if (!cJSON_IsString(req) || strcmp(req->valuestring, request_id) != 0) return;
    if (strcmp(op->valuestring, "error") == 0) {
        if (uploading()) upload_failed();
        else { release_audio(); finish(); }
        return;
    }
    if (job == INDEX && strcmp(op->valuestring, "index") == 0) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v, "end"))) {
            for (int i = count - 1; i >= 0; i--) if (!messages[i].seen && !messages[i].pending_read) {
                memmove(&messages[i], &messages[i + 1], (count - i - 1) * sizeof(message_t)); count--;
            }
            finish();
        } else { add_item(v); index_offset++; request_index(); }
    } else if (job == DOWNLOAD && strcmp(op->valuestring, "audio") == 0) {
        const cJSON *index = cJSON_GetObjectItemCaseSensitive(v, "index"), *data = cJSON_GetObjectItemCaseSensitive(v, "data");
        if (!cJSON_IsNumber(index) || index->valueint != chunk_index || !cJSON_IsString(data)) return;
        size_t length = 0; const size_t expected = audio_size - chunk_index * CHUNK < CHUNK ? audio_size - chunk_index * CHUNK : CHUNK;
        unsigned char decoded[CHUNK];
        if (mbedtls_base64_decode(decoded, sizeof(decoded), &length, (unsigned char *)data->valuestring, strlen(data->valuestring)) != 0 || length != expected) return;
        memcpy(audio_data + chunk_index * CHUNK, decoded, length); chunk_index++;
        if (chunk_index * CHUNK < audio_size) pull_chunk(); else { job = READY_PLAY; request_line[0] = 0; }
    } else if (uploading() && strcmp(op->valuestring, "ack") == 0) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(v, "committed"))) {
            if (voice_outbox_ack(&outgoing) != ESP_OK) upload_failed(); else { finish(); retry_at = 0; }
        } else {
            const cJSON *next = cJSON_GetObjectItemCaseSensitive(v, "next");
            if (!cJSON_IsNumber(next) || next->valueint < 0 || (size_t)next->valueint > (outgoing.samples + CHUNK - 1) / CHUNK) return;
            chunk_index = next->valueint; upload_chunk();
        }
    } else if (job == MARK_READ && strcmp(op->valuestring, "ack") == 0) {
        message_t *m = find_message(active_id); if (m) { m->read = true; m->pending_read = false; } finish();
    } else if (job == CLEAR && strcmp(op->valuestring, "cleared") == 0) {
        cJSON *ids = cJSON_GetObjectItemCaseSensitive(v, "ids"), *id;
        cJSON_ArrayForEach(id, ids) if (cJSON_IsString(id)) {
            message_t *m = find_message(id->valuestring); if (m && m->read && m->slot == active_slot) m->cleared = true;
        }
        finish();
    }
}
static void load_settings(void)
{
    nvs_handle_t handle; uint8_t enabled = 1;
    if (nvs_open("voice", NVS_READONLY, &handle) == ESP_OK) {
        (void)nvs_get_u8(handle, "volume", &volume); (void)nvs_get_u8(handle, "s8", &enabled); nvs_close(handle);
    }
    if (volume > 100) volume = 20;
    s8_enabled = enabled != 0; (void)audio_set_volume(volume);
}
static void save_settings(void)
{
    nvs_handle_t handle;
    if (nvs_open("voice", NVS_READWRITE, &handle) != ESP_OK) return;
    if (nvs_set_u8(handle, "volume", volume) == ESP_OK && nvs_set_u8(handle, "s8", s8_enabled) == ESP_OK) (void)nvs_commit(handle);
    nvs_close(handle);
}
static void on_key(int key, bool down)
{
    const int64_t now = esp_timer_get_time();
    if (key < 0 || key > 8) return;
    if (key == 6 && down) { pending_prompt = -2; announce_at = now + 1800000; probe(now); return; }
    if (key == 4 && down) {
        pause_background();
        if (job != IDLE || prompt_playing) return;
        if (!outbox_ready || voice_outbox_count() >= VOICE_OUTBOX_CAPACITY) { pending_prompt = outbox_ready ? PROMPT_FULL : PROMPT_SAVE_FAILED; return; }
        audio_data = heap_caps_malloc(MAX_AUDIO, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (audio_data && audio_record_start(audio_data, MAX_AUDIO) == ESP_OK) {
            job = RECORDING; recording_started_at = esp_timer_get_time();
            refresh_lights(recording_started_at);
            snprintf(active_id, sizeof(active_id), "board-%08lx-%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
        } else release_audio();
    }
    if (key == 5 && down && job == RECORDING) (void)audio_record_stop();
    if (slot_for_key(key) < 0 && key != 8) return;
    if (down) { key_down[key] = now; key_held[key] = false; }
    else {
        if (key_down[key] && !key_held[key]) {
            if (key == 8) {
                s8_enabled = !s8_enabled; settings_at = now + 1000000; pending_prompt = s8_enabled ? PROMPT_S8_ON : PROMPT_S8_OFF;
                if (!s8_enabled && (job == DOWNLOAD || job == READY_PLAY || job == PLAYING) && active_slot == 4) {
                    if (job == PLAYING) (void)audio_stop_speaker();
                    release_audio(); finish(); // Interrupted playback never becomes read.
                }
            } else play_slot(slot_for_key(key));
        }
        key_down[key] = 0;
    }
}
static void task(void *arg)
{
    (void)arg; event_t event; load_settings();
    outbox_ready = voice_outbox_init() == ESP_OK;
    if (!outbox_ready) ESP_LOGE(TAG, "Persistent voice outbox unavailable");
    while (true) {
        if (xQueueReceive(events, &event, pdMS_TO_TICKS(20)) == pdTRUE) {
            if (event.json) { cJSON *v = cJSON_Parse(event.json); if (v) { receive(v); cJSON_Delete(v); } free(event.json); }
            else if (event.delta) {
                int value = volume + event.delta * 5; volume = value < 0 ? 0 : value > 100 ? 100 : value;
                (void)audio_set_volume(volume); settings_at = esp_timer_get_time() + 1000000;
            } else on_key(event.key, event.down);
        }
        const int64_t now = esp_timer_get_time();
        if (now >= probe_at) probe(now);
        for (int key = 0; key < 9; key++) if (key_down[key] && !key_held[key] && now - key_down[key] >= (key == 8 ? 3000000 : LONG_US)) {
            key_held[key] = true;
            if (key == 8) { network_setup_begin(); setup_wait_until = now + 3000000; } else clear_slot(slot_for_key(key));
        }
        if (setup_wait_until && network_setup_active()) { pending_prompt = PROMPT_SETUP; setup_wait_until = 0; }
        else if (setup_wait_until && now >= setup_wait_until) { pending_prompt = PROMPT_SETUP_FAILED; setup_wait_until = 0; }
        if (settings_at && now >= settings_at) { save_settings(); settings_at = 0; }
        audio_snapshot_t audio; audio_get_snapshot(&audio);
        if (prompt_playing && !audio.speaker_playing) prompt_playing = false;
        if (job == RECORDING && !audio.recording) {
            audio_size = audio.recorded_bytes;
            if (audio_size) { job = CACHE; cache_at = 0; } else { release_audio(); finish(); }
            // Retire the orange recording indication before the Flash save can block.
            refresh_lights(now);
        }
        if (job == CACHE && now >= cache_at && !prompt_playing && !audio.speaker_playing) {
            if (voice_outbox_save(active_id, audio_data, audio_size) == ESP_OK) { release_audio(); finish(); retry_at = 0; }
            else { cache_at = now + RETRY_US; pending_prompt = PROMPT_SAVE_FAILED; }
        }
        if (job == READY_PLAY && !prompt_playing && !audio.speaker_playing) {
            if (audio_play_voice(audio_data, audio_size) == ESP_OK) job = PLAYING; else { release_audio(); finish(); }
        } else if (job == PLAYING && !audio.speaker_playing) {
            release_audio(); message_t *m = find_message(active_id);
            if (audio.voice_completed && audio.speaker_error == ESP_OK && m) { m->pending_read = true; mark_read(m); } else finish();
        }
        if (request_line[0] && now - sent_at > ACK_TIMEOUT_US) {
            if (uploading()) upload_failed();
            else if (job == INDEX) { finish(); sync_at = now + RETRY_US; }
            else if (job == MARK_READ) finish(); // Receipt remains queued on the message.
            else if (now - started_at > 60000000) { release_audio(); finish(); }
            else { send_line(request_line); sent_at = now; }
        }
        if (pending_prompt != -1 && !prompt_playing && job != RECORDING && job != PLAYING && job != READY_PLAY && !audio.speaker_playing &&
            (pending_prompt != -2 || now >= announce_at)) {
            int prompt = pending_prompt;
            if (prompt == -2) prompt = !network_fresh(now) ? PROMPT_OFFLINE : network_via == 1 ? PROMPT_WIFI : PROMPT_BLE;
            size_t length; const uint8_t *data = voice_prompt_data(prompt, &length);
            if (audio_play_voice(data, length) == ESP_OK) { prompt_playing = true; pending_prompt = -1; }
        }
        if (job == IDLE && network_fresh(now)) {
            message_t *receipt = NULL;
            for (int i = 0; i < count; i++) if (messages[i].pending_read) { receipt = &messages[i]; break; }
            if (receipt) mark_read(receipt);
            else if (now >= sync_at && !prompt_playing) {
                for (int i = 0; i < count; i++) messages[i].seen = false;
                index_offset = 0; job = INDEX; request_index();
            } else if (voice_outbox_count() && now >= retry_at) upload_begin();
        }
        static int64_t lights_at;
        if (now >= lights_at) { refresh_lights(now); lights_at = now + 100000; }
        const voice_chat_snapshot_t value = {.pending = voice_outbox_count() + (job == CACHE ? 1 : 0), .sending = uploading(), .storage_error = !outbox_ready || job == CACHE,
            .s8_enabled = s8_enabled, .network_via = network_fresh(now) ? network_via : 0};
        portENTER_CRITICAL(&snapshot_lock); snapshot = value; portEXIT_CRITICAL(&snapshot_lock);
    }
}
void voice_chat_init(void (*send)(const char *line))
{
    send_line = send; events = xQueueCreate(64, sizeof(event_t));
    if (events && xTaskCreate(task, "voice_group", 8192, NULL, 4, NULL) != pdPASS)
        ESP_LOGE(TAG, "Unable to create voice worker task");
}
bool voice_chat_receive(const cJSON *v)
{
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(v, "type");
    if (!cJSON_IsString(type) || strcmp(type->valuestring, "chat") != 0) return false;
    const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(v, "protocol");
    if (events && cJSON_IsNumber(protocol) && protocol->valueint == 1) {
        event_t event = {.json = cJSON_PrintUnformatted(v)};
        if (event.json && xQueueSend(events, &event, 0) != pdTRUE) free(event.json);
    }
    return true;
}
void voice_chat_key(int key, bool pressed)
{
    if (events) { const event_t event = {.key = key, .down = pressed}; (void)xQueueSend(events, &event, 0); }
}
void voice_chat_rotate(int delta)
{
    if (events) { const event_t event = {.delta = delta}; (void)xQueueSend(events, &event, 0); }
}
void voice_chat_get_snapshot(voice_chat_snapshot_t *value)
{
    portENTER_CRITICAL(&snapshot_lock); *value = snapshot; portEXIT_CRITICAL(&snapshot_lock);
}
