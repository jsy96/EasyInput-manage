#include "voice_chat.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "audio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lights.h"
#include "mbedtls/base64.h"
#include "network_setup.h"
#include "timers.h"
#include "voice_outbox.h"
#include "voice_prompts.h"

#define CHAT_PROTOCOL 2
#define CHUNK 768
#define MAX_AUDIO 160000
#define STREAM_WINDOW 4
#define PREBUFFER 4096
#define MAX_MESSAGES 100
#define LONG_US 1200000
#define SETUP_LONG_US 3000000
#define SETTINGS_COMMIT_US 2000000
#define RETRY_US 3000000
#define ACK_TIMEOUT_US 12000000
#define TOKEN_VALID_FROM 1735689600LL

typedef struct {
    char id[65];
    int64_t created;
    size_t samples;
    bool read;
    bool seen;
    bool pending_read;
} message_t;

typedef struct {
    int key;
    int delta;
    bool down;
    char *json;
    uint8_t *realtime_data;
    size_t realtime_length;
} event_t;

typedef enum {
    JOB_IDLE,
    JOB_INDEX,
    JOB_DOWNLOAD,
    JOB_PLAYING,
    JOB_MARK_READ,
    JOB_CACHE,
    JOB_UP_BEGIN,
    JOB_UP_CHUNK,
    JOB_UP_COMMIT,
} job_t;

typedef enum {
    MODE_IDLE,
    MODE_SETTING_ALARM,
    MODE_SETTING_TIMER,
    MODE_RECORDING,
    MODE_RECORD_READY,
    MODE_PLAYING,
    MODE_REALTIME,
    MODE_COUNTDOWN,
} ui_mode_t;

typedef enum {
    PROMPT_ACTION_NONE,
    PROMPT_ACTION_START_RECORDING,
    PROMPT_ACTION_START_REALTIME,
} prompt_action_t;

static const char *TAG = "voice_chat";
static QueueHandle_t events;
static void (*send_line)(const char *);
static message_t messages[MAX_MESSAGES];
static int message_count;
static job_t job;
static ui_mode_t mode;
static char active_id[65];
static char cursor_id[65];
static char hold_id[65];
static uint8_t *audio_data;
static size_t audio_size;
static unsigned chunk_index;
static int index_offset;
static bool outbox_ready;
static bool realtime_enabled;
static int online_clients;
static int64_t last_audience_at;
static bool send_when_saved;
static int64_t sync_at;
static int64_t retry_at;
static int64_t cache_at;
static int64_t settings_commit_at;
static int64_t key_down[9];
static bool key_held[9];
static bool key_consumed[9];
static char request_line[1600];
static char request_id[24];
static char probe_id[24];
static uint32_t sequence;
static int64_t sent_at;
static int64_t started_at;
static int64_t probe_at;
static int64_t last_network_at;
static int network_via;
static int alarm_draft = 12 * 60;
static int timer_draft = 30;
static int prompt_ids[16];
static int prompt_length;
static int prompt_position;
static bool prompt_playing;
static prompt_action_t prompt_action;
static bool stream_started;
static bool stream_complete;
static voice_outbox_item_t outgoing;
static voice_chat_snapshot_t snapshot;
static portMUX_TYPE snapshot_lock = portMUX_INITIALIZER_UNLOCKED;
static bool navigation_active;
static int64_t navigation_at;
static bool setup_waiting;
static int64_t setup_deadline;

static bool uploading(void)
{
    return job == JOB_UP_BEGIN || job == JOB_UP_CHUNK || job == JOB_UP_COMMIT;
}

static bool network_fresh(int64_t now)
{
    return last_network_at != 0 && now - last_network_at < 8000000;
}

static cJSON *new_frame(const char *op)
{
    cJSON *value = cJSON_CreateObject();
    if (value == NULL) return NULL;
    cJSON_AddStringToObject(value, "type", "chat");
    cJSON_AddNumberToObject(value, "protocol", CHAT_PROTOCOL);
    cJSON_AddStringToObject(value, "op", op);
    return value;
}

static void request(cJSON *value)
{
    if (value == NULL) return;
    snprintf(request_id, sizeof(request_id), "board-%lu", (unsigned long)++sequence);
    cJSON_AddStringToObject(value, "req", request_id);
    char *line = cJSON_PrintUnformatted(value);
    if (line != NULL) {
        strlcpy(request_line, line, sizeof(request_line));
        send_line(request_line);
        free(line);
    }
    cJSON_Delete(value);
    sent_at = started_at = esp_timer_get_time();
}

static void fire_and_forget(cJSON *value)
{
    if (value == NULL) return;
    char *line = cJSON_PrintUnformatted(value);
    if (line != NULL) {
        send_line(line);
        free(line);
    }
    cJSON_Delete(value);
}

static void probe(int64_t now)
{
    snprintf(probe_id, sizeof(probe_id), "net-%lu", (unsigned long)++sequence);
    char line[128];
    snprintf(line, sizeof(line), "{\"type\":\"chat\",\"protocol\":%d,\"op\":\"ping\",\"req\":\"%s\"}", CHAT_PROTOCOL, probe_id);
    send_line(line);
    probe_at = now + RETRY_US;
}

