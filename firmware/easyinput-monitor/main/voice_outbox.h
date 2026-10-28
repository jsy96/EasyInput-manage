#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define VOICE_OUTBOX_CAPACITY 8
#define VOICE_OUTBOX_AUDIO_MAX 480000
typedef struct { char id[64]; uint32_t samples; uint32_t sequence; int slot; } voice_outbox_item_t;
// Owned by the voice task. Retrying never writes Flash; only save/acknowledge do.
esp_err_t voice_outbox_init(void);
unsigned voice_outbox_count(void);
bool voice_outbox_oldest(voice_outbox_item_t *item);
esp_err_t voice_outbox_save(const char *id, const uint8_t *audio, size_t length);
esp_err_t voice_outbox_read(const voice_outbox_item_t *item, size_t offset, void *data, size_t length);
esp_err_t voice_outbox_ack(const voice_outbox_item_t *item);
esp_err_t voice_outbox_discard(const char *id);
