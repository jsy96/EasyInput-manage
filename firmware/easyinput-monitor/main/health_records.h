#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    HEALTH_MOTHER_HIGH,
    HEALTH_MOTHER_LOW,
    HEALTH_FATHER_HIGH,
    HEALTH_FATHER_LOW,
    HEALTH_FATHER_GLUCOSE,
    HEALTH_MOTHER_GLUCOSE,
    HEALTH_RECORD_COUNT,
} health_kind_t;

// Glucose is stored as integer tenths (75 = 7.5); blood pressure as integers.
typedef struct {
    bool active;
    bool fine;
    bool changed;
    bool button_down;
    health_kind_t kind;
    int value;
    int64_t save_at;
} health_edit_t;

#define HEALTH_PENDING_CAPACITY 64
typedef struct {
    char id[33];
    int kind;
    int value;
    int64_t measured_at_ms;
    int64_t uptime_ms;
} health_pending_t;

void health_records_init(void);
bool health_record_get(health_kind_t kind, int *value);
void health_edit_begin(health_edit_t *edit, health_kind_t kind);
void health_edit_rotate(health_edit_t *edit, int delta, int64_t now_us);
void health_edit_toggle_step(health_edit_t *edit, int64_t now_us);
void health_edit_button(health_edit_t *edit, bool down, int64_t now_us);
bool health_edit_save_due(const health_edit_t *edit, int64_t now_us);
bool health_edit_save(health_edit_t *edit);
void health_edit_cancel(health_edit_t *edit);
bool health_pending_oldest(health_pending_t *record);
bool health_pending_ack(const char *id);
unsigned health_pending_count(void);
