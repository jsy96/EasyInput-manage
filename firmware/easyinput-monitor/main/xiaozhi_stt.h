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
    // Chat rows, not server utterances: a long utterance can produce many rows.
    unsigned received_texts, acked_texts;
    size_t queued_texts;
    // Current-session rows still in FIFO; cancellation clears these without ACKs.
    size_t session_queued_texts;
} stt_snapshot_t;
void xiaozhi_stt_init(void);
// S6 bidirectional, auto-turn conversation. STT results stay inside this session;
// pending transcriptions and their delivery receipts are preserved.
esp_err_t xiaozhi_dialogue_start(void);
// Stops microphone/speaker locally before asynchronous network teardown.
void xiaozhi_dialogue_stop(void);
// S7 continuous transcription: queue every user STT result without playing replies.
// Older text remains ahead of this session in the delivery FIFO.
esp_err_t xiaozhi_stt_start(void);
// Stop sampling immediately, flush the tail, then collect final STT for 20 seconds.
void xiaozhi_stt_stop(void);
bool xiaozhi_stt_busy(void);
void xiaozhi_stt_get_snapshot(stt_snapshot_t *snapshot);
// Final S7 display result; an earlier engine failure remains the primary cause.
void xiaozhi_stt_delivery_result(bool success, bool network_ready);
// Capture-stop is latched separately from coalescible progress notifications.
// It is emitted once after confirmed microphone teardown, before terminal events.
bool xiaozhi_stt_poll(stt_event_t *event);
bool xiaozhi_stt_pending(stt_text_t *text);
bool xiaozhi_stt_ack(const char *id);
bool xiaozhi_stt_cancel(void);
