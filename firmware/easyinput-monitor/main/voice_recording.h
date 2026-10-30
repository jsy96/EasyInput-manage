#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define VOICE_RECORDING_CHUNK 768
#define VOICE_RECORDING_BATCH (VOICE_RECORDING_CHUNK * 8)
#define VOICE_RECORDING_MAX 0x7ffff000u

// One capture producer and one transport consumer; owner supplies synchronization.
// A packet stays in the ring until the cloud durably acknowledges its exact end.
typedef struct {
    uint8_t *data;
    size_t capacity, head, size, inflight;
    uint32_t accepted, acknowledged;
    int16_t half;
    bool has_half, stopped, failed;
} voice_recording_t;
void voice_recording_init(voice_recording_t *r, uint8_t *storage, size_t capacity);
bool voice_recording_pcm(voice_recording_t *r, const uint8_t *pcm, size_t bytes);
void voice_recording_stop(voice_recording_t *r);
size_t voice_recording_packet(voice_recording_t *r, uint8_t *out, size_t capacity);
bool voice_recording_ack(voice_recording_t *r, uint32_t offset);
// Converts 8 kHz mu-law to the existing bounded 16 kHz speaker API.
void voice_recording_decode(const uint8_t *bytes, size_t length, int16_t *pcm);
