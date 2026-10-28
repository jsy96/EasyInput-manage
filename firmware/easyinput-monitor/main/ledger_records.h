#pragma once

#include <stdbool.h>
#include <stdint.h>

#define LEDGER_PENDING_CAPACITY 64

typedef struct {
    bool active;
    bool ones;
    int high;
    int digit;
} ledger_edit_t;

typedef struct {
    char id[33];
    int amount; // Integer CNY, 1–999 yuan.
    int64_t recorded_at_ms;
    int64_t uptime_ms;
} ledger_pending_t;

void ledger_records_init(void);
void ledger_edit_begin(ledger_edit_t *edit);
void ledger_edit_rotate(ledger_edit_t *edit, int delta);
int ledger_edit_amount(const ledger_edit_t *edit);
bool ledger_edit_save(ledger_edit_t *edit);
void ledger_edit_cancel(ledger_edit_t *edit);
bool ledger_pending_oldest(ledger_pending_t *record);
bool ledger_pending_ack(const char *id);
unsigned ledger_pending_count(void);