static message_t *find_message(const char *id)
{
    for (int i = 0; i < message_count; i++) if (strcmp(messages[i].id, id) == 0) return &messages[i];
    return NULL;
}

static void sort_messages(void)
{
    for (int i = 1; i < message_count; i++) {
        message_t current = messages[i];
        int j = i - 1;
        while (j >= 0 && (messages[j].created > current.created ||
               (messages[j].created == current.created && strcmp(messages[j].id, current.id) > 0))) {
            messages[j + 1] = messages[j];
            j--;
        }
        messages[j + 1] = current;
    }
}

static void add_item(cJSON *value)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(value, "id");
    const cJSON *created = cJSON_GetObjectItemCaseSensitive(value, "created");
    const cJSON *samples = cJSON_GetObjectItemCaseSensitive(value, "samples");
    if (!cJSON_IsString(id) || strlen(id->valuestring) > 64 || !cJSON_IsNumber(created) ||
        created->valuedouble < 1 || !cJSON_IsNumber(samples) || samples->valuedouble < 1 ||
        samples->valuedouble > MAX_AUDIO) return;
    message_t *message = find_message(id->valuestring);
    if (message == NULL && message_count < MAX_MESSAGES) message = &messages[message_count++];
    if (message == NULL) {
        memmove(&messages[0], &messages[1], sizeof(messages[0]) * (MAX_MESSAGES - 1));
        message = &messages[MAX_MESSAGES - 1];
        message_count = MAX_MESSAGES;
    }
    memset(message, 0, sizeof(*message));
    strlcpy(message->id, id->valuestring, sizeof(message->id));
    message->created = (int64_t)created->valuedouble;
    message->samples = (size_t)samples->valuedouble;
    message->read = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(value, "read"));
    message->seen = true;
    sort_messages();
}

static message_t *latest_unread(void)
{
    for (int i = message_count - 1; i >= 0; i--) if (!messages[i].read) return &messages[i];
    return message_count ? &messages[message_count - 1] : NULL;
}

static void set_cursor(message_t *message)
{
    if (message == NULL) {
        cursor_id[0] = '\0';
        return;
    }
    strlcpy(cursor_id, message->id, sizeof(cursor_id));
    navigation_active = true;
    navigation_at = esp_timer_get_time();
}

static void release_audio(void)
{
    free(audio_data);
    audio_data = NULL;
    audio_size = 0;
}

static void finish_job(void)
{
    request_line[0] = '\0';
    job = JOB_IDLE;
    sync_at = esp_timer_get_time() + 30000000;
}

static void stop_prompt(void)
{
    if (prompt_playing) (void)audio_stop_speaker();
    prompt_playing = false;
    prompt_length = 0;
    prompt_position = 0;
    prompt_action = PROMPT_ACTION_NONE;
}

static void append_prompt(int *ids, int *length, int prompt)
{
    if (*length < 16) ids[(*length)++] = prompt;
}

static void append_number(int *ids, int *length, int value)
{
    int numbers[8];
    const size_t count = voice_prompt_number(value, numbers);
    for (size_t i = 0; i < count; i++) append_prompt(ids, length, numbers[i]);
}

static void start_prompt_sequence(const int *ids, int length, prompt_action_t action)
{
    stop_prompt();
    prompt_length = length > 16 ? 16 : length;
    for (int i = 0; i < prompt_length; i++) prompt_ids[i] = ids[i];
    prompt_position = 0;
    prompt_action = action;
}

static void start_prompt(int prompt, prompt_action_t action)
{
    start_prompt_sequence(&prompt, 1, action);
}

static void start_time_prompt(int64_t created, int prefix, int suffix, prompt_action_t action)
{
    const time_t raw = (time_t)(created / 1000);
    struct tm local;
    if (localtime_r(&raw, &local) == NULL) return;
    int ids[16], length = 0;
    if (prefix >= 0) append_prompt(ids, &length, prefix);
    append_number(ids, &length, local.tm_hour);
    append_prompt(ids, &length, PROMPT_POINT);
    if (local.tm_min == 0) append_prompt(ids, &length, PROMPT_WHOLE);
    else {
        append_number(ids, &length, local.tm_min);
        append_prompt(ids, &length, PROMPT_MINUTE);
    }
    if (suffix >= 0) append_prompt(ids, &length, suffix);
    start_prompt_sequence(ids, length, action);
}

static void announce_cursor(void)
{
    message_t *message = find_message(cursor_id);
    if (message == NULL) {
        start_prompt(PROMPT_NO_MESSAGES, PROMPT_ACTION_NONE);
        return;
    }
    start_time_prompt(message->created, -1, -1, PROMPT_ACTION_NONE);
}

static void stop_message_playback(void)
{
    if (mode == MODE_PLAYING || job == JOB_DOWNLOAD || job == JOB_PLAYING) {
        (void)audio_stop_speaker();
        release_audio();
        finish_job();
    }
    if (mode == MODE_PLAYING) mode = MODE_IDLE;
}

