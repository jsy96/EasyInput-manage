#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define STT_TEXT_BYTES 3001
// One durable head plus a bounded in-memory FIFO. Stable IDs make retries idempotent.
typedef struct { char id[33]; char text[STT_TEXT_BYTES]; } stt_text_t;
typedef enum { STT_WAIT, STT_DONE, STT_EMPTY, STT_FAILED, STT_ACTIVATE, STT_CANCELLED, STT_FINISHED, STT_FULL, STT_CAPTURE_STOPPED } stt_event_kind_t;
typedef struct { stt_event_kind_t kind; char code[17]; } stt_event_t;
// No credentials or transcript text. Retained in RAM until the next accepted start.
typedef struct {
    bool busy, capturing;
    char stage[40];
    int error;
    uint64_t captured_bytes, sent_bytes;
    unsigned received_texts, acked_texts;
    size_t queued_texts;
} stt_snapshot_t;
void xiaozhi_stt_init(void);
// Bidirectional, auto-turn conversation. STT results stay inside this session;
// legacy pending texts and their delivery receipts are preserved.
esp_err_t xiaozhi_dialogue_start(void);
// Stops microphone/speaker locally before asynchronous network teardown.
void xiaozhi_dialogue_stop(void);
esp_err_t xiaozhi_stt_start(void);
// Stop sampling, flush the tail and wait for the final server transcript.
void xiaozhi_stt_stop(void);
bool xiaozhi_stt_busy(void);
void xiaozhi_stt_get_snapshot(stt_snapshot_t *snapshot);
// Capture-stop is latched separately from coalescible progress notifications.
// It is emitted once after confirmed microphone teardown, before terminal events.
bool xiaozhi_stt_poll(stt_event_t *event);
bool xiaozhi_stt_pending(stt_text_t *text);
bool xiaozhi_stt_ack(const char *id);
bool xiaozhi_stt_cancel(void);
