#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#define STT_TEXT_BYTES 3001
// One durable head plus a bounded in-memory FIFO. Stable IDs make retries idempotent.
typedef struct { char id[33]; char text[STT_TEXT_BYTES]; } stt_text_t;
typedef enum { STT_WAIT, STT_DONE, STT_EMPTY, STT_FAILED, STT_ACTIVATE, STT_CANCELLED, STT_FINISHED, STT_FULL } stt_event_kind_t;
typedef struct { stt_event_kind_t kind; char code[17]; } stt_event_t;
void xiaozhi_stt_init(void);
esp_err_t xiaozhi_stt_start(void);
// Stop sampling, flush the tail and wait for the final server transcript.
void xiaozhi_stt_stop(void);
bool xiaozhi_stt_busy(void);
bool xiaozhi_stt_poll(stt_event_t *event);
bool xiaozhi_stt_pending(stt_text_t *text);
bool xiaozhi_stt_ack(const char *id);
bool xiaozhi_stt_cancel(void);