static void stop_realtime(void)
{
    if (mode != MODE_REALTIME) return;
    (void)audio_live_stop();
    mode = MODE_IDLE;
    cJSON *value = new_frame("realtime.stop");
    fire_and_forget(value);
}

static void cancel_countdown(bool prompt)
{
    if (!timers_countdown_active() && mode != MODE_COUNTDOWN) return;
    timers_cancel_countdown();
    stop_prompt();
    mode = MODE_IDLE;
    if (prompt) start_prompt(PROMPT_COUNTDOWN_DONE, PROMPT_ACTION_NONE);
}

static void refresh_lights(int64_t now)
{
    const bool unread = latest_unread() != NULL && latest_unread()->read == false;
    const bool recording = mode == MODE_RECORDING;
    const bool sending = uploading() || job == JOB_CACHE || voice_outbox_count() > 0;
    const bool realtime = mode == MODE_REALTIME;
    const bool slow_blink = (now % 2100000) < 100000;
    const bool computers_online = network_fresh(now) && last_audience_at &&
        now - last_audience_at < 10000000 && online_clients > 0;
    const bool timer_running = timers_countdown_active();
    const bool alarm_set = timers_alarm_minute() >= 0;
    int color[5] = {0};
    if (unread && slow_blink) color[0] = 0xff0000;
    if (recording) color[1] = 0xff0000;
    else if (sending && slow_blink) color[1] = 0xff0000;
    if (realtime && slow_blink) color[2] = 0xff0000;
    if (computers_online && slow_blink) color[3] = 0xff0000;
    if (timer_running && slow_blink) color[4] = 0xff0000;
    else if (alarm_set) color[4] = 0xff0000;
    lights_snapshot_t current;
    lights_get_snapshot(&current);
    for (int index = 0; index < LIGHT_PIXEL_COUNT; index++) {
        const light_pixel_t pixel = {.rgb = color[index], .brightness = 1, .on = color[index] != 0};
        if (current.pixels[index].rgb != pixel.rgb || current.pixels[index].on != pixel.on ||
            current.pixels[index].brightness != pixel.brightness) {
            (void)lights_set_pixel(index, &pixel);
        }
    }
}

static void request_index(void)
{
    cJSON *value = new_frame("index");
    cJSON_AddNumberToObject(value, "offset", index_offset);
    request(value);
}

static void request_stream(void)
{
    cJSON *value = new_frame("stream");
    cJSON_AddStringToObject(value, "id", active_id);
    cJSON_AddNumberToObject(value, "index", chunk_index);
    cJSON_AddNumberToObject(value, "count", STREAM_WINDOW);
    request(value);
}

static void mark_read(message_t *message)
{
    if (message == NULL) return;
    strlcpy(active_id, message->id, sizeof(active_id));
    job = JOB_MARK_READ;
    cJSON *value = new_frame("read");
    cJSON_AddStringToObject(value, "id", active_id);
    request(value);
}

