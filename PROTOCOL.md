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

Wi-Fi setup sends the network name and password over the active USB serial or encrypted BLE connection:

```json
{"type":"command","protocol":2,"action":"wifi.configure","ssid":"Studio-WiFi","password":"example-password"}
{"type":"command","protocol":2,"action":"wifi.connect_saved"}
{"type":"command","protocol":2,"action":"wifi.clear"}
```

The firmware stores credentials in the board's Wi-Fi configuration in NVS. The current partition table does not enable NVS encryption; treat local USB access and the board's NVS contents as sensitive. Passwords are cleared from the UI after sending and from command buffers after use, and are not returned in status or result frames. A `result` frame reports command success without including credentials.

`wifi.connect_saved` retries the Wi-Fi configuration already stored by the board. While association is failing, the firmware keeps retrying and reports an increasing `wifi.retries` count plus the most recent disconnect reason in status frames.

Wi-Fi commands pause automatic reconnection and wait for the station's stopped event before changing configuration. The station is then restarted, and the command initiates one connection attempt using the saved configuration. Stop/start event waits time out after three seconds each. Failed commands include the ESP-IDF error name and numeric code; configuration write failures also attempt to resume station operation using the configuration still held by the driver. No command erases the NVS partition.

## BLE GATT transport

The firmware exposes one custom GATT service while advertising as `EasyInput`:

| Attribute | UUID | Properties |
| --- | --- | --- |
| EasyInput Studio service | `e1000001-6e24-4f51-a3bc-2d8db0000001` | Primary service |
| Board to Studio | `e1000002-6e24-4f51-a3bc-2d8db0000001` | Notify |
| Studio to board | `e1000003-6e24-4f51-a3bc-2d8db0000001` | Encrypted write with response |

Both characteristics carry the same protocol 2 UTF-8 JSON lines used over USB. Board notifications are a byte stream: a JSON frame may span several notifications, so the client reassembles bytes through the next newline before parsing. Studio sends commands as a newline-terminated byte stream in writes of at most 20 bytes; the board reassembles each line before parsing it. The negotiated ATT MTU determines notification chunk size.

On connection, the board negotiates LE Secure Connections encryption without storing a bond. The board has no display or input for MITM verification, so pairing uses Just Works: it encrypts the radio link but does not authenticate the peer against an active nearby attacker. Studio sends Wi-Fi credentials only after it has received protocol data over the encrypted connection. The firmware accepts one BLE peer at a time. Studio uses either USB or BLE as its active data transport; firmware flashing always uses USB.

## Hardware truth and limits

- The board has one native USB-C port. The app filters for Espressif USB Serial/JTAG (`VID 303A`, `PID 1001`) and asks the user to select a port; it does not infer identity from a path such as `/dev/cu.usbmodem…`.
- Wi-Fi uses the ESP32-S3 2.4 GHz station radio. Disconnect reason codes come from ESP-IDF; the app names common authentication, access point, beacon, and handshake failures and retains the numeric code for other reasons.
- BLE advertises as `EasyInput`, reports link state, and exposes the Studio GATT service documented above. BLE command writes require an encrypted link.
- GPIO8 remains low. The hardware knowledge pack has no qualified shared-rail settling condition, so LEDs on GPIO12, microphone input on GPIO11, and speaker output on GPIO15 are reported unavailable/off. The independent status LED GPIO42 is held low.
- The speaker has no physical activity feedback pin. A future status can only report firmware playback state unless hardware feedback is added.
- Battery reporting is limited to calibrated voltage and board power/charge pins. There is no qualified battery chemistry or fuel gauge for a remaining-capacity percentage.
- PSRAM initialization, ADC voltage accuracy and sampling window, GPIO power/charge polarity, Wi-Fi recovery behavior, and CPU/temperature measurements still need verification on the assembled board.
