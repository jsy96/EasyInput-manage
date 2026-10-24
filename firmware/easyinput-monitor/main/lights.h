#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define LIGHT_PIXEL_COUNT 5

typedef struct {
    uint32_t rgb;
    uint8_t brightness;
    bool on;
} light_pixel_t;

typedef struct {
    bool ready;
    bool rail_on;
    light_pixel_t pixels[LIGHT_PIXEL_COUNT];
    uint8_t status_brightness;
    esp_err_t error;
} lights_snapshot_t;

esp_err_t lights_init(void);
void lights_get_snapshot(lights_snapshot_t *snapshot);
bool lights_pixel_is_lit(const light_pixel_t *pixel);
esp_err_t lights_set_pixel(int index, const light_pixel_t *pixel);
esp_err_t lights_set_all(const light_pixel_t *pixel);
esp_err_t lights_off(void);
esp_err_t lights_set_status(uint8_t brightness);
esp_err_t lights_set_power(bool on);
// Serializes audio startup with shutdown and waits for stable shared power.
esp_err_t lights_with_shared_power(esp_err_t (*operation)(void *), void *context);
