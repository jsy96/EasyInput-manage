#include "voice_prompts.h"

#include <stdbool.h>

#define PACK_MAGIC 0x31504945u
#define PROMPT_SAMPLE_RATE 8000u
#define PROMPT_EDGE_PADDING (PROMPT_SAMPLE_RATE * 60u / 1000u)
#define PROMPT_SILENCE_THRESHOLD 128u

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t count;
} pack_header_t;

typedef struct {
    uint16_t id;
    uint32_t offset;
    uint32_t length;
} __attribute__((packed)) pack_entry_t;

_Static_assert(sizeof(pack_entry_t) == 10, "prompt pack entries must stay packed");

extern const uint8_t prompt_pack_start[] asm("_binary_prompts_bin_start");
extern const uint8_t prompt_pack_end[] asm("_binary_prompts_bin_end");

static const pack_entry_t *find_entry(int id)
{
    const size_t pack_length = (size_t)(prompt_pack_end - prompt_pack_start);
    if (id < 0 || pack_length < sizeof(pack_header_t)) return NULL;
    const pack_header_t *header = (const pack_header_t *)prompt_pack_start;
    if (header->magic != PACK_MAGIC || header->version != 1) return NULL;
    if (header->count > (pack_length - sizeof(*header)) / sizeof(pack_entry_t)) return NULL;
    const pack_entry_t *entries = (const pack_entry_t *)(prompt_pack_start + sizeof(*header));
    for (uint16_t i = 0; i < header->count; i++) if (entries[i].id == id) return &entries[i];
    return NULL;
}

static unsigned prompt_amplitude(uint8_t value)
{
    const unsigned sample = (uint8_t)~value;
    const unsigned pcm = (((sample & 15u) << 3) + 132u) << ((sample >> 4) & 7u);
    return pcm > 132u ? pcm - 132u : 132u - pcm;
}

const uint8_t *voice_prompt_data(int prompt, size_t *length)
{
    if (length == NULL) return NULL;
    const pack_entry_t *entry = find_entry(prompt);
    const size_t pack_length = (size_t)(prompt_pack_end - prompt_pack_start);
    if (entry == NULL || entry->offset > pack_length || entry->length > pack_length - entry->offset) {
        *length = 0;
        return NULL;
    }
    const uint8_t *data = prompt_pack_start + entry->offset;
    size_t begin = 0;
    size_t end = entry->length;
    while (begin < end && prompt_amplitude(data[begin]) <= PROMPT_SILENCE_THRESHOLD) begin++;
    while (end > begin && prompt_amplitude(data[end - 1]) <= PROMPT_SILENCE_THRESHOLD) end--;
    if (begin == end) {
        *length = entry->length;
        return data;
    }
    begin = begin > PROMPT_EDGE_PADDING ? begin - PROMPT_EDGE_PADDING : 0;
    end = entry->length - end > PROMPT_EDGE_PADDING ? end + PROMPT_EDGE_PADDING : entry->length;
    *length = end - begin;
    return data + begin;
}

size_t voice_prompt_number(int value, int ids[8])
{
    if (value < 0 || value > 999 || ids == NULL) return 0;
    if (value >= 100) {
        int length = 0;
        ids[length++] = PROMPT_DIGIT_0 + value / 100;
        ids[length++] = PROMPT_HUNDRED;
        const int remainder = value % 100;
        if (remainder == 0) return length;
        if (remainder < 10) {
            ids[length++] = PROMPT_DIGIT_0;
            ids[length++] = PROMPT_DIGIT_0 + remainder;
            return length;
        }
        if (remainder < 20) {
            ids[length++] = PROMPT_TEN;
            if (remainder > 10) ids[length++] = PROMPT_DIGIT_0 + remainder - 10;
            return length;
        }
        ids[length++] = PROMPT_DIGIT_0 + remainder / 10;
        ids[length++] = PROMPT_TEN;
        if (remainder % 10) ids[length++] = PROMPT_DIGIT_0 + remainder % 10;
        return length;
    }
    if (value < 10) {
        ids[0] = PROMPT_DIGIT_0 + value;
        return 1;
    }
    if (value < 20) {
        ids[0] = PROMPT_TEN;
        if (value > 10) ids[1] = PROMPT_DIGIT_0 + value - 10;
        return value == 10 ? 1 : 2;
    }
    ids[0] = PROMPT_DIGIT_0 + value / 10;
    ids[1] = PROMPT_TEN;
    if (value % 10) {
        ids[2] = PROMPT_DIGIT_0 + value % 10;
        return 3;
    }
    return 2;
}
