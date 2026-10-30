#include "audio.h"

#include <math.h>
#include <string.h>
#include "lights.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "nvs.h"
#include "esp_heap_caps.h"
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
#define TONE_FADE_FRAMES (AUDIO_SAMPLE_RATE / 50)
#define LIVE_FRAME_FRAMES (AUDIO_SAMPLE_RATE / 50)
#define LIVE_FRAME_BYTES (LIVE_FRAME_FRAMES * sizeof(int16_t))
#define PCM_BUFFER_FRAMES (AUDIO_SAMPLE_RATE * 4)
#define VOLUME_SAVE_DELAY_US 750000LL
#define VOLUME_SAVE_ATTEMPTS 3
// Six DMA blocks can still be in flight after the last write returns.
#define TONE_DRAIN_US (6LL * AUDIO_BLOCK_FRAMES * 1000000 / AUDIO_SAMPLE_RATE + 20000)

static uint8_t *record_buffer;
static size_t record_capacity;
static const uint8_t *voice_buffer;
static size_t voice_length;
static size_t voice_available;
static uint32_t voice_frame;
static uint32_t voice_target_frames;
static bool voice_loop;
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
static volatile bool mic_stop_requested;
static volatile esp_err_t microphone_stop_error;
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
static uint32_t tone_target_frames;
static float tone_frequency;
static uint8_t tone_volume;
static uint32_t notification_frame, notification_target_frames;
static bool notification_only;
static int64_t tone_drain_until_us;
static audio_microphone_sink_t live_sink;
static int16_t live_chunk[LIVE_FRAME_FRAMES];
static size_t live_chunk_frames;
// Owned by audio_mutex. Kept for subsequent replies, with a fixed memory bound.
static int16_t *pcm_buffer;
static size_t pcm_head, pcm_size;
static bool pcm_active, pcm_finished;
static bool volume_dirty;
static uint8_t saved_volume;
static unsigned volume_save_attempts;
static int64_t volume_save_at;

static void load_volume(void)
{
    state.volume = 20;
    nvs_handle_t handle;
    if (nvs_open("audio", NVS_READONLY, &handle) == ESP_OK) {
        uint8_t stored;
        if (nvs_get_u8(handle, "volume", &stored) == ESP_OK && stored <= 100) state.volume = stored;
        nvs_close(handle);
    }
    saved_volume = state.volume;
    volume_dirty = false;
    volume_save_attempts = 0;
}

// Called with audio_mutex held, only while both I2S consumers are idle.
// Coalesce encoder ticks and never write Flash during capture or playback.
static void save_volume_if_idle(int64_t now)
{
    if (!volume_dirty || state.microphone_active || state.speaker_playing || now < volume_save_at) return;
    nvs_handle_t handle;
    esp_err_t result = nvs_open("audio", NVS_READWRITE, &handle);
    const char *stage = "open";
    if (result == ESP_OK) {
        stage = "set";
        result = nvs_set_u8(handle, "volume", state.volume);
        if (result == ESP_OK) { stage = "commit"; result = nvs_commit(handle); }
        nvs_close(handle);
    }
    if (result == ESP_OK) {
        saved_volume = state.volume;
        volume_dirty = false;
    } else {
        ESP_LOGE("audio", "Volume NVS %s failed: %s (0x%x)", stage, esp_err_to_name(result), (unsigned)result);
        if (++volume_save_attempts >= VOLUME_SAVE_ATTEMPTS) volume_dirty = false;
        else volume_save_at = now + VOLUME_SAVE_DELAY_US;
    }
}

// Called only with audio_mutex held, after the current I2S block has been
// delivered. Preserve the final short block before detaching the consumer.
static void finish_live_capture(void)
{
    if (live_sink && live_chunk_frames) {
        live_sink((const uint8_t *)live_chunk, live_chunk_frames * sizeof(int16_t));
    }
    live_sink = NULL;
    live_chunk_frames = 0;
}

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
        notification_frame = notification_target_frames = 0;
        notification_only = false;
        pcm_active = pcm_finished = false;
        pcm_head = pcm_size = 0;
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
    // Keep the DMA rings small enough for the fragmented internal-RAM pool.
    // Microphone uses 16 ms total; speaker retains 32 ms for smoother output.
    channel_config.dma_desc_num = 4;
    channel_config.dma_frame_num = microphone ? 64 : 128;
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

