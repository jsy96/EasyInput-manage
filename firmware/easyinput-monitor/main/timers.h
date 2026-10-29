#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    TIMER_EVENT_NONE = 0,
    TIMER_EVENT_SECOND = 1 << 0,
    TIMER_EVENT_MINUTE = 1 << 1,
    TIMER_EVENT_DONE = 1 << 2,
    TIMER_EVENT_ALARM = 1 << 3,
} timer_event_t;

void timers_init(void);
int timers_alarm_minute(void);
bool timers_set_alarm_minute(int minute);
bool timers_countdown_active(void);
int timers_countdown_seconds(void);
void timers_start_countdown(int minutes);
void timers_cancel_countdown(void);
bool timers_stopwatch_active(void);
uint32_t timers_stopwatch_seconds(int64_t now_us);
void timers_start_stopwatch(int64_t now_us);
uint32_t timers_stop_stopwatch(int64_t now_us);
unsigned timers_poll(int64_t now_us);
