#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The owner supplies storage and synchronization. A single producer captures
// audio while the consumer retains it until the transport accepts the frame.
typedef struct {
    uint8_t *data;
    size_t capacity, read, size;
    uint64_t accepted, consumed;
    bool overflow;
} stt_stream_t;

void stt_stream_init(stt_stream_t *stream, uint8_t *storage, size_t capacity);
bool stt_stream_write(stt_stream_t *stream, const uint8_t *data, size_t length);
size_t stt_stream_peek(const stt_stream_t *stream, uint8_t *output, size_t capacity);
bool stt_stream_consume(stt_stream_t *stream, size_t length);
