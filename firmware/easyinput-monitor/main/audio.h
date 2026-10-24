#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define AUDIO_SAMPLE_RATE 16000
#define AUDIO_TEST_VOLUME_MAX 20

typedef struct {
    bool ready;
    bool microphone_active;
    bool speaker_playing;
    uint16_t rms;
    bool vad;
    uint8_t volume;
    esp_err_t microphone_error;
    esp_err_t speaker_error;
} audio_snapshot_t;

esp_err_t audio_init(void);
void audio_get_snapshot(audio_snapshot_t *snapshot);
esp_err_t audio_set_microphone(bool on);
esp_err_t audio_play_test(uint8_t volume);
esp_err_t audio_stop_speaker(void);
// Lock order is shared rail -> audio -> I2S. The worker never takes the rail gate.
esp_err_t audio_prepare_power_off(void);
