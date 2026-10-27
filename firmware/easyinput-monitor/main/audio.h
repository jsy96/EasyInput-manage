#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#define AUDIO_SAMPLE_RATE 16000
#define AUDIO_TEST_VOLUME_MAX 20

typedef struct {
    bool ready;
    bool recording;
    size_t recorded_bytes;
    bool voice_completed;
    bool microphone_active;
    bool speaker_playing;
    uint16_t rms;
    bool vad;
    uint8_t volume;
    esp_err_t microphone_error;
    esp_err_t speaker_error;
} audio_snapshot_t;

typedef void (*audio_microphone_sink_t)(const uint8_t *data, size_t length);

esp_err_t audio_init(void);
void audio_get_snapshot(audio_snapshot_t *snapshot);
esp_err_t audio_set_microphone(bool on);
esp_err_t audio_play_test(uint8_t volume);
esp_err_t audio_play_beep(uint16_t duration_ms, bool strong);
esp_err_t audio_stop_speaker(void);
esp_err_t audio_set_volume(uint8_t volume);
// Lock order is shared rail -> audio -> I2S. The worker never takes the rail gate.
esp_err_t audio_prepare_power_off(void);

esp_err_t audio_record_start(uint8_t *buffer, size_t capacity);
esp_err_t audio_record_stop(void);
esp_err_t audio_play_voice(const uint8_t *buffer, size_t length);
esp_err_t audio_play_voice_stream(const uint8_t *buffer, size_t length, size_t available);
esp_err_t audio_voice_stream_extend(size_t available);
esp_err_t audio_live_start(audio_microphone_sink_t sink);
esp_err_t audio_live_stop(void);
