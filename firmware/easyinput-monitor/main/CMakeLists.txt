idf_component_register(SRCS "main.c" "lights.c" "audio.c" "cloud.c" "voice_chat.c" "voice_outbox.c" "voice_prompts.c" "network_setup.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_driver_gpio esp_driver_rmt esp_driver_ledc esp_driver_i2s esp_driver_usb_serial_jtag esp_driver_tsens esp_adc esp_wifi esp_http_server esp_event esp_netif nvs_flash bt esp_app_format esp_partition app_update json spi_flash esp_mm espressif__esp_websocket_client esp-tls mbedtls
                       EMBED_FILES "assets/wifi.ulaw" "assets/ble.ulaw" "assets/offline.ulaw" "assets/setup.ulaw" "assets/s8_on.ulaw" "assets/s8_off.ulaw" "assets/full.ulaw" "assets/save_failed.ulaw" "assets/setup_failed.ulaw"
                       EMBED_TXTFILES "assets/setup.html")
