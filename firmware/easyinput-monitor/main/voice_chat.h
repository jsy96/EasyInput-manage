#pragma once
#include <stdbool.h>
#include "cJSON.h"
typedef struct { unsigned pending; bool sending, storage_error, s8_enabled; int network_via; } voice_chat_snapshot_t;
void voice_chat_init(void (*send)(const char *line));
bool voice_chat_receive(const cJSON *value);
void voice_chat_key(int key, bool pressed);
void voice_chat_rotate(int delta);
void voice_chat_get_snapshot(voice_chat_snapshot_t *value);