static void play_message(message_t *message)
{
    const int64_t now = esp_timer_get_time();
    stop_message_playback();
    stop_prompt();
    if (message == NULL) {
        start_prompt(PROMPT_NO_MESSAGES, PROMPT_ACTION_NONE);
        return;
    }
    if (!network_fresh(now)) {
        start_prompt(PROMPT_OFFLINE, PROMPT_ACTION_NONE);
        return;
    }
    audio_data = heap_caps_malloc(message->samples, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (audio_data == NULL) return;
    audio_size = message->samples;
    strlcpy(active_id, message->id, sizeof(active_id));
    chunk_index = 0;
    stream_started = stream_complete = false;
    mode = MODE_PLAYING;
    job = JOB_DOWNLOAD;
    request_stream();
}

static void move_cursor(bool newer)
{
    const int64_t now = esp_timer_get_time();
    stop_prompt();
    if (!navigation_active || now - navigation_at > 15000000 || find_message(cursor_id) == NULL) {
        set_cursor(latest_unread());
        announce_cursor();
        return;
    }
    int index = -1;
    for (int i = 0; i < message_count; i++) if (strcmp(messages[i].id, cursor_id) == 0) { index = i; break; }
    if (index < 0) {
        set_cursor(latest_unread());
    } else if (newer && index + 1 < message_count) {
        set_cursor(&messages[index + 1]);
    } else if (!newer && index > 0) {
        set_cursor(&messages[index - 1]);
    }
    navigation_at = now;
    announce_cursor();
}

static void begin_alarm_setting(void)
{
    stop_message_playback();
    stop_prompt();
    alarm_draft = timers_alarm_minute() >= 0 ? timers_alarm_minute() : 12 * 60;
    mode = MODE_SETTING_ALARM;
    settings_commit_at = esp_timer_get_time() + SETTINGS_COMMIT_US;
}

static void begin_timer_setting(void)
{
    stop_message_playback();
    stop_prompt();
    timer_draft = 30;
    mode = MODE_SETTING_TIMER;
    settings_commit_at = esp_timer_get_time() + SETTINGS_COMMIT_US;
}

static void start_recording(void)
{
    if (!outbox_ready || voice_outbox_count() >= VOICE_OUTBOX_CAPACITY) {
        start_prompt(outbox_ready ? PROMPT_FULL : PROMPT_SAVE_FAILED, PROMPT_ACTION_NONE);
        return;
    }
    audio_data = heap_caps_malloc(MAX_AUDIO, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (audio_data == NULL) return;
    if (audio_record_start(audio_data, MAX_AUDIO) != ESP_OK) {
        release_audio();
        return;
    }
    snprintf(active_id, sizeof(active_id), "board-%08lx-%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random());
    mode = MODE_RECORDING;
    send_when_saved = false;
}

static void begin_recording_with_prompt(void)
{
    start_prompt(PROMPT_RECORDING, PROMPT_ACTION_START_RECORDING);
}

static void begin_realtime_with_prompt(void)
{
    start_prompt(PROMPT_REALTIME_START, PROMPT_ACTION_START_REALTIME);
}

static void realtime_sink(const uint8_t *data, size_t length)
{
    if (length == 0 || length > 2048) return;
    uint8_t *copy = heap_caps_malloc(length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (copy == NULL) return;
    memcpy(copy, data, length);
    const event_t event = {.realtime_data = copy, .realtime_length = length};
    if (xQueueSend(events, &event, 0) != pdTRUE) free(copy);
}

static void send_realtime_chunk(const uint8_t *data, size_t length)
{
    if (mode != MODE_REALTIME || data == NULL || length == 0) return;
    const size_t encoded_capacity = (length * 4 / 3) + 8;
    char *encoded = heap_caps_malloc(encoded_capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (encoded == NULL) return;
    size_t encoded_length = 0;
    if (mbedtls_base64_encode((unsigned char *)encoded, encoded_capacity, &encoded_length, data, length) == 0) {
        encoded[encoded_length] = '\0';
        cJSON *value = new_frame("realtime.chunk");
        cJSON_AddStringToObject(value, "data", encoded);
        fire_and_forget(value);
    }
    free(encoded);
}

static void upload_begin(void)
{
    if (!voice_outbox_oldest(&outgoing)) return;
    if (hold_id[0] && strcmp(hold_id, outgoing.id) == 0) return;
    job = JOB_UP_BEGIN;
    cJSON *value = new_frame("begin");
    cJSON_AddStringToObject(value, "id", outgoing.id);
    cJSON_AddNumberToObject(value, "samples", outgoing.samples);
    request(value);
}

static void upload_failed(void)
{
    finish_job();
    mode = MODE_IDLE;
    retry_at = esp_timer_get_time() + RETRY_US;
}

static void upload_chunk(void)
{
    if (chunk_index * CHUNK >= outgoing.samples) {
        job = JOB_UP_COMMIT;
        cJSON *value = new_frame("commit");
        cJSON_AddStringToObject(value, "id", outgoing.id);
        request(value);
        return;
    }
    job = JOB_UP_CHUNK;
    cJSON *value = new_frame("chunks");
    cJSON_AddStringToObject(value, "id", outgoing.id);
    cJSON *chunks = cJSON_AddArrayToObject(value, "chunks");
    const unsigned index = chunk_index;
    const size_t n = outgoing.samples - index * CHUNK < CHUNK ? outgoing.samples - index * CHUNK : CHUNK;
    uint8_t bytes[CHUNK];
    if (voice_outbox_read(&outgoing, index * CHUNK, bytes, n) != ESP_OK) {
        cJSON_Delete(value);
        upload_failed();
        return;
    }
    char encoded[1028];
    size_t encoded_length = 0;
    if (mbedtls_base64_encode((unsigned char *)encoded, sizeof(encoded), &encoded_length, bytes, n) != 0) {
        cJSON_Delete(value);
        upload_failed();
        return;
    }
    encoded[encoded_length] = '\0';
    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "index", index);
    cJSON_AddStringToObject(item, "data", encoded);
    cJSON_AddItemToArray(chunks, item);
    request(value);
}

static void on_short_key(int key)
{
    const int64_t now = esp_timer_get_time();
    if (mode == MODE_SETTING_ALARM || mode == MODE_SETTING_TIMER) {
        if (key == 2 || key == 3) {
            settings_commit_at = now;
            return;
        }
    }
    switch (key) {
        case 0:
            move_cursor(false);
            break;
        case 1: {
            stop_prompt();
            message_t *message = find_message(cursor_id);
            if (message == NULL) { message = latest_unread(); set_cursor(message); }
            play_message(message);
            break;
        }
        case 2:
            begin_alarm_setting();
            break;
        case 3:
            begin_timer_setting();
            break;
        case 4:
            begin_recording_with_prompt();
            break;
        case 5:
            if (mode == MODE_RECORDING) {
                send_when_saved = true;
                (void)audio_record_stop();
            } else if (mode == MODE_RECORD_READY) {
                hold_id[0] = '\0';
                send_when_saved = true;
                if (job == JOB_CACHE) retry_at = now;
                else if (job == JOB_IDLE) upload_begin();
            }
            break;
        case 6:
            if (!realtime_enabled) {
                start_prompt(PROMPT_REALTIME_DISABLED, PROMPT_ACTION_NONE);
            } else if (!network_fresh(now)) {
                start_prompt(PROMPT_OFFLINE, PROMPT_ACTION_NONE);
            } else {
                begin_realtime_with_prompt();
            }
            break;
        case 7:
        {
            int ids[16], length = 0;
            if (network_fresh(now)) {
                append_prompt(ids, &length, PROMPT_BOARD_ONLINE);
                append_prompt(ids, &length, PROMPT_COMPUTERS);
                if (last_audience_at && now - last_audience_at < 10000000) {
                    append_number(ids, &length, online_clients);
                    append_prompt(ids, &length, PROMPT_PEOPLE_ONLINE);
                } else {
                    append_prompt(ids, &length, PROMPT_UNKNOWN);
                }
            } else {
                append_prompt(ids, &length, PROMPT_BOARD_OFFLINE);
                append_prompt(ids, &length, PROMPT_COMPUTERS);
                append_prompt(ids, &length, PROMPT_UNKNOWN);
            }
            start_prompt_sequence(ids, length, PROMPT_ACTION_NONE);
            break;
        }
        default:
            break;
    }
}

static void on_key(int key, bool down)
{
    if (key < 0 || key > 8) return;
    const int64_t now = esp_timer_get_time();
    if (down) {
        key_consumed[key] = false;
        if (mode == MODE_COUNTDOWN) {
            cancel_countdown(false);
            stop_message_playback();
            key_consumed[key] = true;
            return;
        }
        if (mode == MODE_REALTIME) {
            stop_realtime();
            key_consumed[key] = true;
            return;
        }
        if ((job == JOB_DOWNLOAD || job == JOB_PLAYING) && mode == MODE_PLAYING) {
            stop_message_playback();
            key_consumed[key] = key != 1;
        }
        if (prompt_playing && key != 0 && key != 1) {
            stop_prompt();
            key_consumed[key] = true;
        }
        if (mode == MODE_RECORDING && key != 5) {
            key_consumed[key] = true;
        }
        key_down[key] = now;
        key_held[key] = false;
        return;
    }

    const bool consumed = key_consumed[key];
    const bool held = key_held[key];
    key_down[key] = 0;
    key_held[key] = false;
    key_consumed[key] = false;
    if (!consumed && !held) on_short_key(key);
}

static void on_long_key(int key)
{
    if (key == 0) {
        move_cursor(true);
    } else if (key == 2) {
        const bool removed = timers_set_alarm_minute(-1);
        mode = MODE_IDLE;
        stop_prompt();
        start_prompt(removed ? PROMPT_ALARM_CANCEL : PROMPT_SAVE_FAILED, PROMPT_ACTION_NONE);
    } else if (key == 8) {
        network_setup_begin();
        setup_waiting = true;
        setup_deadline = esp_timer_get_time() + SETUP_LONG_US;
    }
}

static void on_rotate(int delta)
{
    if (delta == 0) return;
    if (mode == MODE_SETTING_ALARM) {
        alarm_draft += delta * 30;
        if (alarm_draft < 0) alarm_draft = 0;
        if (alarm_draft >= 1440) alarm_draft = 1439 - 29;
        settings_commit_at = esp_timer_get_time() + SETTINGS_COMMIT_US;
    } else if (mode == MODE_SETTING_TIMER) {
        timer_draft += delta;
        if (timer_draft < 1) timer_draft = 1;
        if (timer_draft > 60) timer_draft = 60;
        settings_commit_at = esp_timer_get_time() + SETTINGS_COMMIT_US;
    }
}

static void commit_settings(int64_t now)
{
    if (mode != MODE_SETTING_ALARM && mode != MODE_SETTING_TIMER) return;
    if (now < settings_commit_at) return;
    int ids[16], length = 0;
    if (mode == MODE_SETTING_ALARM) {
        const bool saved = timers_set_alarm_minute(alarm_draft);
        mode = MODE_IDLE;
        if (!saved) {
            start_prompt(PROMPT_SAVE_FAILED, PROMPT_ACTION_NONE);
            return;
        }
        append_prompt(ids, &length, PROMPT_ALARM_PREFIX);
        append_number(ids, &length, alarm_draft / 60);
        append_prompt(ids, &length, PROMPT_POINT);
        if (alarm_draft % 60 == 0) append_prompt(ids, &length, PROMPT_WHOLE);
        else {
            append_number(ids, &length, alarm_draft % 60);
            append_prompt(ids, &length, PROMPT_MINUTE);
        }
        append_prompt(ids, &length, PROMPT_SET_SUFFIX);
        start_prompt_sequence(ids, length, PROMPT_ACTION_NONE);
    } else {
        timers_start_countdown(timer_draft);
        mode = MODE_COUNTDOWN;
        append_prompt(ids, &length, PROMPT_COUNTDOWN_PREFIX);
        append_number(ids, &length, timer_draft);
        append_prompt(ids, &length, PROMPT_MINUTES);
        append_prompt(ids, &length, PROMPT_COUNTDOWN_SUFFIX);
        start_prompt_sequence(ids, length, PROMPT_ACTION_NONE);
    }
}

static void handle_timer_events(unsigned timer_events, int64_t now)
{
    if (timer_events & TIMER_EVENT_ALARM) {
        stop_message_playback();
        stop_realtime();
        stop_prompt();
        mode = MODE_IDLE;
        start_prompt(PROMPT_ALARM_DUE, PROMPT_ACTION_NONE);
    }
    if (timer_events & TIMER_EVENT_DONE) {
        stop_prompt();
        mode = MODE_IDLE;
        start_prompt(PROMPT_COUNTDOWN_DONE, PROMPT_ACTION_NONE);
    } else if (timer_events & TIMER_EVENT_MINUTE) {
        if (!prompt_playing && mode == MODE_COUNTDOWN) {
            int ids[16], length = 0;
            append_prompt(ids, &length, PROMPT_REMAINING);
            append_number(ids, &length, timers_countdown_seconds() / 60);
            append_prompt(ids, &length, PROMPT_MINUTES);
            start_prompt_sequence(ids, length, PROMPT_ACTION_NONE);
        }
    } else if ((timer_events & TIMER_EVENT_SECOND) && !prompt_playing && mode == MODE_COUNTDOWN &&
               !(timer_events & TIMER_EVENT_MINUTE)) {
        (void)audio_play_beep(55, false);
    }
    (void)now;
}

static void receive(cJSON *value)
{
    const cJSON *op = cJSON_GetObjectItemCaseSensitive(value, "op");
    const cJSON *req = cJSON_GetObjectItemCaseSensitive(value, "req");
    if (!cJSON_IsString(op)) return;
    if (strcmp(op->valuestring, "pong") == 0 && cJSON_IsString(req) && strcmp(req->valuestring, probe_id) == 0) {
        const cJSON *via = cJSON_GetObjectItemCaseSensitive(value, "via");
        if (cJSON_IsString(via) && (strcmp(via->valuestring, "wifi") == 0 || strcmp(via->valuestring, "ble") == 0)) {
            network_via = strcmp(via->valuestring, "wifi") == 0 ? 1 : 2;
            last_network_at = esp_timer_get_time();
        }
        return;
    }
    if (strcmp(op->valuestring, "settings") == 0) {
        realtime_enabled = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(value, "realtime_enabled"));
        if (!realtime_enabled && mode == MODE_REALTIME) stop_realtime();
        return;
    }
    if (strcmp(op->valuestring, "audience") == 0) {
        const cJSON *clients = cJSON_GetObjectItemCaseSensitive(value, "online_clients");
        if (cJSON_IsNumber(clients) && clients->valueint >= 0 && clients->valueint <= 128) {
            online_clients = clients->valueint;
            last_audience_at = esp_timer_get_time();
        }
        return;
    }
    if (strcmp(op->valuestring, "realtime.stop") == 0 && mode == MODE_REALTIME) {
        stop_realtime();
        return;
    }
    if (strcmp(op->valuestring, "item") == 0) {
        add_item(value);
        return;
    }
    if (!cJSON_IsString(req) || strcmp(req->valuestring, request_id) != 0) return;
    if (strcmp(op->valuestring, "error") == 0) {
        if (uploading()) upload_failed();
        else {
            release_audio();
            finish_job();
            mode = MODE_IDLE;
        }
        return;
    }
    if (job == JOB_INDEX && strcmp(op->valuestring, "index") == 0) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(value, "end"))) {
            for (int i = message_count - 1; i >= 0; i--) {
                if (!messages[i].seen) {
                    memmove(&messages[i], &messages[i + 1], sizeof(messages[0]) * (message_count - i - 1));
                    message_count--;
                }
            }
            finish_job();
        } else {
            add_item(value);
            index_offset++;
            request_index();
        }
    } else if ((job == JOB_DOWNLOAD || job == JOB_PLAYING) && strcmp(op->valuestring, "audio") == 0) {
        const cJSON *index = cJSON_GetObjectItemCaseSensitive(value, "index");
        const cJSON *data = cJSON_GetObjectItemCaseSensitive(value, "data");
        if (!cJSON_IsNumber(index) || index->valueint != (int)chunk_index || !cJSON_IsString(data)) return;
        const size_t expected = audio_size - chunk_index * CHUNK < CHUNK ? audio_size - chunk_index * CHUNK : CHUNK;
        unsigned char decoded[CHUNK];
        size_t length = 0;
        if (mbedtls_base64_decode(decoded, sizeof(decoded), &length, (unsigned char *)data->valuestring,
                                  strlen(data->valuestring)) != 0 || length != expected) return;
        memcpy(audio_data + chunk_index * CHUNK, decoded, length);
        chunk_index++;
        if (!stream_started && chunk_index * CHUNK >= PREBUFFER) {
            if (audio_play_voice_stream(audio_data, audio_size, chunk_index * CHUNK) == ESP_OK) {
                stream_started = true;
                job = JOB_PLAYING;
            } else {
                release_audio();
                finish_job();
                mode = MODE_IDLE;
            }
        } else if (stream_started) {
            (void)audio_voice_stream_extend(chunk_index * CHUNK);
        }
    } else if ((job == JOB_DOWNLOAD || job == JOB_PLAYING) && strcmp(op->valuestring, "streamAck") == 0) {
        const cJSON *next = cJSON_GetObjectItemCaseSensitive(value, "next");
        stream_complete = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(value, "complete"));
        if (!stream_started) {
            if (audio_play_voice_stream(audio_data, audio_size, chunk_index * CHUNK) == ESP_OK) {
                stream_started = true;
                job = JOB_PLAYING;
            } else {
                release_audio();
                finish_job();
                mode = MODE_IDLE;
                return;
            }
        } else {
            (void)audio_voice_stream_extend(chunk_index * CHUNK);
        }
        if (stream_complete) request_line[0] = '\0';
        else if (!cJSON_IsNumber(next) || next->valueint != (int)chunk_index) {
            release_audio();
            finish_job();
            mode = MODE_IDLE;
        } else {
            request_stream();
        }
    } else if (uploading() && strcmp(op->valuestring, "ack") == 0) {
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(value, "committed"))) {
            if (voice_outbox_ack(&outgoing) != ESP_OK) upload_failed();
            else {
                finish_job();
                mode = MODE_IDLE;
                retry_at = 0;
                start_prompt(PROMPT_SEND_OK, PROMPT_ACTION_NONE);
            }
        } else {
            const cJSON *next = cJSON_GetObjectItemCaseSensitive(value, "next");
            if (!cJSON_IsNumber(next) || next->valueint < 0 ||
                (size_t)next->valueint > (outgoing.samples + CHUNK - 1) / CHUNK) return;
            chunk_index = next->valueint;
            upload_chunk();
        }
    } else if (job == JOB_MARK_READ && strcmp(op->valuestring, "ack") == 0) {
        message_t *message = find_message(active_id);
        if (message != NULL) {
            message->read = true;
            message->pending_read = false;
        }
        finish_job();
        mode = MODE_IDLE;
    }
}

