#include "lights.h"
#include "audio.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/rmt_tx.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/soc_caps.h"

// Project bring-up value, NOT an electrically qualified board minimum.
// Validate rail settling and DIN levels on the assembled board (see PROTOCOL.md).
#define SHARED_RAIL_SETTLE_MS 100
#define PIXEL_SYMBOL_COUNT (LIGHT_PIXEL_COUNT * 24 + 1)
#define RMT_MEMORY_SYMBOLS (((PIXEL_SYMBOL_COUNT + 1 + SOC_RMT_MEM_WORDS_PER_CHANNEL - 1) / SOC_RMT_MEM_WORDS_PER_CHANNEL) * SOC_RMT_MEM_WORDS_PER_CHANNEL)

static SemaphoreHandle_t lights_mutex;
static rmt_channel_handle_t pixel_channel;
static rmt_encoder_handle_t pixel_encoder;
static bool channel_enabled;
static rmt_symbol_word_t pixel_symbols[PIXEL_SYMBOL_COUNT];
static lights_snapshot_t state;

static uint8_t scale_channel(uint32_t rgb, unsigned shift, const light_pixel_t *pixel)
{
    return pixel->on ? (((rgb >> shift) & 0xff) * pixel->brightness + 50) / 100 : 0;
}

bool lights_pixel_is_lit(const light_pixel_t *pixel)
{
    return scale_channel(pixel->rgb, 16, pixel) || scale_channel(pixel->rgb, 8, pixel) || scale_channel(pixel->rgb, 0, pixel);
}