// Overlay the minute cue in the same I2S stream, including during alarm music.
// Clamp the sum rather than wrapping loud music into a clipped negative sample.
static void mix_notification(size_t frames)
{
    for (size_t i = 0; i < frames && notification_frame < notification_target_frames; i++, notification_frame++) {
        const uint32_t remaining = notification_target_frames - 1 - notification_frame;
        const float fade = fminf(1.0f, (float)(notification_frame < remaining ? notification_frame : remaining) / TONE_FADE_FRAMES);
        const int tone = (int)(32767.0f * 0.18f * fade * sinf(2.0f * 3.14159265358979323846f * 880.0f * notification_frame / AUDIO_SAMPLE_RATE));
        int mixed = speaker_samples[i * 2] + tone;
        if (mixed > INT16_MAX) mixed = INT16_MAX;
        if (mixed < INT16_MIN) mixed = INT16_MIN;
        speaker_samples[i * 2] = speaker_samples[i * 2 + 1] = (int16_t)mixed;
    }
}

static bool notification_tail_step(void)
{
    size_t frames = notification_target_frames - notification_frame;
    if (!frames) return false;
    if (frames > AUDIO_BLOCK_FRAMES) frames = AUDIO_BLOCK_FRAMES;
    memset(speaker_samples, 0, frames * 2 * sizeof(int16_t));
    mix_notification(frames);
    size_t written = 0;
    const esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples, frames * 4, &written, AUDIO_IO_TIMEOUT_MS);
    if (result != ESP_OK || written != frames * 4) {
        state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
        (void)stop_channel(false);
    } else tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
    return true;
}

// Called with audio_mutex held. A temporary network underrun keeps the session
// open; only EOF plus an empty queue and drained DMA is a successful playback.
static bool pcm_playback_step(void)
{
    if (!pcm_active || !state.speaker_playing) return false;
    if (pcm_size) {
        const size_t frames = pcm_size < AUDIO_BLOCK_FRAMES ? pcm_size : AUDIO_BLOCK_FRAMES;
        for (size_t i = 0; i < frames; i++) {
            const int16_t sample = (int32_t)pcm_buffer[(pcm_head + i) % PCM_BUFFER_FRAMES] * state.volume / 100;
            speaker_samples[i * 2] = speaker_samples[i * 2 + 1] = sample;
        }
        mix_notification(frames);
        size_t written = 0;
        const esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples,
            frames * 2 * sizeof(int16_t), &written, AUDIO_IO_TIMEOUT_MS);
        if (result != ESP_OK || written != frames * 2 * sizeof(int16_t)) {
            state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
            (void)stop_channel(false);
        } else {
            pcm_head = (pcm_head + frames) % PCM_BUFFER_FRAMES;
            pcm_size -= frames;
            tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
        }
        return true;
    }
    if (notification_frame < notification_target_frames) return notification_tail_step();
    if (pcm_finished && esp_timer_get_time() >= tone_drain_until_us) {
        const esp_err_t result = stop_channel(false);
        if (result != ESP_OK) state.speaker_error = result;
        else state.voice_completed = true;
    }
    return false;
}

static bool voice_playback_step(void)
{
    state.stage = 5;
    size_t frames = voice_target_frames - voice_frame;
    if (!voice_loop && frames > voice_available * 2 - voice_frame) frames = voice_available * 2 - voice_frame;
    if (frames > AUDIO_BLOCK_FRAMES) frames = AUDIO_BLOCK_FRAMES;
    for (size_t i = 0; i < frames; i++) {
        const size_t sample_index = ((voice_frame + i) / 2) % voice_length;
        const int16_t sample = mulaw_decode(voice_buffer[sample_index]) * state.volume / 100;
        speaker_samples[i * 2] = speaker_samples[i * 2 + 1] = sample;
    }
    mix_notification(frames);
    size_t written = 0;
    const esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples, frames * 4, &written, AUDIO_IO_TIMEOUT_MS);
    if (result != ESP_OK || written != frames * 4) {
        state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
        (void)stop_channel(false);
    } else {
        voice_frame += frames;
        if (voice_frame == voice_target_frames) tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
    }
    return true;
}