static void prompt_task_step(int64_t now)
{
    if (!prompt_playing && prompt_position >= prompt_length) return;
    audio_snapshot_t audio;
    audio_get_snapshot(&audio);
    if (prompt_playing && !audio.speaker_playing) prompt_playing = false;
    if (!prompt_playing) {
        if (prompt_position < prompt_length) {
            size_t length = 0;
            const uint8_t *data = voice_prompt_data(prompt_ids[prompt_position], &length);
            if (data != NULL && length && audio_play_voice(data, length) == ESP_OK) prompt_playing = true;
            else prompt_position++;
        }
        if (!prompt_playing && prompt_position >= prompt_length) {
            const prompt_action_t action = prompt_action;
            prompt_position = 0;
            prompt_length = 0;
            prompt_action = PROMPT_ACTION_NONE;
            if (action == PROMPT_ACTION_START_RECORDING) start_recording();
            else if (action == PROMPT_ACTION_START_REALTIME) {
                if (audio_live_start(realtime_sink) == ESP_OK) {
                    mode = MODE_REALTIME;
                    cJSON *value = new_frame("realtime.start");
                    fire_and_forget(value);
                } else {
                    start_prompt(PROMPT_SAVE_FAILED, PROMPT_ACTION_NONE);
                }
            }
        }
    }
    (void)now;
}

