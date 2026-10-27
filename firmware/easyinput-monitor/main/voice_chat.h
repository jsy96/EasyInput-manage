#pragma once

#include <stdbool.h>

#include "cJSON.h"

typedef struct {
    unsigned pending;
    bool sending;
    bool storage_error;
    int alarm_minute;
    int countdown_seconds;
    bool realtime_active;
    bool realtime_enabled;
    int network_via;
} voice_chat_snapshot_t;

void voice_chat_init(void (*send)(const char *line));
bool voice_chat_receive(const cJSON *value);
void voice_chat_key(int key, bool pressed);
void voice_chat_rotate(int delta);
void voice_chat_get_snapshot(voice_chat_snapshot_t *value);
