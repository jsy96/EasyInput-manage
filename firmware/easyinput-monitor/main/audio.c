#include "audio.h"

#include <math.h>
#include "lights.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define AUDIO_BLOCK_FRAMES 256
#define AUDIO_IO_TIMEOUT_MS 40
#define MIC_WARMUP_US 100000
#define MIC_STALL_US 500000
#define VAD_START_RMS 300
#define VAD_END_RMS 180
#define VAD_HOLD_US 300000
#define TONE_FRAMES AUDIO_SAMPLE_RATE
#define TONE_FADE_FRAMES (AUDIO_SAMPLE_RATE / 50)
// Six DMA blocks can still be in flight after the last write returns.
#define TONE_DRAIN_US (6LL * AUDIO_BLOCK_FRAMES * 1000000 / AUDIO_SAMPLE_RATE + 20000)

static uint8_t *record_buffer;
static size_t record_capacity;
static const uint8_t *voice_buffer;
static size_t voice_length;
static uint32_t voice_frame;
static int64_t record_deadline_us;
static uint8_t mulaw_encode(int sample)
{
    const int sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 132;
    int exponent = 7;
    for (int mask = 0x4000; exponent > 0 && !(sample & mask); mask >>= 1) exponent--;
    return ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 15));
}
static int16_t mulaw_decode(uint8_t value)
{
    const unsigned u = (uint8_t)~value;
    const int pcm = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
    return (u & 128) ? 132 - pcm : pcm - 132;
}
static SemaphoreHandle_t audio_mutex;
static audio_snapshot_t state;
static i2s_chan_handle_t microphone_channel;
static i2s_chan_handle_t speaker_channel;
static bool microphone_enabled;
static bool speaker_enabled;
static int32_t microphone_samples[AUDIO_BLOCK_FRAMES * 2];
static int16_t speaker_samples[AUDIO_BLOCK_FRAMES * 2];
static int64_t microphone_started_us;
static int64_t microphone_last_data_us;
static int64_t voice_until_us;
static uint32_t tone_frame;
static uint8_t tone_volume;
static int64_t tone_drain_until_us;

static esp_err_t safe_audio_pins(bool microphone)
{
    const gpio_num_t mic_outputs[] = {GPIO_NUM_9, GPIO_NUM_10};
    const gpio_num_t spk_outputs[] = {GPIO_NUM_14, GPIO_NUM_13, GPIO_NUM_15};
    const gpio_num_t *pins = microphone ? mic_outputs : spk_outputs;
    const unsigned count = microphone ? 2 : 3;
    for (unsigned i = 0; i < count; i++) {
        esp_err_t result = gpio_reset_pin(pins[i]);
        if (result == ESP_OK) result = gpio_set_level(pins[i], 0);
        if (result == ESP_OK) result = gpio_set_direction(pins[i], GPIO_MODE_OUTPUT);
        if (result != ESP_OK) return result;
    }
    if (!microphone) return ESP_OK;
    const gpio_config_t input = {
        .pin_bit_mask = 1ULL << GPIO_NUM_11, .mode = GPIO_MODE_DISABLE,
        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    return gpio_config(&input);
}

// Retain handles on cleanup failure: power-off must prove both I2S controllers
// have stopped and detached before lowering GPIO8.
static esp_err_t stop_channel(bool microphone)
{
    i2s_chan_handle_t *channel = microphone ? &microphone_channel : &speaker_channel;
    bool *enabled = microphone ? &microphone_enabled : &speaker_enabled;
    if (microphone) {
        state.microphone_active = false;
        state.recording = false;
        state.rms = 0;
        state.vad = false;
        voice_until_us = 0;
    } else {
        state.speaker_playing = false;
    }
    if (*channel && *enabled) {
        const esp_err_t result = i2s_channel_disable(*channel);
        if (result != ESP_OK) return result;
        *enabled = false;
    }
    if (*channel) {
        const esp_err_t result = i2s_del_channel(*channel);
        if (result != ESP_OK) return result;
        *channel = NULL;
    }
    return safe_audio_pins(microphone);
}

static esp_err_t start_channel(bool microphone)
{
    esp_err_t result = stop_channel(microphone);
    if (result != ESP_OK) return result;
    i2s_chan_handle_t *channel = microphone ? &microphone_channel : &speaker_channel;
    i2s_chan_config_t channel_config = I2S_CHANNEL_DEFAULT_CONFIG(microphone ? I2S_NUM_0 : I2S_NUM_1, I2S_ROLE_MASTER);
    channel_config.dma_desc_num = 6;
    channel_config.dma_frame_num = AUDIO_BLOCK_FRAMES;
    channel_config.auto_clear = true;
    result = i2s_new_channel(&channel_config, microphone ? NULL : channel, microphone ? channel : NULL);
    if (result != ESP_OK) return result;
    const i2s_std_config_t config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        // Capture both slots; schematic SELECT is high. Slot/24-bit alignment
        // remains a project setting requiring assembled-board validation.
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(microphone ? I2S_DATA_BIT_WIDTH_32BIT : I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = microphone ? GPIO_NUM_9 : GPIO_NUM_14,
            .ws = microphone ? GPIO_NUM_10 : GPIO_NUM_13,
            .dout = microphone ? I2S_GPIO_UNUSED : GPIO_NUM_15,
            .din = microphone ? GPIO_NUM_11 : I2S_GPIO_UNUSED,
        },
    };
    result = i2s_channel_init_std_mode(*channel, &config);
    if (result == ESP_OK) result = i2s_channel_enable(*channel);
    if (result == ESP_OK) {
        if (microphone) microphone_enabled = true;
        else speaker_enabled = true;
    } else {
        (void)stop_channel(microphone);
    }
    return result;
}

