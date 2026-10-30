#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    unsigned sent;
    unsigned failed;
    unsigned dropped;
    unsigned realtime_starts_sent;
    unsigned realtime_starts_failed;
    unsigned realtime_chunks_sent;
    unsigned realtime_chunks_failed;
    unsigned realtime_chunks_dropped;
    unsigned connections;
    unsigned disconnects;
    unsigned errors;
    int last_tls_error;
    int last_socket_errno;
    int last_http_status;
    int last_close_code;
} cloud_monitor_stats_t;

void cloud_monitor_init(void);
// May be called before init; only a station with a valid IP can open cloud WSS.
void cloud_monitor_set_network_ready(bool ready);
void cloud_monitor_send(const char *line);
bool cloud_monitor_send_immediate(const char *line);
bool cloud_monitor_send_binary(const uint8_t *data, size_t length);
void cloud_monitor_get_stats(cloud_monitor_stats_t *stats);
bool cloud_monitor_is_online(void);
bool cloud_monitor_configure(const char *gateway_url, const char *device, const char *pairing_token);
bool cloud_monitor_clear(void);
bool cloud_monitor_queue_command(const char *line);

bool cloud_monitor_is_configured(void);
