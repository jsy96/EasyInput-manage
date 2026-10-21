# EasyInput Studio USB protocol

The desktop app and `firmware/easyinput-monitor` exchange UTF-8 JSON frames over the board's native USB Serial/JTAG interface. Each frame is one JSON object followed by `\n`. The firmware sends a `hello` frame at startup, a `status` frame every second, and an `event` frame for each debounced input transition or encoder detent.

All frames use `protocol: 2`. The desktop ignores older, unknown, or malformed versions. Credentials are accepted only in the `wifi.configure` command and are never included in board status, result frames, or firmware logs.

## Board to desktop

```json
{"type":"hello","protocol":2,"board":"easyinput-v2","chip":"ESP32-S3","firmware":"0.1.0","uptime_ms":1234}
{"type":"status","protocol":2,"uptime_ms":2345,"wifi":{"state":"connected","configured":true,"ssid":"Studio-WiFi","rssi":-48,"channel":6,"disconnect_code":0,"disconnects":1,"retries":1,"ip":"192.168.1.82","netmask":"255.255.255.0","gateway":"192.168.1.1","dns":"192.168.1.1"},"ble":{"state":"advertising","name":"EasyInput","peers":0},"peripherals":{"shared_rail":"off"},"lights":{"status_led":"off","pixels":["off","off","off","off","off"]},"speaker":{"state":"unavailable"},"microphone":{"state":"unavailable","rms":0,"vad":false},"cpu":{"frequency_mhz":160,"usage_percent":[18,11],"temperature_c":43.5},"memory":{"internal":{"total_bytes":328000,"free_bytes":176000,"minimum_free_bytes":148000,"largest_block_bytes":132000},"psram":{"total_bytes":8388608,"free_bytes":8120000,"largest_block_bytes":8000000}},"storage":{"flash":{"state":"ready","total_bytes":16777216,"unallocated_bytes":12582912,"read_bytes_per_second":0,"write_bytes_per_second":0,"erase_bytes_per_second":0},"partitions":[{"label":"nvs","address":36864,"size_bytes":24576,"type":1,"subtype":2}],"app":{"state":"running","partition_bytes":4128768,"image_bytes":985456,"free_bytes":3143312},"nvs":{"state":"ready","total_bytes":24576,"used_entries":41,"free_entries":715,"total_entries":756}},"power":{"battery_mv":4010,"external_power":true,"charging":true}}
{"type":"event","protocol":2,"source":"key","key":"S1","action":"down","uptime_ms":3456}
{"type":"event","protocol":2,"source":"encoder","action":"rotate","delta":1,"uptime_ms":4567}
```

`wifi` includes the station connection state, configured SSID (never its password), RSSI, channel, last disconnect reason code, disconnect/retry counters and IPv4 address, netmask, gateway and DNS when available. `storage.partitions` enumerates the flash partition table. Flash I/O rates count ESP-IDF SPI flash API operations, not memory-mapped reads or total bus traffic. `flash.unallocated_bytes` is the unused area after the last partition. CPU usage is estimated from each core's FreeRTOS idle time; temperature is the ESP32-S3 internal sensor reading. Internal RAM and PSRAM report total/free/minimum/largest blocks as supported by the heap allocator. NVS free space is reported in entries as well as partition bytes.

`source` is `key`, `encoder`, or `microphone`. Key and encoder-button actions are `down`/`up`; encoder movement uses `rotate` and a signed detent `delta`. Microphone events can use `vad_start`, `vad_end`, and `level` when the board's shared audio rail has been qualified and microphone capture is enabled.

## Desktop to board

All commands use `{"type":"command","protocol":2,"action":"…"}`. `status.get` requests an immediate status frame.

Wi-Fi setup sends the network name and password over the local USB serial connection:

```json
{"type":"command","protocol":2,"action":"wifi.configure","ssid":"Studio-WiFi","password":"example-password"}
{"type":"command","protocol":2,"action":"wifi.clear"}
```

The firmware stores credentials in the board's Wi-Fi configuration in NVS. The current partition table does not enable NVS encryption; treat local USB access and the board's NVS contents as sensitive. Passwords are cleared from the UI after sending and from command buffers after use, and are not returned in status or result frames. A `result` frame reports command success without including credentials.

## Hardware truth and limits

- The board has one native USB-C port. The app filters for Espressif USB Serial/JTAG (`VID 303A`, `PID 1001`) and asks the user to select a port; it does not infer identity from a path such as `/dev/cu.usbmodem…`.
- Wi-Fi uses the ESP32-S3 2.4 GHz station radio. Disconnect reason codes come from ESP-IDF; the app names common authentication, access point, beacon, and handshake failures and retains the numeric code for other reasons.
- BLE starts advertising as `EasyInput` and reports advertising or link-connected state. It does not expose an application GATT service yet.
- GPIO8 remains low. The hardware knowledge pack has no qualified shared-rail settling condition, so LEDs on GPIO12, microphone input on GPIO11, and speaker output on GPIO15 are reported unavailable/off. The independent status LED GPIO42 is held low.
- The speaker has no physical activity feedback pin. A future status can only report firmware playback state unless hardware feedback is added.
- Battery reporting is limited to calibrated voltage and board power/charge pins. There is no qualified battery chemistry or fuel gauge for a remaining-capacity percentage.
- PSRAM initialization, ADC voltage accuracy and sampling window, GPIO power/charge polarity, Wi-Fi recovery behavior, and CPU/temperature measurements still need verification on the assembled board.