static void update_microphone(size_t frames, int64_t now)
{
    // DC-free RMS in signed 16-bit units. Use the louder slot so an unused
    // slot cannot halve the measured level.
    double sum[2] = {0}, squares[2] = {0};
    for (size_t i = 0; i < frames; i++) {
        for (int slot = 0; slot < 2; slot++) {
            const double sample = microphone_samples[i * 2 + slot] >> 16;
            sum[slot] += sample;
            squares[slot] += sample * sample;
        }
    }
    double rms = 0;
    for (int slot = 0; slot < 2; slot++) {
        const double mean = sum[slot] / frames;
        const double variance = squares[slot] / frames - mean * mean;
        const double level = sqrt(variance > 0 ? variance : 0);
        if (level > rms) rms = level;
    }
    state.rms = (uint16_t)fmin(rms, 32768);
    const int threshold = state.vad ? VAD_END_RMS : VAD_START_RMS;
    if (state.rms >= threshold) voice_until_us = now + VAD_HOLD_US;
    state.vad = now < voice_until_us;
}

static void audio_task(void *arg)
{
    (void)arg;
    while (true) {
        bool did_io = false;
        xSemaphoreTake(audio_mutex, portMAX_DELAY);
        if (state.recording && esp_timer_get_time() >= record_deadline_us) (void)stop_channel(true);
        if (state.microphone_active) {
            did_io = true;
            size_t bytes = 0;
            esp_err_t result = i2s_channel_read(microphone_channel, microphone_samples, sizeof(microphone_samples), &bytes, AUDIO_IO_TIMEOUT_MS);
            const int64_t now = esp_timer_get_time();
            if ((result == ESP_OK || result == ESP_ERR_TIMEOUT) && bytes >= 2 * sizeof(int32_t)) {
                microphone_last_data_us = now;
                if (now - microphone_started_us >= MIC_WARMUP_US) {
                    const size_t frames = bytes / (2 * sizeof(int32_t));
                    update_microphone(frames, now);
                    if (state.recording && record_buffer != NULL) {
                        // SELECT is high on the board: use the right I2S slot.
                        for (size_t i = 0; i + 1 < frames && state.recorded_bytes < record_capacity; i += 2) {
                            const int a = microphone_samples[i * 2 + 1] >> 16;
                            const int b = microphone_samples[(i + 1) * 2 + 1] >> 16;
                            record_buffer[state.recorded_bytes++] = mulaw_encode((a + b) / 2);
                        }
                        if (state.recorded_bytes >= record_capacity) (void)stop_channel(true);
                    }
                }
                result = ESP_OK;
            } else if (result == ESP_OK || result == ESP_ERR_TIMEOUT) {
                result = now - microphone_last_data_us < MIC_STALL_US ? ESP_OK : ESP_ERR_TIMEOUT;
            }
            if (result != ESP_OK) {
                state.microphone_error = result;
                (void)stop_channel(true);
            }
        }
        if (state.speaker_playing && voice_buffer != NULL && voice_frame < voice_length * 2) {
            did_io = true;
            size_t frames = voice_length * 2 - voice_frame;
            if (frames > AUDIO_BLOCK_FRAMES) frames = AUDIO_BLOCK_FRAMES;
            for (size_t i = 0; i < frames; i++) {
                const int16_t sample = mulaw_decode(voice_buffer[(voice_frame + i) / 2]) * state.volume / 100;
                speaker_samples[i * 2] = speaker_samples[i * 2 + 1] = sample;
            }
            size_t written = 0;
            esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples, frames * 4, &written, AUDIO_IO_TIMEOUT_MS);
            if (result != ESP_OK || written != frames * 4) {
                state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
                (void)stop_channel(false);
            } else {
                voice_frame += frames;
                if (voice_frame == voice_length * 2) tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
            }
        } else if (state.speaker_playing && voice_buffer == NULL && tone_frame < TONE_FRAMES) {
            did_io = true;
            unsigned frames = TONE_FRAMES - tone_frame;
            if (frames > AUDIO_BLOCK_FRAMES) frames = AUDIO_BLOCK_FRAMES;
            for (unsigned i = 0; i < frames; i++) {
                const uint32_t frame = tone_frame + i;
                const uint32_t remaining = TONE_FRAMES - 1 - frame;
                const float fade = fminf(1.0f, (float)(frame < remaining ? frame : remaining) / TONE_FADE_FRAMES);
                const int16_t sample = (int16_t)(32767.0f * tone_volume / 100.0f * fade * sinf(2.0f * 3.14159265358979323846f * 440.0f * frame / AUDIO_SAMPLE_RATE));
                speaker_samples[i * 2] = sample;
                speaker_samples[i * 2 + 1] = sample;
            }
            size_t written = 0;
            const esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples, frames * 2 * sizeof(int16_t), &written, AUDIO_IO_TIMEOUT_MS);
            if (result != ESP_OK || written != frames * 2 * sizeof(int16_t)) {
                state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
                (void)stop_channel(false);
            } else {
                tone_frame += frames;
                if (tone_frame == TONE_FRAMES) tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
            }
        } else if (state.speaker_playing && esp_timer_get_time() >= tone_drain_until_us) {
            const esp_err_t result = stop_channel(false);
            if (result != ESP_OK) state.speaker_error = result;
            else if (voice_buffer != NULL && voice_frame == voice_length * 2) state.voice_completed = true;
        }
        xSemaphoreGive(audio_mutex);
        // DMA blocks active I/O. An extra tick would starve 16 ms audio blocks.
        if (!did_io) vTaskDelay(pdMS_TO_TICKS(10) + 1);
    }
}

