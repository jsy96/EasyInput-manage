#include "health_records.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"

static const char *const keys[HEALTH_RECORD_COUNT] = {
    "mother_high", "mother_low", "father_high", "father_low", "father_glucose", "mother_glucose",
};
typedef struct {
    uint32_t version, head, count;
    int values[HEALTH_RECORD_COUNT];
    uint8_t present[HEALTH_RECORD_COUNT];
    health_pending_t pending[HEALTH_PENDING_CAPACITY];
} history_t;
static history_t history;
static bool ready;

static bool persist(void)
{
    nvs_handle_t handle;
    if (nvs_open("health", NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool ok = nvs_set_blob(handle, "history_v1", &history, sizeof(history)) == ESP_OK && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return ok;
}

static bool valid_kind(health_kind_t kind) { return kind >= 0 && kind < HEALTH_RECORD_COUNT; }
static bool glucose(health_kind_t kind) { return kind >= HEALTH_FATHER_GLUCOSE; }
static bool low_pressure(health_kind_t kind) { return kind == HEALTH_MOTHER_LOW || kind == HEALTH_FATHER_LOW; }
static int minimum(health_kind_t kind) { return glucose(kind) ? 30 : low_pressure(kind) ? 50 : 80; }
static int maximum(health_kind_t kind) { return glucose(kind) ? 200 : low_pressure(kind) ? 120 : 220; }
static int initial(health_kind_t kind) { return glucose(kind) ? 75 : low_pressure(kind) ? 70 : 130; }

void health_records_init(void)
{
    memset(&history, 0, sizeof(history));
    history.version = 1;
    ready = false;
    nvs_handle_t handle;
    if (nvs_open("health", NVS_READWRITE, &handle) != ESP_OK) return;
    size_t size = sizeof(history);
    const esp_err_t result = nvs_get_blob(handle, "history_v1", &history, &size);
    if (result == ESP_OK) {
        ready = size == sizeof(history) && history.version == 1 && history.head < HEALTH_PENDING_CAPACITY && history.count <= HEALTH_PENDING_CAPACITY;
        for (int kind = 0; ready && kind < HEALTH_RECORD_COUNT; kind++) {
            if (history.present[kind] && (history.values[kind] < minimum(kind) || history.values[kind] > maximum(kind))) ready = false;
        }
        for (unsigned i = 0; ready && i < history.count; i++) {
            const health_pending_t *r = &history.pending[(history.head + i) % HEALTH_PENDING_CAPACITY];
            if (!valid_kind(r->kind) || r->value < minimum(r->kind) || r->value > maximum(r->kind) ||
                strnlen(r->id, sizeof(r->id)) != 32) ready = false;
        }
        nvs_close(handle);
        return;
    }
    if (result != ESP_ERR_NVS_NOT_FOUND) { nvs_close(handle); return; }
    // Migrate the six legacy latest values without inventing historical measurements.
    for (int kind = 0; kind < HEALTH_RECORD_COUNT; kind++) {
        uint16_t stored;
        if (nvs_get_u16(handle, keys[kind], &stored) == ESP_OK && stored >= minimum(kind) && stored <= maximum(kind)) {
            history.values[kind] = stored;
            history.present[kind] = true;
        }
    }
    nvs_close(handle);
    ready = true;
}

bool health_record_get(health_kind_t kind, int *value)
{
    if (!ready || !valid_kind(kind) || value == NULL || !history.present[kind]) return false;
    *value = history.values[kind];
    return true;
}

void health_edit_begin(health_edit_t *edit, health_kind_t kind)
{
    if (edit == NULL || !valid_kind(kind)) return;
    *edit = (health_edit_t){.active = true, .kind = kind, .value = initial(kind)};
    (void)health_record_get(kind, &edit->value);
}

void health_edit_rotate(health_edit_t *edit, int delta)
{
    if (edit == NULL || !edit->active || delta == 0) return;
    const int step = edit->fine ? 1 : 10;
    int64_t next = (int64_t)edit->value + (int64_t)delta * step;
    if (next < minimum(edit->kind)) next = minimum(edit->kind);
    if (next > maximum(edit->kind)) next = maximum(edit->kind);
    edit->value = (int)next;
}

void health_edit_refine(health_edit_t *edit)
{
    if (edit == NULL || !edit->active) return;
    edit->fine = true;
}

bool health_edit_save(health_edit_t *edit)
{
    if (edit == NULL || !edit->active || !edit->fine || !valid_kind(edit->kind) ||
        edit->value < minimum(edit->kind) || edit->value > maximum(edit->kind)) return false;
    edit->active = false;
    if (!ready || history.count >= HEALTH_PENDING_CAPACITY) return false;
    const unsigned slot = (history.head + history.count) % HEALTH_PENDING_CAPACITY;
    health_pending_t *r = &history.pending[slot];
    memset(r, 0, sizeof(*r));
    uint32_t random[4]; esp_fill_random(random, sizeof(random));
    snprintf(r->id, sizeof(r->id), "%08lx%08lx%08lx%08lx", (unsigned long)random[0], (unsigned long)random[1], (unsigned long)random[2], (unsigned long)random[3]);
    const time_t now = time(NULL);
    r->measured_at_ms = now >= 1735689600LL ? (int64_t)now * 1000 : 0;
    r->uptime_ms = esp_timer_get_time() / 1000;
    r->kind = edit->kind; r->value = edit->value;
    const int old = history.values[edit->kind];
    const uint8_t had_old = history.present[edit->kind];
    history.values[edit->kind] = edit->value; history.present[edit->kind] = true; history.count++;
    if (persist()) return true;
    history.count--; history.values[edit->kind] = old; history.present[edit->kind] = had_old;
    return false;
}

void health_edit_cancel(health_edit_t *edit)
{
    if (edit != NULL) *edit = (health_edit_t){0};
}

bool health_pending_oldest(health_pending_t *record)
{
    if (!ready || !record || !history.count) return false;
    *record = history.pending[history.head];
    return true;
}

bool health_pending_ack(const char *id)
{
    if (!ready || !id || !history.count || strcmp(history.pending[history.head].id, id) != 0) return false;
    const unsigned head = history.head;
    history.head = (history.head + 1) % HEALTH_PENDING_CAPACITY; history.count--;
    if (persist()) return true;
    history.head = head; history.count++;
    return false;
}

unsigned health_pending_count(void) { return ready ? history.count : 0; }
