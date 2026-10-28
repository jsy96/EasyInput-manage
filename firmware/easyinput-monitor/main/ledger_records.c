#include "ledger_records.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"

typedef struct {
    uint32_t version, head, count;
    ledger_pending_t pending[LEDGER_PENDING_CAPACITY];
} history_t;

static history_t history;
static bool ready;

static bool persist(void)
{
    nvs_handle_t handle;
    if (nvs_open("ledger", NVS_READWRITE, &handle) != ESP_OK) return false;
    const bool ok = nvs_set_blob(handle, "history_v1", &history, sizeof(history)) == ESP_OK && nvs_commit(handle) == ESP_OK;
    nvs_close(handle);
    return ok;
}

void ledger_records_init(void)
{
    memset(&history, 0, sizeof(history));
    history.version = 1;
    ready = false;
    nvs_handle_t handle;
    if (nvs_open("ledger", NVS_READWRITE, &handle) != ESP_OK) return;
    size_t size = sizeof(history);
    const esp_err_t result = nvs_get_blob(handle, "history_v1", &history, &size);
    ready = result == ESP_ERR_NVS_NOT_FOUND || (result == ESP_OK && size == sizeof(history) &&
        history.version == 1 && history.head < LEDGER_PENDING_CAPACITY && history.count <= LEDGER_PENDING_CAPACITY);
    for (unsigned i = 0; ready && i < history.count; i++) {
        const ledger_pending_t *r = &history.pending[(history.head + i) % LEDGER_PENDING_CAPACITY];
        if (r->amount < 1 || r->amount > 999 || strnlen(r->id, sizeof(r->id)) != 32) ready = false;
    }
    nvs_close(handle);
}

void ledger_edit_begin(ledger_edit_t *edit)
{
    if (edit) *edit = (ledger_edit_t){.active = true};
}

void ledger_edit_rotate(ledger_edit_t *edit, int delta)
{
    if (!edit || !edit->active) return;
    int *value = edit->ones ? &edit->digit : &edit->high;
    const int maximum = edit->ones ? 9 : 99;
    const int64_t next = (int64_t)*value + delta;
    *value = next < 0 ? 0 : next > maximum ? maximum : (int)next;
}

int ledger_edit_amount(const ledger_edit_t *edit)
{
    return edit ? edit->high * 10 + edit->digit : 0;
}

bool ledger_edit_save(ledger_edit_t *edit)
{
    const int amount = ledger_edit_amount(edit);
    if (!edit || !edit->active || !edit->ones || amount < 1 || amount > 999) return false;
    edit->active = false;
    if (!ready || history.count >= LEDGER_PENDING_CAPACITY) return false;
    ledger_pending_t *r = &history.pending[(history.head + history.count) % LEDGER_PENDING_CAPACITY];
    memset(r, 0, sizeof(*r));
    uint32_t random[4];
    esp_fill_random(random, sizeof(random));
    snprintf(r->id, sizeof(r->id), "%08lx%08lx%08lx%08lx", (unsigned long)random[0], (unsigned long)random[1], (unsigned long)random[2], (unsigned long)random[3]);
    r->amount = amount;
    const time_t now = time(NULL);
    r->recorded_at_ms = now >= 1735689600LL ? (int64_t)now * 1000 : 0;
    r->uptime_ms = esp_timer_get_time() / 1000;
    history.count++;
    if (persist()) return true;
    history.count--;
    return false;
}

void ledger_edit_cancel(ledger_edit_t *edit)
{
    if (edit) *edit = (ledger_edit_t){0};
}

bool ledger_pending_oldest(ledger_pending_t *record)
{
    if (!ready || !record || !history.count) return false;
    *record = history.pending[history.head];
    return true;
}

bool ledger_pending_ack(const char *id)
{
    if (!ready || !id || !history.count || strcmp(history.pending[history.head].id, id) != 0) return false;
    const unsigned head = history.head;
    history.head = (history.head + 1) % LEDGER_PENDING_CAPACITY;
    history.count--;
    if (persist()) return true;
    history.head = head;
    history.count++;
    return false;
}

unsigned ledger_pending_count(void) { return ready ? history.count : 0; }