static void audio_task(void *arg)
{
    (void)arg;
    while (true) {
        bool did_io = false;
        state.stage = 1;
        xSemaphoreTake(audio_mutex, portMAX_DELAY);
        state.stage = 2;
        if (mic_stop_requested) {
            // The audio task owns the microphone teardown: callers request the
            // stop instead of contending with the busy capture loop for the
            // mutex, which starved the voice timeline task after S1.
            state.stage = 10;
            finish_live_capture();
            microphone_stop_error = stop_channel(true);
            if (microphone_stop_error != ESP_OK) state.microphone_error = microphone_stop_error;
            mic_stop_requested = false;
        }
        if (state.recording && esp_timer_get_time() >= record_deadline_us) (void)stop_channel(true);
        if (state.microphone_active) {
            state.stage = 3;
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
                    if (live_sink != NULL) {
                        state.stage = 4;
                        for (size_t i = 0; i < frames; i++) {
                            live_chunk[live_chunk_frames++] = (int16_t)(microphone_samples[i * 2 + 1] >> 16);
                            if (live_chunk_frames == LIVE_FRAME_FRAMES) {
                                live_sink((const uint8_t *)live_chunk, LIVE_FRAME_BYTES);
                                live_chunk_frames = 0;
                            }
                        }
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
        if (pcm_active) {
            did_io = pcm_playback_step() || did_io;
        } else if (state.speaker_playing && voice_buffer != NULL &&
                   voice_frame < voice_target_frames && (voice_loop || voice_frame < voice_available * 2)) {
            did_io = voice_playback_step() || did_io;
        } else if (state.speaker_playing && voice_buffer == NULL && tone_frame < tone_target_frames) {
            state.stage = 6;
            did_io = true;
            unsigned frames = tone_target_frames - tone_frame;
            if (frames > AUDIO_BLOCK_FRAMES) frames = AUDIO_BLOCK_FRAMES;
            for (unsigned i = 0; i < frames; i++) {
                const uint32_t frame = tone_frame + i;
                const uint32_t remaining = tone_target_frames - 1 - frame;
                const float fade = fminf(1.0f, (float)(frame < remaining ? frame : remaining) / TONE_FADE_FRAMES);
                const int16_t sample = (int16_t)(32767.0f * tone_volume / 100.0f * fade * sinf(2.0f * 3.14159265358979323846f * tone_frequency * frame / AUDIO_SAMPLE_RATE));
                speaker_samples[i * 2] = sample;
                speaker_samples[i * 2 + 1] = sample;
            }
            mix_notification(frames);
            size_t written = 0;
            const esp_err_t result = i2s_channel_write(speaker_channel, speaker_samples, frames * 2 * sizeof(int16_t), &written, AUDIO_IO_TIMEOUT_MS);
            if (result != ESP_OK || written != frames * 2 * sizeof(int16_t)) {
                state.speaker_error = result != ESP_OK ? result : ESP_ERR_TIMEOUT;
                (void)stop_channel(false);
            } else {
                tone_frame += frames;
                if (tone_frame == tone_target_frames) tone_drain_until_us = esp_timer_get_time() + TONE_DRAIN_US;
            }
        } else if (state.speaker_playing && notification_frame < notification_target_frames) {
            did_io = notification_tail_step() || did_io;
        } else if (state.speaker_playing && voice_buffer != NULL &&
                   voice_frame >= voice_target_frames && esp_timer_get_time() >= tone_drain_until_us) {
            const esp_err_t result = stop_channel(false);
            if (result != ESP_OK) state.speaker_error = result;
            else state.voice_completed = true;
        } else if (state.speaker_playing && voice_buffer == NULL &&
                   esp_timer_get_time() >= tone_drain_until_us) {
            const esp_err_t result = stop_channel(false);
            if (result != ESP_OK) state.speaker_error = result;
        }
        save_volume_if_idle(esp_timer_get_time());
        xSemaphoreGive(audio_mutex);
        // DMA paces active I/O. Give equal-priority mutex waiters a chance to
        // run before reacquiring the lock, without adding a whole tick delay.
        if (did_io) {
            taskYIELD();
        } else {
            state.stage = 7;
            vTaskDelay(pdMS_TO_TICKS(10) + 1);
        }
    }
}

esp_err_t audio_init(void)
{
    load_volume();
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
    snapshot->live_sink_active = live_sink != NULL;
    snapshot->live_chunk_frames = live_chunk_frames;
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
    state.stage = 8;
    mic_stop_requested = true;
    for (int attempt = 0; attempt < 20; attempt++) {
        if (!mic_stop_requested) {
            state.stage = 9;
            return microphone_stop_error;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    // Fallback: the capture task may be wedged; stop from here with a bounded
    // wait so this call can never hang the voice timeline task.
    if (xSemaphoreTake(audio_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    finish_live_capture();
    const esp_err_t result = stop_channel(true);
    microphone_stop_error = result;
    mic_stop_requested = false;
    if (result != ESP_OK) state.microphone_error = result;
    xSemaphoreGive(audio_mutex);
    state.stage = 9;
    return result;
}

typedef struct { uint8_t volume; uint16_t duration_ms; float frequency; bool overlay; } tone_context_t;
static esp_err_t start_test(void *arg)
{
    const tone_context_t *context = arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (context->overlay) {
        esp_err_t result = ESP_OK;
        if (!state.speaker_playing) {
            result = start_channel(false);
            state.speaker_error = result;
            if (result == ESP_OK) {
                voice_buffer = NULL;
                tone_frame = tone_target_frames = 0;
                notification_only = true;
                state.speaker_playing = true;
                tone_drain_until_us = 0;
            }
        }
        if (result == ESP_OK) {
            notification_frame = 0;
            notification_target_frames = (uint32_t)AUDIO_SAMPLE_RATE * context->duration_ms / 1000;
        }
        xSemaphoreGive(audio_mutex);
        return result;
    }
    const esp_err_t result = start_channel(false);
    state.speaker_error = result;
    if (result == ESP_OK) {
        voice_buffer = NULL;
        state.voice_completed = false;
        tone_volume = context->volume;
        tone_target_frames = (uint32_t)AUDIO_SAMPLE_RATE * context->duration_ms / 1000;
        tone_frequency = context->frequency;
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
    const tone_context_t context = {.volume = volume, .duration_ms = 1000, .frequency = 440.0f};
    return lights_with_shared_power(start_test, (void *)&context);
}

esp_err_t audio_play_beep(uint16_t duration_ms, bool strong)
{
    if (duration_ms < 30 || duration_ms > 1000 || !audio_mutex || !state.ready) return ESP_ERR_INVALID_ARG;
    const tone_context_t context = {
        .volume = strong ? 32 : 18,
        .duration_ms = duration_ms,
        .frequency = strong ? 660.0f : 880.0f,
    };
    return lights_with_shared_power(start_test, (void *)&context);
}

esp_err_t audio_play_notification(uint16_t duration_ms)
{
    if (duration_ms < 30 || duration_ms > 1000 || !audio_mutex || !state.ready) return ESP_ERR_INVALID_ARG;
    const tone_context_t context = {.volume = 18, .duration_ms = duration_ms, .frequency = 880.0f, .overlay = true};
    return lights_with_shared_power(start_test, (void *)&context);
}

esp_err_t audio_stop_notification(void)
{
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    notification_frame = notification_target_frames = 0;
    const esp_err_t result = notification_only && state.speaker_playing ? stop_channel(false) : ESP_OK;
    notification_only = false;
    if (result != ESP_OK) state.speaker_error = result;
    xSemaphoreGive(audio_mutex);
    return result;
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

typedef struct { const uint8_t *buffer; size_t length; size_t available; uint32_t repeat_frames; } voice_context_t;
static esp_err_t start_voice(void *arg)
{
    const voice_context_t *context = arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (state.recording || state.speaker_playing) { xSemaphoreGive(audio_mutex); return ESP_ERR_INVALID_STATE; }
    esp_err_t result = start_channel(false);
    state.speaker_error = result;
    if (result == ESP_OK) {
        voice_buffer = context->buffer; voice_length = context->length;
        voice_available = context->available;
        voice_loop = context->repeat_frames != 0;
        voice_target_frames = voice_loop ? context->repeat_frames : context->length * 2;
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
    const voice_context_t context = {.buffer = buffer, .length = length, .available = length};
    return lights_with_shared_power(start_voice, (void *)&context);
}
esp_err_t audio_play_voice_loop(const uint8_t *buffer, size_t length, uint32_t duration_ms)
{
    if (!buffer || !length || length > 480000 || !duration_ms || duration_ms > 60000) return ESP_ERR_INVALID_ARG;
    const voice_context_t context = {.buffer = buffer, .length = length, .available = length,
        .repeat_frames = (uint32_t)((uint64_t)AUDIO_SAMPLE_RATE * duration_ms / 1000)};
    return lights_with_shared_power(start_voice, (void *)&context);
}

esp_err_t audio_play_voice_stream(const uint8_t *buffer, size_t length, size_t available)
{
    if (buffer == NULL || length == 0 || length > 480000 || available == 0 || available > length) return ESP_ERR_INVALID_ARG;
    const voice_context_t context = {.buffer = buffer, .length = length, .available = available};
    return lights_with_shared_power(start_voice, (void *)&context);
}
esp_err_t audio_voice_stream_extend(size_t available)
{
    if (!audio_mutex || available == 0 || available > voice_length) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (available > voice_available) voice_available = available;
    xSemaphoreGive(audio_mutex);
    return ESP_OK;
}

static esp_err_t start_pcm(void *arg)
{
    (void)arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (state.recording || (state.speaker_playing && !notification_only)) {
        xSemaphoreGive(audio_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    if (!pcm_buffer) pcm_buffer = heap_caps_malloc(PCM_BUFFER_FRAMES * sizeof(int16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!pcm_buffer) {
        state.speaker_error = ESP_ERR_NO_MEM;
        xSemaphoreGive(audio_mutex);
        return ESP_ERR_NO_MEM;
    }
    // A minute cue may have started while this stream was prebuffering.
    // Reuse its running channel and DMA, preserving the whole audible cue.
    const bool adopt_notification = notification_only && state.speaker_playing;
    const esp_err_t result = adopt_notification ? ESP_OK : start_channel(false);
    state.speaker_error = result;
    if (result == ESP_OK) {
        notification_only = false;
        pcm_head = pcm_size = 0;
        pcm_active = true;
        pcm_finished = false;
        voice_buffer = NULL;
        state.voice_completed = false;
        state.speaker_playing = true;
        tone_drain_until_us = 0;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_pcm_start(void)
{
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    return lights_with_shared_power(start_pcm, NULL);
}

esp_err_t audio_pcm_write(const int16_t *samples, size_t frames)
{
    if (!samples || !frames || frames > PCM_BUFFER_FRAMES) return ESP_ERR_INVALID_ARG;
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    esp_err_t result = ESP_OK;
    if (!pcm_active || pcm_finished || !state.speaker_playing) result = ESP_ERR_INVALID_STATE;
    else if (frames > PCM_BUFFER_FRAMES - pcm_size) result = ESP_ERR_NO_MEM;
    else {
        const size_t tail = (pcm_head + pcm_size) % PCM_BUFFER_FRAMES;
        const size_t first = frames < PCM_BUFFER_FRAMES - tail ? frames : PCM_BUFFER_FRAMES - tail;
        memcpy(pcm_buffer + tail, samples, first * sizeof(int16_t));
        if (frames > first) memcpy(pcm_buffer, samples + first, (frames - first) * sizeof(int16_t));
        pcm_size += frames;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_pcm_finish(void)
{
    if (!audio_mutex || !state.ready) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    const esp_err_t result = pcm_active && state.speaker_playing ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (result == ESP_OK) pcm_finished = true;
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_set_volume(uint8_t volume)
{
    if (!audio_mutex || volume > 100) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (state.volume != volume || (!volume_dirty && saved_volume != volume)) {
        state.volume = volume;
        volume_dirty = volume != saved_volume;
        volume_save_attempts = 0;
        volume_save_at = esp_timer_get_time() + VOLUME_SAVE_DELAY_US;
    }
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
        record_deadline_us = esp_timer_get_time() + 20000000;
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

typedef struct { audio_microphone_sink_t sink; } live_context_t;

static esp_err_t start_live_capture(void *arg)
{
    const live_context_t *context = arg;
    xSemaphoreTake(audio_mutex, portMAX_DELAY);
    if (state.recording || live_sink) {
        xSemaphoreGive(audio_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t result = start_channel(true);
    state.recording = false;
    record_buffer = NULL;
    record_capacity = 0;
    live_chunk_frames = 0;
    state.microphone_error = result;
    state.microphone_active = result == ESP_OK;
    if (result == ESP_OK) {
        microphone_started_us = microphone_last_data_us = esp_timer_get_time();
        live_sink = context->sink;
    }
    xSemaphoreGive(audio_mutex);
    return result;
}

esp_err_t audio_live_start(audio_microphone_sink_t sink)
{
    if (sink == NULL || !audio_mutex || !state.ready) return ESP_ERR_INVALID_ARG;
    const live_context_t context = {.sink = sink};
    return lights_with_shared_power(start_live_capture, (void *)&context);
}

esp_err_t audio_live_stop(void)
{
    return audio_set_microphone(false);
}
