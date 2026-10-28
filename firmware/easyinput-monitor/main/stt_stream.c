#include "stt_stream.h"

#include <string.h>

void stt_stream_init(stt_stream_t *stream, uint8_t *storage, size_t capacity)
{
    *stream = (stt_stream_t){.data = storage, .capacity = capacity};
}

bool stt_stream_write(stt_stream_t *stream, const uint8_t *data, size_t length)
{
    if (length == 0) return true;
    if (!stream->data || !data || !stream->capacity || length > stream->capacity - stream->size) {
        stream->overflow = true;
        return false;
    }
    const size_t write = (stream->read + stream->size) % stream->capacity;
    size_t first = stream->capacity - write;
    if (first > length) first = length;
    memcpy(stream->data + write, data, first);
    if (length > first) memcpy(stream->data, data + first, length - first);
    stream->size += length;
    stream->accepted += length;
    return true;
}

size_t stt_stream_peek(const stt_stream_t *stream, uint8_t *output, size_t capacity)
{
    if (!output || !stream->data || !stream->size) return 0;
    const size_t length = stream->size < capacity ? stream->size : capacity;
    size_t first = stream->capacity - stream->read;
    if (first > length) first = length;
    memcpy(output, stream->data + stream->read, first);
    if (length > first) memcpy(output + first, stream->data, length - first);
    return length;
}

bool stt_stream_consume(stt_stream_t *stream, size_t length)
{
    if (length > stream->size) return false;
    if (length) stream->read = (stream->read + length) % stream->capacity;
    stream->size -= length;
    stream->consumed += length;
    return true;
}
