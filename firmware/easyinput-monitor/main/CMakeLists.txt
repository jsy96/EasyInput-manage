idf_component_register(SRCS "main.c" "lights.c" "audio.c" "cloud.c" "voice_chat.c" "voice_outbox.c" "voice_prompts.c" "timers.c" "network_setup.c" "health_records.c" "ledger_records.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_driver_gpio esp_driver_rmt esp_driver_ledc esp_driver_i2s esp_driver_usb_serial_jtag esp_driver_tsens esp_adc esp_wifi esp_coex esp_http_server esp_event esp_netif nvs_flash bt esp_app_format esp_partition app_update json spi_flash esp_mm espressif__esp_websocket_client esp-tls mbedtls
                       EMBED_FILES "assets/prompts.bin"
                       EMBED_TXTFILES "assets/setup.html")