static void task(void *argument)
{
    (void)argument;
    outbox_ready = voice_outbox_init() == ESP_OK;
    if (!outbox_ready) ESP_LOGE(TAG, "Persistent voice outbox unavailable");
    while (true) {
        event_t event;
        if (xQueueReceive(events, &event, pdMS_TO_TICKS(20)) == pdTRUE) {
            if (event.json != NULL) {
                cJSON *value = cJSON_Parse(event.json);
                if (value != NULL) { receive(value); cJSON_Delete(value); }
                free(event.json);
            } else if (event.realtime_data != NULL) {
                send_realtime_chunk(event.realtime_data, event.realtime_length);
                free(event.realtime_data);
            } else if (event.delta != 0) {
                on_rotate(event.delta);
            } else {
                on_key(event.key, event.down);
            }
        }

        const int64_t now = esp_timer_get_time();
        if (now >= probe_at) probe(now);
        for (int key = 0; key < 9; key++) {
            const int64_t threshold = key == 8 ? SETUP_LONG_US : LONG_US;
            if (key_down[key] && !key_held[key] && !key_consumed[key] && now - key_down[key] >= threshold) {
                key_held[key] = true;
                on_long_key(key);
            }
        }
        if (setup_waiting) {
            if (network_setup_active()) {
                start_prompt(PROMPT_SETUP, PROMPT_ACTION_NONE);
                setup_waiting = false;
            } else if (now >= setup_deadline) {
                start_prompt(PROMPT_SETUP_FAILED, PROMPT_ACTION_NONE);
                setup_waiting = false;
            }
        }
        const unsigned timer_events = timers_poll(now);
        handle_timer_events(timer_events, now);
        commit_settings(now);

        audio_snapshot_t audio;
        audio_get_snapshot(&audio);
        if (mode == MODE_RECORDING && !audio.recording) {
            audio_size = audio.recorded_bytes;
            if (audio_size) {
                mode = MODE_RECORD_READY;
                job = JOB_CACHE;
                cache_at = now;
            } else {
                release_audio();
                mode = MODE_IDLE;
            }
        }
        if (job == JOB_CACHE && now >= cache_at && !prompt_playing && !audio.speaker_playing) {
            if (voice_outbox_save(active_id, audio_data, audio_size) == ESP_OK) {
                release_audio();
                finish_job();
                if (send_when_saved) upload_begin();
                else {
                    strlcpy(hold_id, active_id, sizeof(hold_id));
                    mode = MODE_RECORD_READY;
                    start_prompt(PROMPT_RECORD_FINISH, PROMPT_ACTION_NONE);
                }
            } else {
                cache_at = now + RETRY_US;
                start_prompt(PROMPT_SAVE_FAILED, PROMPT_ACTION_NONE);
            }
        }
        if (mode == MODE_PLAYING && job == JOB_PLAYING && !audio.speaker_playing) {
            release_audio();
            message_t *message = find_message(active_id);
            if (audio.voice_completed && audio.speaker_error == ESP_OK && stream_complete && message != NULL) {
                message->pending_read = true;
                mark_read(message);
            } else {
                finish_job();
                mode = MODE_IDLE;
            }
        }
        prompt_task_step(now);

        if (request_line[0] && now - sent_at > ACK_TIMEOUT_US) {
            if (uploading()) upload_failed();
            else if (job == JOB_INDEX) { finish_job(); sync_at = now + RETRY_US; }
            else if (job == JOB_MARK_READ) {
                finish_job();
                mode = MODE_IDLE;
            }
            else if (job == JOB_PLAYING && !stream_complete) {
                (void)audio_stop_speaker();
                release_audio();
                finish_job();
                mode = MODE_IDLE;
            } else if (now - started_at > 60000000) {
                release_audio();
                finish_job();
                mode = MODE_IDLE;
            } else {
                send_line(request_line);
                sent_at = now;
            }
        }

        if (job == JOB_IDLE && network_fresh(now) && !prompt_playing && mode != MODE_RECORDING &&
            mode != MODE_PLAYING && mode != MODE_REALTIME && mode != MODE_COUNTDOWN) {
            message_t *receipt = NULL;
            for (int i = 0; i < message_count; i++) if (messages[i].pending_read) { receipt = &messages[i]; break; }
            if (receipt != NULL) mark_read(receipt);
            else if (now >= sync_at) {
                for (int i = 0; i < message_count; i++) messages[i].seen = false;
                index_offset = 0;
                job = JOB_INDEX;
                request_index();
            } else if (voice_outbox_count() && now >= retry_at) {
                upload_begin();
            }
        } else if (job == JOB_IDLE && network_fresh(now) && mode == MODE_IDLE &&
                   !prompt_playing && voice_outbox_count() && now >= retry_at) {
            upload_begin();
        }
        if (mode == MODE_REALTIME && !network_fresh(now)) {
            stop_realtime();
            start_prompt(PROMPT_OFFLINE, PROMPT_ACTION_NONE);
        }

        static int64_t lights_at;
        if (now >= lights_at) {
            refresh_lights(now);
            lights_at = now + 50000;
        }
        const voice_chat_snapshot_t value = {
            .pending = voice_outbox_count() + (job == JOB_CACHE ? 1 : 0),
            .sending = uploading(),
            .storage_error = !outbox_ready || job == JOB_CACHE,
            .alarm_minute = timers_alarm_minute(),
            .countdown_seconds = timers_countdown_seconds(),
            .realtime_active = mode == MODE_REALTIME,
            .realtime_enabled = realtime_enabled,
            .network_via = network_fresh(now) ? network_via : 0,
        };
        portENTER_CRITICAL(&snapshot_lock);
        snapshot = value;
        portEXIT_CRITICAL(&snapshot_lock);
    }
}

