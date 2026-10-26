#pragma once

#include <stdbool.h>

void cloud_monitor_init(void);
void cloud_monitor_send(const char *line);
bool cloud_monitor_is_online(void);
bool cloud_monitor_configure(const char *gateway_url, const char *device, const char *pairing_token);
bool cloud_monitor_clear(void);
bool cloud_monitor_queue_command(const char *line);
