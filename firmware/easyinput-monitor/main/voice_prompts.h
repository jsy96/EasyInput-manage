#pragma once
#include <stddef.h>
#include <stdint.h>
typedef enum { PROMPT_WIFI, PROMPT_BLE, PROMPT_OFFLINE, PROMPT_SETUP, PROMPT_S8_ON, PROMPT_S8_OFF, PROMPT_FULL, PROMPT_SAVE_FAILED, PROMPT_SETUP_FAILED, PROMPT_COUNT } voice_prompt_t;
const uint8_t *voice_prompt_data(voice_prompt_t prompt, size_t *length);
