#include "voice_prompts.h"
#define AUDIO(name) extern const uint8_t name##_start[] asm("_binary_" #name "_ulaw_start"); extern const uint8_t name##_end[] asm("_binary_" #name "_ulaw_end")
AUDIO(wifi); AUDIO(ble); AUDIO(offline); AUDIO(setup); AUDIO(s8_on); AUDIO(s8_off); AUDIO(full); AUDIO(save_failed);
AUDIO(setup_failed);
const uint8_t *voice_prompt_data(voice_prompt_t prompt, size_t *length)
{
    const uint8_t *starts[] = {wifi_start, ble_start, offline_start, setup_start, s8_on_start, s8_off_start, full_start, save_failed_start, setup_failed_start};
    const uint8_t *ends[] = {wifi_end, ble_end, offline_end, setup_end, s8_on_end, s8_off_end, full_end, save_failed_end, setup_failed_end};
    if (prompt < 0 || prompt >= PROMPT_COUNT) { *length = 0; return NULL; }
    *length = ends[prompt] - starts[prompt]; return starts[prompt];
}