esp_err_t audio_init(void)
{
    state.volume = 20;
    audio_mutex = xSemaphoreCreateMutex();
    if (!audio_mutex) return ESP_ERR_NO_MEM;
    state.ready = true;
    if (xTaskCreate(audio_task, "audio_io", 4096, NULL, 4, NULL) != pdPASS) {
        state.ready = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void audio_get_snapshot(audio_snapshot_t *snapshot)
{
    if (audio_mutex) xSemaphoreTake(audio_mutex, portMAX_DELAY);
    *snapshot = state;
    if (audio_mutex) xSemaphoreGive(audio_mutex);
}

static esp_err_t start_microphone(void *arg)
{
    (void)arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    esp_err_t result = ESP_OK;
    if (!state.microphone_active) {
        result = start_channel(true);
        state.microphone_active = result == ESP_OK;
        state.microphone_error = result;
        microphone_started_us = microphone_last_data_us = esp_timer_get_time();
    }
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_set_microphone(bool on)
{
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    if (on) return lights_with_shared_power(start_microphone, NULL);
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    const esp_err_t result = stop_channel(true);
    if (result != ESP_OK) state.microphone_error = result;
    xSemaphoreGive(audio_mutex);
    return result;
}

static esp_err_t start_test(void *arg)
{
    const uint8_t volume = *(uint8_t *)arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    const esp_err_t result = start_channel(false);
    state.speaker_error = result;
    if (result == ESP_OK) {
        voice_buffer = NULL;
        state.voice_completed = false;
        tone_volume = volume;
        state.speaker_playing = true;
        tone_frame = 0;
        tone_drain_until_us = 0;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_play_test(uint8_t volume)
{
    if (volume == 0 || volume > AUDIO_TEST_VOLUME_MAX) return ESP_ERR_INVALID_ARG;
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    return lights_with_shared_power(start_test, &volume);
}

esp_err_t audio_stop_speaker(void)
{
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    const esp_err_t result = stop_channel(false);
    if (result != ESP_OK) state.speaker_error = result;
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_prepare_power_off(void)
{
    if (!audio_mutex) return ESP_OK;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    const esp_err_t mic_result = stop_channel(true);
    const esp_err_t spk_result = stop_channel(false);
    if (mic_result != ESP_OK) state.microphone_error = mic_result;
    if (spk_result != ESP_OK) state.speaker_error = spk_result;
    xSemaphoreGive(audio_mutex);
    return mic_result != ESP_OK ? mic_result : spk_result;
}

typedef struct { const uint8_t *buffer; size_t length; } voice_context_t;
static esp_err_t start_voice(void *arg)
{
    const voice_context_t *context = arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (state.recording || state.speaker_playing) { xSemaphoreGive(audio_mutex); return ESP_ERR_INVALID_STATE; }
    esp_err_t result = start_channel(false);
    state.speaker_error = result;
    if (result == ESP_OK) {
        voice_buffer = context->buffer; voice_length = context->length;
        state.voice_completed = false;
        state.speaker_playing = true;
        voice_frame = 0;
        tone_drain_until_us = 0;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}
esp_err_t audio_play_voice(const uint8_t *buffer, size_t length)
{
    if (buffer == NULL || length == 0 || length > 480000) return ESP_ERR_INVALID_ARG;
    const voice_context_t context = {.buffer = buffer, .length = length};
    return lights_with_shared_power(start_voice, (void *)&context);
}
esp_err_t audio_set_volume(uint8_t volume)
{
    if (!audio_mutex || volume > 100) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    state.volume = volume;
    xSemaphoreGive(audio_mutex);
    return ESP_OK;
}
static esp_err_t start_record(void *arg)
{
    const voice_context_t *context = arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    esp_err_t result = stop_channel(false);
    if (result == ESP_OK) result = start_channel(true);
    state.microphone_error = result;
    if (result == ESP_OK) {
        microphone_started_us = microphone_last_data_us = esp_timer_get_time();
        record_buffer = (uint8_t *)context->buffer; record_capacity = context->length;
        state.recorded_bytes = 0; state.recording = true; state.microphone_active = true;
        record_deadline_us = esp_timer_get_time() + 60000000;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}
esp_err_t audio_record_start(uint8_t *buffer, size_t capacity)
{
    if (buffer == NULL || capacity == 0 || capacity > 480000) return ESP_ERR_INVALID_ARG;
    const voice_context_t context = {.buffer = buffer, .length = capacity};
    return lights_with_shared_power(start_record, (void *)&context);
}
esp_err_t audio_record_stop(void) { return audio_set_microphone(false); }
