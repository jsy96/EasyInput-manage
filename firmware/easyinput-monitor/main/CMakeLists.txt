idf_component_register(SRCS "main.c" "lights.c" "audio.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_driver_gpio esp_driver_rmt esp_driver_ledc esp_driver_i2s esp_driver_usb_serial_jtag esp_driver_tsens esp_adc esp_wifi esp_http_server esp_event esp_netif nvs_flash bt esp_app_format esp_partition app_update json spi_flash esp_mm)
