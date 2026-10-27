#include "timers.h"

#include <stdlib.h>
#include <time.h>

#include "esp_err.h"
#include "esp_log.h"
#include "nvs.h"

#define ALARM_NONE 1440
#define POSIX_TIME_VALID_FROM 1735689600LL

static const char *TAG = "timers";
static int alarm_minute = ALARM_NONE;
static bool countdown_active;
static int countdown_seconds;
static int64_t next_countdown_tick_us;
static int64_t last_alarm_day_minute = -1;
static int64_t last_alarm_check_us;

void timers_init(void)
{
    setenv("TZ", "CST-8", 1);
    tzset();
    nvs_handle_t handle;
    if (nvs_open("schedule", NVS_READONLY, &handle) == ESP_OK) {
        uint16_t stored = ALARM_NONE;
        if (nvs_get_u16(handle, "alarm", &stored) == ESP_OK && stored < ALARM_NONE) alarm_minute = stored;
        nvs_close(handle);
    }
}

int timers_alarm_minute(void)
{
    return alarm_minute == ALARM_NONE ? -1 : alarm_minute;
}

bool timers_set_alarm_minute(int minute)
{
    if (minute < -1 || minute >= ALARM_NONE) return false;
    alarm_minute = minute < 0 ? ALARM_NONE : minute;
    last_alarm_day_minute = -1;
    nvs_handle_t handle;
    if (nvs_open("schedule", NVS_READWRITE, &handle) != ESP_OK) return false;
    const esp_err_t result = nvs_set_u16(handle, "alarm", (uint16_t)alarm_minute);
    const esp_err_t commit = result == ESP_OK ? nvs_commit(handle) : result;
    nvs_close(handle);
    if (commit != ESP_OK) ESP_LOGE(TAG, "Unable to persist alarm: %s", esp_err_to_name(commit));
    return commit == ESP_OK;
}

bool timers_countdown_active(void)
{
    return countdown_active;
}

int timers_countdown_seconds(void)
{
    return countdown_active ? countdown_seconds : 0;
}

void timers_start_countdown(int minutes)
{
    if (minutes < 1 || minutes > 60) return;
    countdown_active = true;
    countdown_seconds = minutes * 60;
    next_countdown_tick_us = 0;
}

void timers_cancel_countdown(void)
{
    countdown_active = false;
    countdown_seconds = 0;
    next_countdown_tick_us = 0;
}

unsigned timers_poll(int64_t now_us)
{
    unsigned events = TIMER_EVENT_NONE;
    if (countdown_active) {
        if (next_countdown_tick_us == 0) next_countdown_tick_us = now_us + 1000000;
        while (countdown_active && now_us >= next_countdown_tick_us) {
            next_countdown_tick_us += 1000000;
            countdown_seconds--;
            events |= TIMER_EVENT_SECOND;
            if (countdown_seconds > 0 && countdown_seconds % 60 == 0) events |= TIMER_EVENT_MINUTE;
            if (countdown_seconds <= 0) {
                countdown_active = false;
                countdown_seconds = 0;
                events |= TIMER_EVENT_DONE;
            }
        }
    }

    if (now_us - last_alarm_check_us < 1000000) return events;
    last_alarm_check_us = now_us;
    const time_t now = time(NULL);
    if ((long long)now < POSIX_TIME_VALID_FROM || alarm_minute == ALARM_NONE) return events;
    struct tm local;
    if (localtime_r(&now, &local) == NULL) return events;
    const int current = local.tm_hour * 60 + local.tm_min;
    if (current != alarm_minute) return events;
    const int64_t day_minute = ((int64_t)(local.tm_year + 1900) * 1000 + local.tm_yday) * 1440 + current;
    if (day_minute != last_alarm_day_minute) {
        last_alarm_day_minute = day_minute;
        events |= TIMER_EVENT_ALARM;
    }
    return events;
}
