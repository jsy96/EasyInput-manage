#include "voice_outbox.h"
#include <stddef.h>
#include <string.h>
#include "esp_partition.h"
#include "esp_rom_crc.h"

#define SLOT_BYTES 0x80000
#define AUDIO_OFFSET 4096
#define MAGIC 0x564f5831
#define PENDING 0xfffffffeu
#define SENT 0xfffffffcu
typedef struct {
    uint32_t magic, samples, sequence, data_crc, header_crc, state;
    char id[64];
} header_t;
static const esp_partition_t *partition;
static header_t headers[VOICE_OUTBOX_CAPACITY];
static bool pending[VOICE_OUTBOX_CAPACITY];
static uint32_t next_sequence;

static uint32_t header_crc(header_t h)
{
    h.header_crc = 0; h.state = 0xffffffffu;
    return esp_rom_crc32_le(0, (const uint8_t *)&h, sizeof(h));
}
esp_err_t voice_outbox_init(void)
{
    memset(pending, 0, sizeof(pending)); next_sequence = 1;
    partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "voice_outbox");
    if (!partition || partition->size < VOICE_OUTBOX_CAPACITY * SLOT_BYTES) return ESP_ERR_NOT_FOUND;
    uint8_t block[1024];
    for (int i = 0; i < VOICE_OUTBOX_CAPACITY; i++) {
        header_t *h = &headers[i];
        esp_err_t rc = esp_partition_read(partition, i * SLOT_BYTES, h, sizeof(*h));
        if (rc != ESP_OK) return rc;
        if (h->magic != MAGIC || h->samples == 0 || h->samples > VOICE_OUTBOX_AUDIO_MAX ||
            !memchr(h->id, 0, sizeof(h->id)) || h->header_crc != header_crc(*h) ||
            (h->state != PENDING && h->state != SENT)) continue;
        if (h->sequence >= next_sequence) next_sequence = h->sequence + 1;
        if (h->state == SENT) continue;
        uint32_t crc = 0;
        for (size_t offset = 0; offset < h->samples; offset += sizeof(block)) {
            size_t n = h->samples - offset; if (n > sizeof(block)) n = sizeof(block);
            rc = esp_partition_read(partition, i * SLOT_BYTES + AUDIO_OFFSET + offset, block, n);
            if (rc != ESP_OK) return rc;
            crc = esp_rom_crc32_le(crc, block, n);
        }
        pending[i] = crc == h->data_crc;
    }
    return ESP_OK;
}
unsigned voice_outbox_count(void)
{
    unsigned count = 0; for (int i = 0; i < VOICE_OUTBOX_CAPACITY; i++) if (pending[i]) count++;
    return count;
}
bool voice_outbox_oldest(voice_outbox_item_t *item)
{
    int selected = -1;
    for (int i = 0; i < VOICE_OUTBOX_CAPACITY; i++) if (pending[i] &&
        (selected < 0 || headers[i].sequence < headers[selected].sequence)) selected = i;
    if (selected < 0) return false;
    *item = (voice_outbox_item_t){.samples = headers[selected].samples, .sequence = headers[selected].sequence, .slot = selected};
    memcpy(item->id, headers[selected].id, sizeof(item->id)); return true;
}
esp_err_t voice_outbox_save(const char *id, const uint8_t *audio, size_t length)
{
    if (!partition) return ESP_ERR_INVALID_STATE;
    if (!id || !id[0] || strlen(id) >= sizeof(headers[0].id) || !audio || !length || length > VOICE_OUTBOX_AUDIO_MAX) return ESP_ERR_INVALID_ARG;
    int slot = -1;
    // Rotate free slots so short messages do not repeatedly wear a single sector.
    for (int n = 0; n < VOICE_OUTBOX_CAPACITY; n++) {
        int i = (next_sequence - 1 + n) % VOICE_OUTBOX_CAPACITY;
        if (!pending[i]) { slot = i; break; }
    }
    if (slot < 0) return ESP_ERR_NO_MEM;
    header_t h = {.magic = MAGIC, .samples = length, .sequence = next_sequence++, .state = PENDING};
    memcpy(h.id, id, strlen(id) + 1);
    h.data_crc = esp_rom_crc32_le(0, audio, length); h.header_crc = header_crc(h);
    esp_err_t rc = esp_partition_erase_range(partition, slot * SLOT_BYTES, SLOT_BYTES);
    if (rc == ESP_OK) rc = esp_partition_write(partition, slot * SLOT_BYTES + AUDIO_OFFSET, audio, length);
    // Publish the header last. A power interruption cannot turn a partial clip into a pending clip.
    if (rc == ESP_OK) rc = esp_partition_write(partition, slot * SLOT_BYTES, &h, sizeof(h));
    if (rc == ESP_OK) { headers[slot] = h; pending[slot] = true; }
    return rc;
}
static bool current(const voice_outbox_item_t *item)
{
    return partition && item && item->slot >= 0 && item->slot < VOICE_OUTBOX_CAPACITY && pending[item->slot] &&
        headers[item->slot].sequence == item->sequence && strcmp(headers[item->slot].id, item->id) == 0;
}
esp_err_t voice_outbox_read(const voice_outbox_item_t *item, size_t offset, void *data, size_t length)
{
    if (!current(item) || offset > item->samples || length > item->samples - offset) return ESP_ERR_INVALID_ARG;
    return esp_partition_read(partition, item->slot * SLOT_BYTES + AUDIO_OFFSET + offset, data, length);
}
esp_err_t voice_outbox_ack(const voice_outbox_item_t *item)
{
    if (!current(item)) return ESP_ERR_INVALID_ARG;
    const uint32_t state = SENT;
    esp_err_t rc = esp_partition_write(partition, item->slot * SLOT_BYTES + offsetof(header_t, state), &state, sizeof(state));
    if (rc == ESP_OK) { pending[item->slot] = false; headers[item->slot].state = state; }
    return rc;
}
