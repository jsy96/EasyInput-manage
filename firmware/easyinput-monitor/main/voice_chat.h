#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

typedef enum {
    VOICE_CHAT_WIFI_DISCONNECTED,
    VOICE_CHAT_WIFI_CONNECTING,
    VOICE_CHAT_WIFI_CONNECTED,
} voice_chat_wifi_state_t;

typedef struct {
    unsigned pending;
    unsigned health_pending;
    unsigned ledger_pending;
    bool sending;
    bool storage_error;
    int alarm_minute;
    int countdown_seconds;
    bool stopwatch_running;
    uint32_t stopwatch_seconds;
    bool realtime_active;
    bool realtime_enabled;
    int network_via;
    unsigned message_count;
    bool cursor_present;
    unsigned mode;
    unsigned job;
    unsigned audio_size;
    unsigned chunk_index;
    unsigned expected_chunks;
    bool stream_started;
    bool stream_complete;
    bool network_fresh;
    unsigned s5_events;
    unsigned s6_down_events;
    unsigned s6_up_events;
    unsigned s6_actions;
    unsigned s7_events;
    unsigned realtime_starts;
    unsigned realtime_stops;
    bool realtime_ready;
    unsigned realtime_acks;
    unsigned realtime_failures;
    unsigned realtime_chunks_queued;
    unsigned realtime_chunks_dropped;
    unsigned realtime_sink_calls;
    unsigned realtime_sink_bytes;
    unsigned input_dropped;
    unsigned control_dropped;
    unsigned input_waiting;
    unsigned control_waiting;
    unsigned realtime_waiting;
    int last_key;
    unsigned last_key_mode;
    int stage;
} voice_chat_snapshot_t;

void voice_chat_init(void (*send)(const char *line),
                     bool (*send_binary)(const uint8_t *data, size_t length),
                     bool (*send_immediate)(const char *line),
                     bool (*is_cloud_online)(void),
                     voice_chat_wifi_state_t (*get_wifi_state)(void));
bool voice_chat_receive(const cJSON *value);
void voice_chat_key(int key, bool pressed);
void voice_chat_rotate(int delta);
void voice_chat_get_snapshot(voice_chat_snapshot_t *value);
