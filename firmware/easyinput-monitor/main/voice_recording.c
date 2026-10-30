#include "voice_recording.h"
#include <string.h>

static uint8_t encode(int sample)
{
    const int sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 132;
    int exponent = 7;
    for (int mask = 0x4000; exponent > 0 && !(sample & mask); mask >>= 1) exponent--;
    return (uint8_t)~(sign | exponent << 4 | ((sample >> (exponent + 3)) & 15));
}
static bool append(voice_recording_t *r, int sample)
{
    if (r->size == r->capacity || r->accepted == VOICE_RECORDING_MAX) {
        r->failed = true;
        return false;
    }
    r->data[(r->head + r->size++) % r->capacity] = encode(sample);
    r->accepted++;
    return true;
}
void voice_recording_init(voice_recording_t *r, uint8_t *storage, size_t capacity)
{
    memset(r, 0, sizeof(*r));
    r->data = storage; r->capacity = capacity;
}
bool voice_recording_pcm(voice_recording_t *r, const uint8_t *pcm, size_t bytes)
{
    if (r->stopped || r->failed) return false;
    if (bytes % 2) { r->failed = true; return false; }
    for (size_t i = 0; i < bytes; i += 2) {
        const int16_t sample = (int16_t)((uint16_t)pcm[i] | (uint16_t)pcm[i + 1] << 8);
        if (r->has_half) {
            r->has_half = false;
            if (!append(r, ((int)r->half + sample) / 2)) return false;
        } else { r->half = sample; r->has_half = true; }
    }
    return true;
}
void voice_recording_stop(voice_recording_t *r)
{
    if (r->stopped) return;
    if (r->has_half && !r->failed) (void)append(r, r->half);
    r->has_half = false;
    r->stopped = true;
}
size_t voice_recording_packet(voice_recording_t *r, uint8_t *out, size_t capacity)
{
    if (!r->inflight) {
        size_t n = r->size < VOICE_RECORDING_BATCH ? r->size : VOICE_RECORDING_BATCH;
        if (!r->stopped) n -= n % VOICE_RECORDING_CHUNK;
        r->inflight = n;
    }
    if (capacity < r->inflight) return 0;
    for (size_t i = 0; i < r->inflight; i++) out[i] = r->data[(r->head + i) % r->capacity];
    return r->inflight;
}
bool voice_recording_ack(voice_recording_t *r, uint32_t offset)
{
    if (!r->inflight || offset != r->acknowledged + r->inflight) return false;
    r->head = (r->head + r->inflight) % r->capacity;
    r->size -= r->inflight;
    r->acknowledged = offset;
    r->inflight = 0;
    return true;
}
void voice_recording_decode(const uint8_t *bytes, size_t length, int16_t *pcm)
{
    for (size_t i = 0; i < length; i++) {
        const unsigned u = (uint8_t)~bytes[i];
        const int sample = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
        pcm[i * 2] = pcm[i * 2 + 1] = u & 128 ? 132 - sample : sample - 132;
    }
}