// Audio startup also takes lights_mutex via lights_with_shared_power.
static esp_err_t safe_downstream(void)
{
    const gpio_num_t outputs[] = {GPIO_NUM_9, GPIO_NUM_10, GPIO_NUM_12, GPIO_NUM_13, GPIO_NUM_14, GPIO_NUM_15};
    for (unsigned index = 0; index < sizeof(outputs) / sizeof(outputs[0]); index++) {
        esp_err_t result = gpio_set_level(outputs[index], 0);
        if (result != ESP_OK) return result;
        result = gpio_set_direction(outputs[index], GPIO_MODE_OUTPUT);
        if (result != ESP_OK) return result;
    }
    const gpio_config_t mic_input = {
        .pin_bit_mask = 1ULL << GPIO_NUM_11,
        .mode = GPIO_MODE_DISABLE,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    return gpio_config(&mic_input);
}

static esp_err_t write_pixels(const light_pixel_t pixels[LIGHT_PIXEL_COUNT])
{
    size_t symbol = 0;
    for (int index = 0; index < LIGHT_PIXEL_COUNT; index++) {
        // WS2812 wire order is GRB, most significant bit first, at 800 kbit/s.
        const unsigned shifts[] = {8, 16, 0};
        for (int component = 0; component < 3; component++) {
            const uint8_t byte = scale_channel(pixels[index].rgb, shifts[component], &pixels[index]);
            for (int bit = 7; bit >= 0; bit--) {
                const bool one = (byte & (1 << bit)) != 0;
                pixel_symbols[symbol++] = (rmt_symbol_word_t){
                    .level0 = 1, .duration0 = one ? 16 : 8,
                    .level1 = 0, .duration1 = one ? 9 : 17,
                };
            }
        }
    }
    // 300 us low latch covers WS2812 variants needing more than 50 us.
    pixel_symbols[symbol] = (rmt_symbol_word_t){.level0 = 0, .duration0 = 3000, .level1 = 0, .duration1 = 3000};
    const rmt_transmit_config_t config = {.loop_count = 0, .flags.eot_level = 0};
    esp_err_t result = rmt_transmit(pixel_channel, pixel_encoder, pixel_symbols, sizeof(pixel_symbols), &config);
    if (result == ESP_OK) result = rmt_tx_wait_all_done(pixel_channel, 100);
    return result;
}

static esp_err_t start_rail(void)
{
    if (state.rail_on) return ESP_OK;
    esp_err_t result = safe_downstream();
    if (result != ESP_OK) return result;
    result = gpio_set_level(GPIO_NUM_8, 1);
    if (result != ESP_OK) return result;
    state.rail_on = true;
    // Add one tick so rounding never shortens the project settling interval.
    vTaskDelay(pdMS_TO_TICKS(SHARED_RAIL_SETTLE_MS) + 1);
    const rmt_tx_channel_config_t config = {
        .gpio_num = GPIO_NUM_12,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 20000000,
        // Entire frame plus end marker fits in HW memory: no mid-frame refill.
        .mem_block_symbols = RMT_MEMORY_SYMBOLS,
        .trans_queue_depth = 1,
        .flags.init_level = 0,
    };
    result = rmt_new_tx_channel(&config, &pixel_channel);
    if (result != ESP_OK) return result;
    result = rmt_enable(pixel_channel);
    if (result != ESP_OK) return result;
    channel_enabled = true;
    const light_pixel_t black[LIGHT_PIXEL_COUNT] = {0};
    return write_pixels(black);
}

static esp_err_t stop_rail(void)
{
    // Wait for in-flight I/O, then disable and detach both audio controllers.
    const esp_err_t audio_result = audio_prepare_power_off();
    if (audio_result != ESP_OK) return audio_result;
    // Must stop/detach RMT before restoring GPIO12 to a low GPIO output.
    if (channel_enabled) {
        const esp_err_t result = rmt_disable(pixel_channel);
        if (result != ESP_OK) return result;
        channel_enabled = false;
    }
    if (pixel_channel) {
        const esp_err_t result = rmt_del_channel(pixel_channel);
        if (result != ESP_OK) return result;
        pixel_channel = NULL;
    }
    esp_err_t result = safe_downstream();
    if (result == ESP_OK) result = gpio_set_level(GPIO_NUM_8, 0);
    if (result == ESP_OK) {
        state.rail_on = false;
        for (int index = 0; index < LIGHT_PIXEL_COUNT; index++) state.pixels[index].on = false;
    }
    return result;
}

static esp_err_t finish_operation(esp_err_t result)
{
    if (result != ESP_OK) {
        // A driver failure is not reported as a successful setting. Stop output
        // and keep the error visible; reboot is required before further control.
        stop_rail();
        state.ready = false;
        state.error = result;
    }
    xSemaphoreGive(lights_mutex);
    return result;
}

esp_err_t lights_init(void)
{
    lights_mutex = xSemaphoreCreateMutex();
    if (!lights_mutex) {
        state.error = ESP_ERR_NO_MEM;
        return state.error;
    }
    for (int index = 0; index < LIGHT_PIXEL_COUNT; index++) {
        state.pixels[index] = (light_pixel_t){.rgb = 0xffffff, .brightness = 1, .on = false};
    }
    const rmt_copy_encoder_config_t encoder_config = {};
    esp_err_t result = rmt_new_copy_encoder(&encoder_config, &pixel_encoder);
    if (result == ESP_OK) {
        const ledc_timer_config_t timer = {
            .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_13_BIT,
            .timer_num = LEDC_TIMER_0, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK,
        };
        result = ledc_timer_config(&timer);
    }
    if (result == ESP_OK) {
        const ledc_channel_config_t channel = {
            .gpio_num = GPIO_NUM_42, .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel = LEDC_CHANNEL_0, .intr_type = LEDC_INTR_DISABLE,
            .timer_sel = LEDC_TIMER_0, .duty = 0, .hpoint = 0,
        };
        result = ledc_channel_config(&channel);
    }
    state.ready = result == ESP_OK;
    state.error = result;
    return result;
}

void lights_get_snapshot(lights_snapshot_t *snapshot)
{
    if (lights_mutex) xSemaphoreTake(lights_mutex, portMAX_DELAY);
    *snapshot = state;
    if (lights_mutex) xSemaphoreGive(lights_mutex);
}

static esp_err_t set_pixels(int index, const light_pixel_t *pixel)
{
    if (index < -1 || index >= LIGHT_PIXEL_COUNT || (!pixel && index != -1) || (pixel && (pixel->brightness > 100 || pixel->rgb > 0xffffff))) return ESP_ERR_INVALID_ARG;
    if (!lights_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(lights_mutex, portMAX_DELAY);
    if (!state.ready) {
        xSemaphoreGive(lights_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    light_pixel_t next[LIGHT_PIXEL_COUNT];
    for (int i = 0; i < LIGHT_PIXEL_COUNT; i++) {
        next[i] = pixel && (index == -1 || i == index) ? *pixel : state.pixels[i];
        if (!pixel) next[i].on = false;
    }
    bool need_rail = false;
    for (int i = 0; i < LIGHT_PIXEL_COUNT; i++) need_rail |= lights_pixel_is_lit(&next[i]);
    esp_err_t result = need_rail ? start_rail() : ESP_OK;
    if (result == ESP_OK && state.rail_on) result = write_pixels(next);
    if (result == ESP_OK) {
        for (int i = 0; i < LIGHT_PIXEL_COUNT; i++) state.pixels[i] = next[i];
    }
    return finish_operation(result);
}

esp_err_t lights_with_shared_power(esp_err_t (*operation)(void *), void *context)
{
    if (!operation) return ESP_ERR_INVALID_ARG;
    if (!lights_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(lights_mutex, portMAX_DELAY);
    if (!state.ready) {
        xSemaphoreGive(lights_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t power_result = start_rail();
    if (power_result != ESP_OK) return finish_operation(power_result);
    // Audio failures do not poison a healthy RMT/PWM driver.
    const esp_err_t result = operation(context);
    xSemaphoreGive(lights_mutex);
    return result;
}

esp_err_t lights_set_pixel(int index, const light_pixel_t *pixel)
{
    if (index < 0) return ESP_ERR_INVALID_ARG;
    return set_pixels(index, pixel);
}

esp_err_t lights_set_all(const light_pixel_t *pixel)
{
    if (!pixel) return ESP_ERR_INVALID_ARG;
    return set_pixels(-1, pixel);
}

esp_err_t lights_off(void)
{
    return set_pixels(-1, NULL);
}

esp_err_t lights_set_status(uint8_t brightness)
{
    if (brightness > 100) return ESP_ERR_INVALID_ARG;
    if (!lights_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(lights_mutex, portMAX_DELAY);
    if (!state.ready) {
        xSemaphoreGive(lights_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t result = ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, (8191U * brightness + 50) / 100);
    if (result == ESP_OK) result = ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    if (result == ESP_OK) state.status_brightness = brightness;
    return finish_operation(result);
}

esp_err_t lights_set_power(bool on)
{
    if (!lights_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(lights_mutex, portMAX_DELAY);
    if (!state.ready) {
        xSemaphoreGive(lights_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t result;
    if (on) {
        result = start_rail();
        if (result == ESP_OK) result = write_pixels(state.pixels);
    } else {
        result = ESP_OK;
        if (state.rail_on) {
            const light_pixel_t black[LIGHT_PIXEL_COUNT] = {0};
            result = write_pixels(black);
        }
        // Power off even if the black frame failed, once the driver is stopped.
        const esp_err_t stop_result = stop_rail();
        if (result == ESP_OK) result = stop_result;
    }
    return finish_operation(result);
}
