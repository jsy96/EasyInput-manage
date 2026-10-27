#pragma once
#include <stdbool.h>
#include "esp_http_server.h"

typedef bool (*network_setup_save_t)(const char *ssid, const char *password, const char *pairing_code);
void network_setup_init(httpd_handle_t server, network_setup_save_t save, void (*reconnect)(void));
void network_setup_begin(void);
bool network_setup_active(void);