void voice_chat_init(void (*send)(const char *line))
{
    send_line = send;
    timers_init();
    snapshot.alarm_minute = -1;
    events = xQueueCreate(64, sizeof(event_t));
    if (events == NULL || xTaskCreate(task, "voice_timeline", 8192, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Unable to create voice timeline task");
    }
}

bool voice_chat_receive(const cJSON *value)
{
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(value, "type");
    if (!cJSON_IsString(type) || strcmp(type->valuestring, "chat") != 0) return false;
    const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(value, "protocol");
    if (events != NULL && cJSON_IsNumber(protocol) && protocol->valueint == CHAT_PROTOCOL) {
        event_t event = {.json = cJSON_PrintUnformatted(value)};
        if (event.json != NULL && xQueueSend(events, &event, 0) != pdTRUE) free(event.json);
    }
    return true;
}

void voice_chat_key(int key, bool pressed)
{
    if (events == NULL) return;
    const event_t event = {.key = key, .down = pressed};
    (void)xQueueSend(events, &event, 0);
}

void voice_chat_rotate(int delta)
{
    if (events == NULL) return;
    const event_t event = {.delta = delta};
    (void)xQueueSend(events, &event, 0);
}

void voice_chat_get_snapshot(voice_chat_snapshot_t *value)
{
    portENTER_CRITICAL(&snapshot_lock);
    *value = snapshot;
    portEXIT_CRITICAL(&snapshot_lock);
}
