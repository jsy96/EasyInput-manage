# EasyInput Studio board protocol

Current release: firmware 0.4.21 and Studio 0.4.8 (2026-10-29, Asia/Shanghai). Firmware 0.4.21 retains the S8 stopwatch, five indicators and alarm chime introduced in 0.4.20. Alarm save/cancel failures now use the existing generic failure prompt; runtime alarm and trigger-deduplication state change only after successful NVS write and commit. Error logs identify the open, set or commit stage and error code. The prompt pack removes 42 unused entries, reducing 209 entries and 1,350,676 bytes to 167 entries and 986,582 bytes; retained IDs and each retained audio SHA-256 remain unchanged.

All 130 tests across 16 files, the webpage build including type checking, and the ESP-IDF 5.5.5 firmware build passed. The 2,603,472-byte application (`0x27b9d0`) leaves approximately 37% headroom in the `0x3f0000` application partition. The package was exported to `release/firmware/0.4.21-v2-monitor/`, and all three image sizes and SHA-256 hashes match its manifest. Flashing the identity-matched original ESP32-S3 (MAC `14:C1:9F:39:7D:20`) succeeded and verified all three image hashes, writing only the bootloader, partition table and application at `0x0`, `0x8000` and `0x10000`, preserving NVS and the recording outbox. Post-flash logs explicitly confirm App version 0.4.21, ESP-IDF v5.5.5 and normal startup, without panic, abort, stack-error, brownout or ROM-download signatures.

Studio 0.4.8 is deployed at `studio.leige.online` using Workers Static Assets, deployment version `8766bd7d-63b2-4bdc-8ddd-0dc0b10a63e8`. HTTP GET byte/hash comparisons confirm that the public HTML, main JavaScript, CSS, manifest and Service Worker match the local `dist/` build; the JavaScript reports version 0.4.8. The gateway was unchanged and not redeployed, retaining version `79e77ee8-cbe9-431f-a7d5-285e9037aabc`. These checks establish flashing, startup and static deployment, not physical button, light or sound behavior. The actual cause of the reported NVS alarm-save failure remains unconfirmed; the change does not establish that a storage fault has been resolved. The following release paragraphs record earlier versions.

Historical 0.4.20 build/export record (2026-10-29): this version added the independent S8 stopwatch and revised the five indicators and alarm chime. All 128 tests across 15 files, type checking, the webpage build and ESP-IDF 5.5.5 firmware build passed. The 2,967,360-byte application left approximately 28% application-partition headroom; all three exported image sizes and SHA-256 hashes matched `release/firmware/0.4.20-v2-monitor/firmware.json`. That round did not flash firmware or redeploy the webpage or gateway; its historical package is retained. The later 0.4.21 flashing and deployment results do not change that record.

Released on 2026-10-29 with coordinated Studio 0.4.7, cloud gateway and firmware 0.4.18 updates. The public HTML, application script, stylesheet and Service Worker match the local build; 127 automated tests, type checks, the webpage build and ESP-IDF 5.5.5 firmware build passed. Firmware 0.4.18 was flashed to the target ESP32-S3 while preserving NVS and the recording outbox; serial output confirms its application version and normal startup without a panic signature in the startup log. S7 continuous recognition, browser text display and audible success/failure still require user hardware testing. Earlier firmware 0.4.17 S6 hardware results do not validate the new S7 path.

The subsequent S7 retry fix was built, exported and flashed as firmware 0.4.19 on 2026-10-29, with Studio remaining at 0.4.7 and no webpage or gateway redeployment. This round's actual checks passed: 14 test files with 127 tests, type checking, the webpage build and the final ESP-IDF 5.5.5 firmware build. The application image is 2,857,152 bytes with approximately 31% application-partition headroom, and the package is exported to `release/firmware/0.4.19-v2-monitor/`. The target identity matched; flashing exited successfully and verified all three image hashes, writing only the bootloader, partition table and application while preserving NVS and the recording outbox. Post-flash verification confirmed application mode rather than ROM download mode; serial output explicitly shows application version 0.4.19 and `EasyInput monitor firmware started`, without panic, Guru Meditation, abort, stack-canary/overflow or brownout signatures. These are flash/startup checks, not voice-path validation. The user's initial recognition-failure trigger has not been reproduced on hardware; S7 end-to-end display and audible results still require user operation and testing.

Studio and `firmware/easyinput-monitor` exchange UTF-8 JSON control and telemetry frames over the board's native USB Serial/JTAG interface, encrypted BLE GATT, or a local-network WebSocket. Webpage-controlled realtime audio additionally uses binary PCM16 frames over the board's direct cloud WSS. All monitoring connections can remain open simultaneously. JSON frames are newline delimited on USB/BLE. The firmware sends a `hello` frame at startup or when requested, a `status` frame every second, and an `event` frame for each debounced input transition or encoder detent.

All frames use `protocol: 2`. The desktop ignores older, unknown, or malformed versions. Credentials are accepted only in the `wifi.configure` command and are never included in board status, result frames, or firmware logs.

## Board to desktop

```json
{"type":"hello","protocol":2,"board":"easyinput-v2","chip":"ESP32-S3","firmware":"0.1.3","uptime_ms":1234}
{"type":"status","protocol":2,"uptime_ms":2345,"wifi":{"state":"connected","configured":true,"ssid":"Studio-WiFi","rssi":-48,"channel":6,"disconnect_code":0,"disconnects":1,"retries":1,"ip":"192.168.1.82","netmask":"255.255.255.0","gateway":"192.168.1.1","dns":"192.168.1.1"},"ble":{"state":"advertising","name":"EasyInput","peers":0},"peripherals":{"shared_rail":"off"},"lights":{"status_led":"off","pixels":["off","off","off","off","off"]},"speaker":{"state":"unavailable"},"microphone":{"state":"unavailable","rms":0,"vad":false},"cpu":{"frequency_mhz":160,"usage_percent":[18,11],"temperature_c":43.5},"memory":{"internal":{"total_bytes":328000,"free_bytes":176000,"minimum_free_bytes":148000,"largest_block_bytes":132000},"psram":{"total_bytes":8388608,"free_bytes":8120000,"largest_block_bytes":8000000}},"storage":{"flash":{"state":"ready","total_bytes":16777216,"unallocated_bytes":12582912,"read_bytes_per_second":0,"write_bytes_per_second":0,"erase_bytes_per_second":0},"partitions":[{"label":"nvs","address":36864,"size_bytes":24576,"type":1,"subtype":2}],"app":{"state":"running","partition_bytes":4128768,"image_bytes":985456,"free_bytes":3143312},"nvs":{"state":"ready","total_bytes":24576,"used_entries":41,"free_entries":715,"total_entries":756}},"power":{"battery_mv":4010,"external_power":true,"charging":true}}
{"type":"event","protocol":2,"source":"key","key":"S1","action":"down","uptime_ms":3456}
{"type":"event","protocol":2,"source":"encoder","action":"rotate","delta":1,"uptime_ms":4567}
```

`wifi` includes the station connection state, configured SSID (never its password), RSSI, channel, last disconnect reason code, disconnect/retry counters and IPv4 address, netmask, gateway and DNS when available. `storage.partitions` enumerates the flash partition table. Flash I/O rates count ESP-IDF SPI flash API operations, not memory-mapped reads or total bus traffic. `flash.unallocated_bytes` is the unused area after the last partition. CPU usage is estimated from each core's FreeRTOS idle time; temperature is the ESP32-S3 internal sensor reading. Internal RAM and PSRAM report total/free/minimum/largest blocks as supported by the heap allocator. NVS free space is reported in entries as well as partition bytes.

`source` is `key`, `encoder`, or `microphone`. Key and encoder-button actions are `down`/`up`; encoder movement uses `rotate` and a signed detent `delta`. Firmware 0.1.6 emits microphone `vad_start`, `vad_end`, and `level` events while capture is enabled; its rail timing and audio format are provisional bring-up settings pending assembled-board qualification.

## Desktop to board

All commands use `{"type":"command","protocol":2,"action":"…"}`. `hello.get` requests a fresh `hello` frame followed by an immediate `status` frame. Studio sends it after opening each USB serial session, including reconnects while BLE remains connected, so it does not depend on receiving the startup greeting. The request does not restart the board or change its Wi-Fi configuration. `status.get` requests an immediate status frame.

```json
{"type":"command","protocol":2,"action":"hello.get"}
```

The reconnect handshake requires monitor firmware 0.1.2 or later with `hello.get` support; update the board firmware together with Studio.

Wi-Fi setup sends the network name and password over the active USB serial or encrypted BLE connection:

```json
{"type":"command","protocol":2,"action":"wifi.configure","ssid":"Studio-WiFi","password":"example-password"}
{"type":"command","protocol":2,"action":"wifi.connect_saved"}
{"type":"command","protocol":2,"action":"wifi.clear"}
```

The firmware stores credentials in the board's Wi-Fi configuration in NVS. The current partition table does not enable NVS encryption; treat local USB access and the board's NVS contents as sensitive. Passwords are cleared from the UI after sending and from command buffers after use, and are not returned in status or result frames. A `result` frame reports command success without including credentials.

`wifi.connect_saved` retries the Wi-Fi configuration already stored by the board, with no password in the request. Startup and unexpected Wi-Fi disconnects also reconnect automatically using those credentials. Studio defaults to this saved-network state and shows the password form only for initial setup or an explicit network change. While association is failing, the firmware keeps retrying and reports an increasing `wifi.retries` count plus the most recent disconnect reason in status frames.

Wi-Fi commands pause automatic reconnection and wait for the station's stopped event before changing configuration. The station is then restarted, and the command initiates one connection attempt using the saved configuration. Stop/start event waits time out after three seconds each. Failed commands include the ESP-IDF error name and numeric code; configuration write failures also attempt to resume station operation using the configuration still held by the driver. No command erases the NVS partition.

## BLE GATT transport

The firmware exposes one custom GATT service while advertising as `EasyInput`:

| Attribute | UUID | Properties |
| --- | --- | --- |
| EasyInput Studio service | `e1000001-6e24-4f51-a3bc-2d8db0000001` | Primary service |
| Board to Studio | `e1000002-6e24-4f51-a3bc-2d8db0000001` | Notify |
| Studio to board | `e1000003-6e24-4f51-a3bc-2d8db0000001` | Encrypted write with response |

Both characteristics carry the same protocol 2 UTF-8 JSON lines used over USB. Board notifications are a byte stream: a JSON frame may span several notifications, so the client reassembles bytes through the next newline before parsing. Studio sends commands as a newline-terminated byte stream in writes of at most 20 bytes; the board reassembles each line before parsing it. The negotiated ATT MTU determines notification chunk size.

Starting with firmware 0.1.3, the board negotiates LE Secure Connections encryption with persistent bonding in NVS. It exchanges encryption and identity keys, restores bonds after reboot, replaces a peer's stale bond on repeat pairing and evicts the oldest peer if its three-bond store is full. The board has no display or input for MITM verification, so pairing uses Just Works: it encrypts the radio link but does not authenticate the peer against an active nearby attacker. Studio sends Wi-Fi credentials only after the selected transport has received its own `hello` and a recent `status` frame. The firmware accepts one BLE peer at a time and supports a simultaneous USB session to the same board.

Studio saves the browser-issued device ID and automatic connection preference locally. When supported, it uses `Bluetooth.getDevices()` to recover that exact authorized device on page load. Unexpected disconnects retry with backoff capped at 30 seconds while the page is visible. A deliberate disconnect disables automatic reconnection, including on reload; preview and firmware preparation pause it for the current session. Only explicit connection or device reselection can call `requestDevice()`. The browser and operating system retain control over initial authorization and pairing. After subscribing, Studio requests `hello.get` to recover greetings sent before the notification listener was ready.

Studio maintains separate buffers, handshakes and freshness checks for USB, BLE and Wi-Fi. Connecting, canceling, failing or disconnecting one transport does not close the others. Displayed telemetry prefers USB when its status is less than three seconds old, then healthy BLE, then healthy Wi-Fi. Network configuration commands prefer healthy USB and otherwise healthy BLE; they never use Wi-Fi. Such a command is sent once through the selected transport and is not automatically replayed after a write failure. Broadcast result frames complete the pending command once, and matching input events received over multiple transports are displayed once. Queuing BLE and Wi-Fi telemetry precedes USB writes so a missing USB host does not delay notifications.

Wi-Fi station operation and saved credentials are independent of Studio's monitoring sessions. Disconnecting any or all monitoring sessions does not stop Wi-Fi. Since firmware 0.1.4, Wi-Fi is also a Studio telemetry transport. Wi-Fi and BLE share the ESP32-S3 radio with software coexistence enabled, so simultaneous traffic can affect throughput and latency. Firmware flashing uses USB and restarts the whole board, which necessarily interrupts its running radios.

## Wi-Fi WebSocket monitoring (firmware 0.1.4)

The endpoint is `ws://<station-ip>/ws` on port 80, with up to three clients. Before upgrading, the board checks the browser's `Origin` against HTTP loopback origins (`127.0.0.1`, `localhost`, `[::1]`, with an optional valid port). Unsupported origins are rejected with HTTP 403. The origin check does not authenticate native clients; this unencrypted monitor is intended for a trusted local network.

Each server text message contains one complete protocol 2 JSON line. On opening a socket, Studio sends `hello.get` and waits for both its own valid EasyInput V2 / ESP32-S3 `hello` and a full `status` frame before reporting a successful connection. Only `hello.get` and `status.get` commands are accepted over this endpoint. Binary, fragmented, oversized (512 bytes or more), malformed, incompatible and configuration-command requests close the session. The common command queue serializes permitted requests with USB/BLE commands, outside the HTTP task.

Outgoing frames are queued to the HTTP task so slow sockets do not block the input scanner. At most 16 outgoing frames are pending, the server sends with a one-second socket timeout, and failed sends close the affected client. Queue saturation drops frames rather than consuming unbounded memory. WebSocket setup errors leave USB/BLE monitoring usable.

Studio learns and remembers a local IPv4 address from USB/BLE status. A manual connect enables remembered reconnection; learning an address alone does not open a socket. Automatic reconnection backs off from one to 30 seconds and waits for page visibility. Eight seconds without a valid status (or without the initial handshake) closes and retries the socket. Explicit disconnection disables auto-connect across reloads; preview/flashing only pauses it for the page session. A changing DHCP address must be updated manually or learned again from USB/BLE. No LAN discovery or scanning is performed.

The computer and board must share a reachable LAN. The current client requires an HTTP loopback Studio page, such as `http://127.0.0.1:5173`; HTTPS pages display a clear limitation instead of repeatedly attempting a blocked insecure connection. Browser local-network permission and router client isolation can also affect connectivity. The battery must keep the board powered after unplugging USB.

## Light control (firmware 0.1.5+)

Protocol stays at version 2. Existing `lights.status_led`, `lights.pixels` and `peripherals.shared_rail` fields remain compatible. New firmware additionally includes this `lights.control` object in every status frame:

```json
{"ready":true,"status_led_brightness":0,"pixels":[{"color":"#FF0000","brightness":20,"on":true},{"color":"#FFFFFF","brightness":20,"on":false},{"color":"#FFFFFF","brightness":20,"on":false},{"color":"#FFFFFF","brightness":20,"on":false},{"color":"#FFFFFF","brightness":20,"on":false}]}
```

The five settings use 0-based wire order; Studio labels them 1–5. Colors use `#RRGGBB`, brightness is an integer 0–100, and `on` is boolean. Legacy `pixels` report emitted on/off state after rail gating and RGB scaling; a black color, zero brightness, or channels rounded to zero can be off even when the enable flag is true. Control values describe the last committed firmware settings, not optical or electrical sensor feedback. Without this object Studio requires a firmware upgrade; `ready:false` disables control and an optional string `error` names the driver error. Driver failures attempt to stop RMT and safely power down, mark affected output state unknown if power remains on, and require reboot before further control.

Send light commands only through USB or encrypted BLE. Wi-Fi accepts only its existing monitoring requests. Studio sends one operation at a time, prefers healthy USB then BLE, and does not replay failed writes. Each UI operation has a unique ASCII UUID `request_id` (firmware accepts strings of 1–64 UTF-8 bytes); firmware echoes it with the same action in the broadcast result. Matching both fields prevents duplicate transport results or another client's operation from completing the wrong UI request. Requests without an ID are allowed for manual clients; results omit it. Status is emitted before the result. On timeout, check the current status before retrying because the write may already have taken effect.

```json
{"type":"command","protocol":2,"action":"lights.pixel.set","index":0,"color":"#FF0000","brightness":20,"on":true,"request_id":"example-1"}
{"type":"command","protocol":2,"action":"lights.all.set","color":"#0088FF","brightness":20,"on":true,"request_id":"example-2"}
{"type":"command","protocol":2,"action":"lights.off","request_id":"example-3"}
{"type":"command","protocol":2,"action":"lights.status.set","brightness":30,"request_id":"example-4"}
{"type":"command","protocol":2,"action":"peripherals.power.set","on":false,"request_id":"example-5"}
{"type":"result","protocol":2,"action":"lights.pixel.set","request_id":"example-1","ok":true,"message":"设置已应用。"}
```

Pixel set changes exactly one setting; all set copies one setting to five pixels. `lights.off` clears only enable flags and sends a black frame when powered. It does not switch off GPIO8 or alter per-pixel colors/brightness. Indicator brightness 0 switches GPIO42 off; positive values set its independent 5 kHz/13-bit PWM output. Invalid indexes, colors, brightness values or boolean flags are rejected before changing output.

The auto-driven indicator mapping above is mirrored to Studio in real time. Whenever the computed state changes, the firmware queues a compact frame through the cloud WebSocket; while the cloud is down the frame rides the BLE queue and is re-queued once the cloud link returns (USB viewers follow within the next one-second full status):

```json
{"type":"lights","protocol":2,"uptime_ms":12345,"status_led":"off","modes":["off","solid","flash","blink","off"]}
```

`modes` is five strings in 0-based wire order, each `off`, `solid`, `blink` (slow blink), or `flash` (one 0.15 s flash per second). The cloud gateway relays the frame to every browser, which renders the same states with matching timing; over USB without a `lights` frame the page falls back to the sampled `lights.pixels` on/off values.

The shared rail defaults off. A nonzero emitted pixel automatically enables it. At cold start, GPIO8 and downstream command outputs are latched low before output direction is enabled; GPIO11 stays disabled/floating without pulls. On every rail enable the firmware restores downstream safe levels, raises GPIO8, waits `SHARED_RAIL_SETTLE_MS=100` plus one scheduler tick, then creates/enables RMT and sends a black frame before colors. This is a **provisional project bring-up wait**, not a measurement or proof that all components/batches have stabilized. The board exposes no rail-ready feedback in this implementation. Qualify the settling waveform and voltage/DIN margins on the actual assembled board before accepting the result.

RMT transmits GRB at 800 kbit/s (T0H/T0L 0.40/0.85 µs, T1H/T1L 0.80/0.45 µs) plus a 300 µs low latch. The entire five-pixel frame and end marker fit in RMT memory. Each channel is scaled with `(value * brightness + 50) / 100` when enabled. Shared shutdown sends black, waits for audio I/O, stops/detaches both I²S controllers and RMT, restores GPIO9/10/12/13/14/15 low and GPIO11 disabled/floating, then lowers GPIO8. Pixel enable flags are cleared; powering back on alone does not restore previously lit pixels. The independent GPIO42 PWM is unaffected. The shared-rail mutex serializes light operations and audio startup. The audio worker uses a separate mutex, with strict lock order rail → audio → I²S. Shutdown takes the audio mutex to wait for bounded in-flight DMA calls; if an audio controller cannot be stopped/detached, GPIO8 stays on and an error is reported.

Settings are volatile and reset on reboot. Disconnecting a monitoring transport does not switch the lights off. Firmware before 0.1.6 reports microphone/speaker as `unavailable`. Firmware 0.1.6 starts both idle and enables them on demand through the shared-power gate.

## Audio control (firmware 0.1.6+)

Protocol remains 2. An optional top-level `audio` capability distinguishes the new firmware from older devices. Typical audio fields in a status frame are:

```json
{"audio":{"ready":true,"sample_rate_hz":16000},"microphone":{"state":"active","rms":512,"vad":true},"speaker":{"state":"idle","volume":10}}
```

`audio.ready` means the worker and shared-power gate are available, including while GPIO8 is off; it does not prove physical capture/playback. Microphone states are `idle`/`active`/`unavailable`; speaker states are `idle`/`playing`/`unavailable`. Each device can include an `error` string containing an ESP-IDF error name. Initialization failure disables audio capability until reboot. Channel failures stop/release the affected driver and permit retry through its start command. Speaker state describes firmware playback, without physical feedback. RMS and VAD reset when capture stops or power is disabled. Test volume defaults to 10 and records the last requested digital amplitude percentage.

Commands use USB/encrypted BLE and share the light-command queue, request correlation, timeout and no-replay behavior. Emit a fresh status before acknowledging each command. Wi-Fi remains read-only.

```json
{"type":"command","protocol":2,"action":"audio.microphone.set","on":true,"request_id":"audio-1"}
{"type":"command","protocol":2,"action":"audio.microphone.set","on":false,"request_id":"audio-2"}
{"type":"command","protocol":2,"action":"audio.speaker.test","volume":10,"request_id":"audio-3"}
{"type":"command","protocol":2,"action":"audio.speaker.stop","request_id":"audio-4"}
{"type":"event","protocol":2,"source":"microphone","action":"level","rms":512,"vad":true,"uptime_ms":4567}
```

`on` must be boolean. Test `volume` is an integer 1–20 (omission defaults to 10); invalid arguments do not power the rail or alter audio. Starting audio automatically enables shared power and waits for the same provisional settling gate used by pixels. Stopping capture/playback releases its I²S channel and restores its safe pins while keeping shared power on. Explicit power-off stops both audio functions before restoring downstream pins and lowering GPIO8. Power-on alone never resumes capture or playback. Settings are volatile; disconnecting any monitoring session leaves capture running. No PCM data is persisted or sent to Studio.

Project format: independent I²S0 RX on GPIO9/10/11 and I²S1 TX on GPIO14/13/15, both 16 kHz Philips stereo. RX uses 32-bit slots with signed, high-aligned 24-bit samples converted to 16-bit units, removes each slot's DC mean and takes the higher slot RMS (0–32768); the board schematic ties microphone SELECT high. Both slots are captured so an empty slot does not halve the reported level. RX ignores the first 100 ms and reports a channel timeout after 500 ms without received samples. A successfully clocked stream of zeros cannot prove that a physical microphone works.

The basic energy VAD starts at RMS 300 and releases below RMS 180 after a 300 ms hold. The status task samples activity about every 100 ms, emits `level` events no faster than every 250 ms plus start/stop, and broadcasts `vad_start`/`vad_end` on observed transitions. These are sound-activity heuristics, not a speech classifier; ambient sound and speaker playback can trigger them. Status frames continue about once per second. Studio uses newer microphone events between status frames for its meter/activity display.

TX sends identical 16-bit samples to both slots: 440 Hz for 16,000 frames, with 20 ms amplitude fades, then drains up to six 256-frame DMA blocks plus 20 ms and releases the controller. DMA automatically clears completed TX buffers to silence; repeated playback replaces the current test. Capture and playback can run concurrently. Actual slot format, sensitivity, thresholds, DMA behavior under radio load, rail settling and audible output require assembled-board verification.

## Hardware truth and limits

- The board has one native USB-C port. The app filters for Espressif USB Serial/JTAG (`VID 303A`, `PID 1001`) and asks the user to select a port; it does not infer identity from a path such as `/dev/cu.usbmodem…`.
- Wi-Fi uses the ESP32-S3 2.4 GHz station radio. Disconnect reason codes come from ESP-IDF; the app names common authentication, access point, beacon, and handshake failures and retains the numeric code for other reasons.
- BLE advertises as `EasyInput`, reports link state, and exposes the Studio GATT service documented above. BLE command writes require an encrypted link.
- GPIO8 defaults low, and 0.1.5+ implements explicit/automatic light power control with the provisional project timing described above. Rail settling and 3.3 V LED-DIN margins have not been electrically qualified. GPIO12 drives five serial GRB pixels; GPIO42 is an independent green status LED. Firmware 0.1.6 adds on-demand microphone/speaker I²S drivers using the same shared-power gate; physical audio behavior remains unverified.
- The speaker has no physical activity feedback pin. Status reports firmware playback state; actual sound requires an audible check.
- Battery reporting is limited to calibrated voltage and board power/charge pins. There is no qualified battery chemistry or fuel gauge for a remaining-capacity percentage.
- PSRAM initialization, ADC voltage accuracy and sampling window, GPIO power/charge polarity, Wi-Fi recovery behavior, and CPU/temperature measurements still need verification on the assembled board.

## Shared voice room (web and firmware 0.4.1)

The cloud room is a persistent service, distinct from a direct LAN monitoring socket. The public default room admits Studio browsers with stable `client` / `name` query parameters; board WSS still requires its provisioned token. The room accepts only fresh board telemetry as presence, prioritizes Wi-Fi, and falls back to an authorized browser forwarding its actual BLE frames. Transport changes do not create duplicate messages.

Voice frames use a separate `protocol: 2` namespace from the board-monitor protocol 2. Each UTF-8 JSON object remains newline delimited on BLE/USB; a WSS message carries a complete object. The maximum board command line is 2048 bytes. Bluetooth writes are serialized across command producers so chunks from different JSON frames cannot interleave.

```json
{"type":"chat","protocol":2,"op":"begin","req":"upload-1","id":"message-uuid","samples":8000}
{"type":"chat","protocol":2,"op":"ack","req":"upload-1","id":"message-uuid","next":0}
{"type":"chat","protocol":2,"op":"chunk","req":"chunk-0","id":"message-uuid","index":0,"data":"base64 mu-law bytes"}
{"type":"chat","protocol":2,"op":"commit","req":"commit-1","id":"message-uuid"}
{"type":"chat","protocol":2,"op":"ack","req":"commit-1","id":"message-uuid","committed":true}
```

The sender role is derived by the server, never taken from an upload's claimed sender. There are no per-computer slots. Chunks are 768 bytes, except the final remainder. Index and exact sample count must match before commit. A retry of an acknowledged piece or committed message is idempotent. Errors return `op: error` with the matching `req` and a human-readable `message`.

Browser snapshot/presence frames carry `online`, `via` (`wifi`, `ble`, or null), `clients`, the initial `self` / `messages` (newest 50 only), whole-room `total` / `unread`, older-history cursor `next`, `realtimeEnabled`, and `realtimeActive`. A committed `op: message` broadcasts `{ id, sender, name, samples, created, read }` to every browser. Messages from browser and board share one chronological timeline. A retention eviction broadcasts `op: pruned` with IDs and current totals. New messages set `added:true`; read-status changes do not, so browsers do not insert unseen older records into their loaded window. `readAll` broadcasts one compact event marking loaded items read and setting the global unread count to zero.

Unread status applies only to browser voice messages awaiting board playback or explicit bulk marking. Board recordings are outgoing messages: they are stored with `read:true`, excluded from `unread`, and shown without a read-status label in the browser. This flag does not imply that anyone listened to a board recording. On history load, older board recordings with `read:false` are corrected atomically and the index revision advances; their audio and the read status of browser messages are preserved.

After each presence refresh the server sends the board `{ "type": "chat", "protocol": 2, "op": "audience", "online_clients": N }`. `N` counts unique persisted browser identities with at least one ready WebSocket; multiple tabs from one identity count once.

The board syncs metadata with `op: index, offset, count:8`. A response contains `items` (compact `id, created, samples, read`), `next`, `end` and `revision`. After a complete pass the board sends `ifRevision` at offset zero; an unchanged index responds `unchanged:true`. Later pages carry `revision`; a mutation between pages responds `restart:true` and the board retries from zero. The 5000-entry board index is allocated in PSRAM. Requests without `count` keep the legacy single-item response (`id, created, samples, read` or `end:true`). Live browser messages use `op: item` with the same compact fields. The board downloads only the selected message:

```json
{"type":"chat","protocol":2,"op":"pull","req":"play-0","id":"message-uuid","index":0}
{"type":"chat","protocol":2,"op":"audio","req":"play-0","id":"message-uuid","index":0,"samples":8000,"data":"base64 mu-law bytes"}
{"type":"chat","protocol":2,"op":"read","req":"read-1","id":"message-uuid"}
```

`read` is emitted only after complete speaker playback plus DMA drain, never on download or playback start. Retention removes old eligible messages automatically. A separate `POST /admin/clear` maintenance endpoint requires a Bearer `CLEAR_TOKEN`, clears the default room's message metadata, audio chunks, and incomplete uploads, and broadcasts `op: pruned` with all removed IDs to connected browsers. It preserves board delivery receipts, client identities, and realtime settings. Board recording upload IDs are random, permitting retry across a transport reconnect. A failed or interrupted playback does not emit `read`.

A browser Bluetooth gateway sends `{ "type": "gateway", "payload": <actual board frame> }`. The server sends `{ "type": "bridge", "payload": <board-bound frame> }` only to the chosen gateway. BLE disconnection emits `op: gateway.off`. Status frames must continue advancing `uptime_ms`; pings from a browser cannot keep a disconnected board online. Browser `op: ping` / `pong` checks only cloud connectivity. The room alarm updates expired presence while browsers are idle.

Browser `op:list` returns at most 50 ascending messages from the newest eligible page, an older-page `next` cursor (or null), the fixed upper cursor `through` and bounded-history `total`. Cursors have `{created,id}`; requests use optional `before` and `through`. Full exports reuse the first `through`, prepend older pages and validate their total. Commit timestamps increase monotonically so later messages stay outside an export. The room retains at most 5000 messages. Capacity eviction selects the earliest board recording or read message; unread browser messages are protected. Metadata is persisted separately under `voice-message:<id>`, with an atomic, idempotent migration from the legacy array. New commits atomically store binary `clip:<id>`, metadata, persisted revision and board receipt, and remove incomplete upload state. Legacy Base64 audio remains readable. History clear preserves health records and receipts and emits bounded `pruned` batches.

Persistent voice data is 8 kHz mono G.711 mu-law, with at most 160,000 bytes (20 seconds) per message. Browser uploads use `chunks` batches, browser downloads use `pullBatch`, and the board uses `stream` windows followed by `streamAck`. The board uses up to twenty-four 768-byte chunks per stream window and starts playback after buffering 9,216 bytes (about 1,152 ms), or after the complete shorter message, while continuing to extend the active audio buffer.

Realtime listening uses transient frames:

```json
{"type":"chat","protocol":2,"op":"realtime.set","req":"settings-1","enabled":true}
{"type":"chat","protocol":2,"op":"settings","realtime_enabled":true}
{"type":"chat","protocol":2,"op":"realtime.start","req":"realtime-1"}
{"type":"chat","protocol":2,"op":"ack","req":"realtime-1","active":true}
{"type":"chat","protocol":2,"op":"realtime.stop"}
```

`realtime.set` comes from a browser and directly requests capture on/off; it is no longer permission for a physical key. The boolean `enabled` field is required. Opening requires a fresh direct Wi-Fi board route. The room persists a small requested-state flag and start timestamp, broadcasts settings to browsers and sends `settings.realtime_enabled` to the board. The board immediately starts/stops capture on that setting; S7/S8 do not control it. The board sends `realtime.start` synchronously on the same ordered WebSocket, then immediately starts binary audio. Its matching acknowledgement uses an independent request ID so timeline replies cannot interfere. Realtime audio uses binary WebSocket messages, not JSON or Base64:

```text
bytes 0..3   "EIV2"
byte 4       version 1
byte 5       codec 1 = PCM16LE
bytes 6..7   reserved, zero
bytes 8..11  uint32 little-endian sequence
bytes 12..   exactly 320 mono samples, 640 bytes
```

Each packet is 652 bytes and represents 20 ms at 16 kHz. Only an authenticated board may send binary packets, and the Worker forwards them only to browsers while the room realtime session is active. Realtime packets are not stored and do not enter the timeline. Turning the room flag off, direct board disconnection, stale Wi-Fi presence, or failure to start within eight seconds clears both requested and active state. Heartbeats repair lost start/stop notifications, including `voice.realtime_active` in full telemetry; telemetry never enables a session without a webpage request. S6/S7 cannot start a competing Xiaozhi session during webpage listening; S8 toggles the independent stopwatch and does not change capture.

This PCM16 realtime phase requires the board's direct Wi-Fi cloud connection. The browser Bluetooth gateway continues to carry monitoring and timeline frames, but does not carry realtime audio.

Status protocol 2 now optionally includes `cloud: { configured: boolean, online: boolean }`, enabling the one-time setup form to hide already saved cloud credentials. This board-reported cloud field does not override the room's presence decision.

### Board delivery and local controls (0.2.1)

A board `ping` receives `pong` with the same `req` and `via: wifi | ble`, derived from the authenticated transport (direct board socket or selected Bluetooth gateway). A connection alone is not proof of Internet reachability. Board announcements use a matching acknowledgement younger than 8 seconds; probes run every 3 seconds.

Board recordings use a durable eight-slot Flash outbox. Each slot is 512 KiB, with its header in the first 4 KiB and at most 160,000 audio bytes. CRCs cover the audio and immutable header fields; the pending header is published after audio. A one-way state bit retires a clip only after a cloud commit acknowledgement. Stable IDs persist across boots. Cloud `delivered:<id>` receipts survive chat/audio retention to deduplicate later board retries. A failed or 12-second timed-out upload is retried after 3 seconds; retries do not rewrite the outbox.

Protocol-2 status optionally adds:

```json
{"voice":{"pending":0,"sending":false,"storage_error":false,"setup_active":false,"alarm_minute":750,"countdown_seconds":0,"stopwatch_running":false,"stopwatch_seconds":0,"realtime_active":false,"realtime_enabled":true}}
```

`pending` is an integer 0–9 (8 Flash slots plus a possible RAM clip on save failure). `alarm_minute` is `null` or minute-of-day 0–1439. WS2812 brightness is the minimum non-zero level, 1%:

- LED 1 slow-blinks red while receiving a new voice index item (one 2.5-second cycle) or downloading voice content; otherwise it is solid red while unread voice messages remain, and off when neither condition holds. Receiving takes priority. Heartbeats and updates to known items do not trigger receiving indication.
- LED 2 slow-blinks red for one minute from the alarm event; otherwise it flashes at 1 Hz while either countdown or stopwatch is running; otherwise it is solid red while a daily alarm is set, or off. Priority is alarm event > running timers > saved alarm. Hidden timers continue running.
- LED 3 is solid red during S5 recording or an S6/S7 session, including connection/result waiting; otherwise it slow-blinks while audio or text is pending, or is off.
- LED 4 slow-blinks red only while webpage realtime capture is active, otherwise off.
- LED 5 slow-blinks red while the authenticated voice-service heartbeat is fresh, otherwise it is solid red (including startup before a successful probe). Direct Wi-Fi and the selected BLE gateway both qualify. Probes run every 3 seconds; a receipt is fresh for less than 8 seconds. Association to an AP or a working Xiaozhi session alone is not sufficient.

These rules apply from firmware 0.4.20. Every slow blink uses 0.5 seconds on followed by 2 seconds off; the 1 Hz timer flash uses 0.5 seconds on, 0.5 seconds off. All lit pixels use 1% brightness. The browser uses the same timing but does not synchronize animation phase with physical pixels.

Holding S1 for three seconds asks whether to mark all unread voice messages read. Release S1 and hold S2 for another three seconds to send the board-only chat operation `readAll`; the room marks every unread timeline item read, preserves history and stored audio, broadcasts `readAll`, and replies `{"op":"ack","count":<changed>}`. The board announces success after the acknowledgement, and failure after an error or 12-second timeout. A short S2 release or pressing S3/S4/the knob cancels the confirmation. S5–S7 are ignored during confirmation; S8 still toggles the independent stopwatch. LED 1 follows receiving/unread status throughout; it no longer represents confirmation. Browser labels say “开发板已读” because bulk marking does not prove playback.

Firmware 0.2.3 initializes SNTP with `ntp.aliyun.com` and starts it when DHCP supplies the station IPv4 address. The cloud WebSocket task remains closed until system time is at or after 2025-01-01 UTC. This prevents a cold-boot clock from rejecting current TLS certificates as not yet valid. Once connected, the board sends a lightweight protocol-2 status with an advancing `uptime_ms` every three seconds; the server uses it for presence, while full telemetry remains a separate frame.

Status production, BLE transmit and cloud-helper stacks remain on PSRAM. Tasks that may access flash while caches are disabled, including the voice outbox, USB firmware operations and phone setup, remain on internal RAM. The input scanner and audio I/O also remain internal. Full telemetry stays on USB/BLE; the cloud WebSocket receives the lightweight presence status and chat frames.

S5 short press starts recording; another short press stops and sends it. At the 20-second limit, the recording is cached and waits for another short S5 press to send during the current boot; the held-slot marker is RAM-only, so a saved clip resumes the regular outbox retry flow after reboot. Holding S5 for three seconds discards the current recording or its held outbox slot, and release does not send it. Already submitted clips and other pending outbox slots are preserved. S5 has no double-click action. S6 short press starts a Xiaozhi voice conversation; another short press immediately stops microphone capture and speaker playback and requests session closure. S6 no longer opens a ledger editor or announces a ledger summary.

Knob rotation adjusts the active S3 alarm or S4 countdown. Outside those editors each detent changes runtime speaker volume by 10% within 10–100%, including during S6 conversation and S7 transcription; volume feedback is deferred while recording or in a Xiaozhi session. Outside recording and Xiaozhi sessions a three-second hold starts or extends the 120-second WPA2 SoftAP window and suppresses short press. During an S6 conversation only S6, S8 and knob rotation act; during an S7 session only S7, S8 and knob rotation act. Other key presses are consumed through release. S7/S8 measurement editing, knob coarse/fine measurement adjustment and double-click measurement queries have been removed. Prompt clips are generated at build time, packed into `prompts.bin`, and never become chat messages.

S7 starts/stops continuous Xiaozhi transcription, described below. From 0.4.20, S8 independently toggles a stopwatch on each valid release (holding also toggles once on release). Its timestamps come from input event time, not delayed prompt playback. It never cancels countdowns, history playback, S5 recording, S6/S7 sessions or webpage realtime capture.

Optional `voice.stopwatch_running` is a boolean; `voice.stopwatch_seconds` is an integer in 0–4294967295, representing elapsed whole seconds while running or the last stopped result. Firmware uses a monotonic microsecond clock, floors to seconds and saturates only at the wire-field maximum. Starting clears the previous result, stopping freezes the elapsed duration, and reboot resets runtime stopwatch state without NVS writes. Countdown and stopwatch can run simultaneously. Full USB/BLE telemetry carries these optional fields; the existing lightweight cloud heartbeat does not carry full timer telemetry. The browser shows waiting when no compatible full status is available rather than inventing a live value.

Stopwatch start and duration prompts wait for a free speaker/microphone, idle Xiaozhi engine, no realtime capture, no active settings prompt and no bulk-read confirmation. A quick stop may suppress an unplayed start cue. Deferred results are FIFO, with eight RAM entries; once full, further starts are rejected until a result is scheduled for speech, and a deferred busy cue explains the condition. Results and queued cues do not survive reboot. Duration speech omits zero higher units, with zero seconds spoken for a subsecond interval.

A daily alarm records its LED event time immediately and defers sound while audio is occupied. It plays one due announcement followed by one locally synthesized approximately ten-second chime, not a minute-long loop. The one-minute LED window runs from the alarm event, independently of delayed audio. Countdown completion is also deferred while audio is occupied; ordinary ticks are not replayed later. During countdown, S1–S7 or knob press cancels it, while S8 remains independent.

Existing measurement data remains in the `health/history_v1` NVS blob, including all six latest values and up to 64 pending records from older firmware. Disabling the old input/query controls does not erase that data, pending synchronization, cloud history or browser CSV export. Legacy six-key values remain latest values only; no past measurement is invented.

Existing ledger data remains in the independent `ledger/history_v1` NVS blob, including up to 64 pending entries left by older firmware. Removing the S6 editor and summary shortcuts does not erase those records, their synchronization state, cloud history, or browser CSV export.

During physical provisioning only, the board exposes `GET /`, `GET /setup-status`, and `POST /setup` at its AP address, http://192.168.4.1. POST JSON contains `ssid`, `password`, and optional `code` (initial cloud pairing code); `X-Setup-Token` matches the fresh page token. The saved station and cloud config survive reboot. Credentials are not in telemetry, chat, responses, or browser storage. The AP closes automatically; this does not erase config or recordings. Phone provisioning does not require Web Bluetooth.


### Measurement history synchronization and CSV

Measurements previously saved through S7/S8 remain distinct records, including repeated numeric values; the current controls no longer create them. Existing pending records survive reboot. The voice task continues to send `health.put` independently of audio transfer request IDs and retries after 12 seconds until a matching `health.ack` has been persisted locally. Direct Wi-Fi and the selected Bluetooth gateway use the same transport path. The board removes only the acknowledged queue head; a lost acknowledgement is safe to retry.

Ledger synchronization follows the same acknowledgement/retry rules with independent `ledger.put` / `ledger.ack` request IDs. Only board-originated frames, including the selected gateway, may write ledger records; the room transactionally deduplicates stable IDs and stores each distinct save. Ledger data is preserved when voice history is pruned or cleared.

```json
{"type":"chat","protocol":2,"op":"ledger.put","req":"ledger-1","record":{"id":"0123456789abcdef0123456789abcdef","amount":273,"recordedAt":null,"uptimeMs":12345}}
```

`amount` is 1–999 integer CNY. `recordedAt` is device Unix milliseconds or null until calibrated; cloud `receivedAt` is stored separately. Browsers request `ledger.list` with `after` (default 0) and a fixed `through` returned by the first page. Each response contains up to 100 `records`, `next`, `through`, and `complete`; records add `sequence` and `receivedAt`. The client validates contiguous sequences and stable bounds before exporting all synchronized entries to a UTF-8 BOM CSV with UTC timestamps. Compact Wi-Fi status and full USB/BLE status carry `ledger_pending` (0–64); room snapshots/presence expose `ledgerPending`, or null when offline. Firmware, gateway, and website updates are required together for ledger synchronization and export.

```json
{"type":"chat","protocol":2,"op":"health.put","req":"health-1","record":{"id":"0123456789abcdef0123456789abcdef","kind":"father_glucose","value":75,"measuredAt":null,"uptimeMs":12345}}
{"type":"chat","protocol":2,"op":"health.ack","req":"health-1","id":"0123456789abcdef0123456789abcdef"}
```

`id` is 16 random bytes encoded as 32 lowercase hex characters. `kind` is one of `mother_high`, `mother_low`, `father_high`, `father_low`, `father_glucose`, `mother_glucose`. Glucose is an integer in tenths (75 = 7.5 mmol/L); pressure is an integer in mmHg. Legacy record validation accepts high pressure 80–220, low pressure 50–120 and glucose 30–200 integer tenths. `measuredAt` is Unix milliseconds or null when the board clock is not calibrated; `uptimeMs` was captured at save. Only board frames, including selected gateway frames, can write measurements. Browsers cannot write them through `health.put`.

The room atomically stores each unique ID, a monotonically increasing `sequence`, and server `receivedAt`. It does not prune measurement history with the 5000-message voice timeline or the voice-history clear operation. Duplicate IDs acknowledge the original stored measurement without appending another row. Browsers request `health.list` with `after` (default 0) and optional `through`; the response contains up to 100 `records`, `next`, `through` and `complete`. The first page fixes `through` to the current record count; subsequent pages reuse it so incoming measurements do not change an export in progress. Export includes every sequence up to that bound.

`voice.health_pending` in full board status and top-level `health_pending` in the compact Wi-Fi heartbeat report the pending measurement count (0–64). Browser snapshots and presence expose the selected fresh route's count as `healthPending` (null when unknown or offline). The device page exports all synchronized history to a UTF-8 BOM CSV with measurement ID, UTC measurement time, clock status, person, metric, value, unit, UTC receive time and uptime. Unknown measurement time remains blank and is labeled; receipt time is never substituted as measurement time. Upgrading from legacy firmware cannot recover previously overwritten measurements. Gateway and firmware updates are both required for history synchronization.


### Xiaozhi conversation, S7 transcription and legacy data compatibility

S5/S6/S7 resolve short presses on release without a double-click window. Repeated short presses perform their ordinary start/stop actions, subject to the S7 finishing state below. S7/S8 no longer have measurement double-click actions; S8 toggles the independent stopwatch on release.

S6 opens a direct secure WebSocket session with Xiaozhi using the board's saved Wi-Fi, actual MAC and persistent UUID. The official OTA response supplies activation and connection information; firmware updates in that response are ignored. The client supports WebSocket transport versions 1–3, sends 16 kHz mono Opus in 60 ms frames, validates negotiated downlink audio parameters, assembles bounded text and binary messages across network chunks and WebSocket fragments, and decodes assistant audio to 16 kHz mono PCM for streamed speaker playback. Opus supports selecting the decoder output rate independently of the encoded source rate. The service controls utterance boundaries and can impose its own idle/session limits; the normal recording's 20-second cap does not end a conversation.

Conversation uses `listen.start` mode `auto` for automatic turn taking. On assistant TTS start, capture pauses and buffered microphone input is discarded before speaker playback. Listening resumes only after both the server's `tts.stop` and local playback/DMA drain, then sends the next `listen.start` on the same session. User speech during assistant playback is not captured. Knob rotation changes volume without playing an in-session announcement. Alarm/countdown and other local prompts wait until conversation exit. S6 release immediately stops capture and playback, even while connecting; network closure runs asynchronously without the legacy transcription's 20-second final-result drain. Except for independent S8 stopwatch control and knob rotation, other keys are consumed through release so they cannot trigger a normal action when the session ends between press and release.

S6 conversation, S7 transcription, ordinary recording and webpage-controlled realtime listening are mutually exclusive. An existing recording/upload or webpage listening session rejects a new Xiaozhi start; S6/S7 do not toggle the webpage's listening setting. A new webpage listening request cannot start another microphone path during Xiaozhi. S6 `stt`, assistant text and audio are not submitted to the room timeline or stored as recordings. Network, protocol, codec or buffer failures stop capture/playback and report failure; the next S6 short press can retry. Binding, speech recognition, reply audio, turn transitions, immediate stopping and multi-turn behavior remain hardware/service verification items.

S7 opens a transcription session using Xiaozhi `listen.start` mode `realtime`, keeps capturing user speech and forwards recognized user `stt` results while the session is running. Assistant text/audio is not forwarded or played. Results may form multiple timeline messages; firmware splits long results without breaking characters, keeping each part within both 1000 UTF-16 units and 3000 UTF-8 bytes. The normal 20-second recording limit does not cap this session. A second S7 release immediately stops microphone capture, sends remaining audio frames and allows up to 20 seconds for final recognition. Once transcription terminates, a separate 12-second deadline bounds outstanding browser-display confirmations. At least one result and confirmation for every result in this session are required to announce “成功”; no result, processing failure, partial delivery or an expired deadline announces “失败”. A second S7 during the start prompt cancels and announces failure; further S7 presses while finishing do not open another session.

Text delivery preserves existing timeline rows and pending text from older firmware. Only an authenticated board or selected gateway may submit `text.put`; text is trimmed, nonempty and limited to 1000 UTF-16 units. Timeline metadata adds `kind:"text",text:<string>,samples:0,read:true,sender:"board"`; legacy voice rows may omit `kind`. Normal `message` broadcasts and `list` pagination include both kinds within the same 5000-message retention limit. Board `index`, voice export and audio pull/stream exclude text. Stable delivery tombstones prevent a retried text from reappearing after pruning or administrative clearing.

```json
{"type":"chat","protocol":2,"op":"text.put","req":"text-1","id":"<stable-id>","text":"你好","require_display":true}
{"type":"chat","protocol":2,"op":"text.ack","req":"text-1","id":"<stable-id>","displayed":false}
{"type":"chat","protocol":2,"op":"text.displayed","req":"display-1","id":"<stable-id>"}
{"type":"chat","protocol":2,"op":"text.displayed","req":"display-1","id":"<stable-id>"}
{"type":"chat","protocol":2,"op":"text.displayed","id":"<stable-id>"}
```

The first two frames are board submission and cloud persistence acknowledgement. `displayed` reports whether a browser receipt is already persisted; `false` alone is not successful webpage delivery. The third frame comes directly from a browser only after its mounted chat component commits the text to its DOM. The fourth acknowledges that browser request after persisting `displayed:<id>`; the fifth is the separate board-bound notification and has no `req`. At least one mounted chat component is sufficient; the device page and connections without a mounted chat component do not send display receipts. This proves DOM submission, not that a person read the text. The browser deduplicates confirmed IDs per connection and makes up to three attempts with three-second request timeouts; reconnecting permits confirmation again.

When `require_display:true`, firmware retains the pending text until a matching `text.displayed` or `text.ack` with `displayed:true`. A retried, retained `text.put` without a display receipt is rebroadcast with `added:false,display_required:true`, allowing a browser that missed the initial broadcast to insert the valid board text while preserving counts and avoiding another timeline row. Cloud persistence and display receipts use stable IDs independently of audio request IDs. Legacy submissions may omit `require_display` and still complete after durable cloud acknowledgement. Website, cloud gateway and firmware must be updated together for the S7 display-confirmed success path.

The persisted `stt/pending` head is retried with its stable ID and a 12-second acknowledgement timeout; S7 uses this queue while S6 results do not append to it. Failure keeps unconfirmed text in the same FIFO for background retry without blocking a new S7 session, unless the queue is completely full. Later delivery never plays a delayed success cue for the failed session. At each accepted engine start, the queue guard atomically records how many prior entries remain and resets the session counters; the boundary is actual engine acceptance, not the button press or start prompt. ACKs first retire those prior entries without increasing this session's acknowledged count. The controller's success condition is this session's `received_texts > 0`, `acked_texts == received_texts` and `session_queued_texts == 0`, with no engine failure. Older queued entries do not themselves make a new session fail or succeed. Stable IDs and current inflight-ID checks prevent a delayed prior receipt from retiring a different new head.

Full status exposes `voice.stt.received_texts` and `acked_texts` for the accepted session, `session_queued_texts` for its actual remaining FIFO entries (total queue size minus remaining prior entries), and `queued_texts` for the entire FIFO including prior sessions. Explicit cancellation may clear the queue and set `session_queued_texts` to zero without fabricating display ACKs. Delivery diagnostics distinguish `delivery.no_text`, `delivery.offline`, `delivery.display_timeout`, `delivery.engine_failed` and `delivered`. An already recorded first engine failure stage/error is preserved rather than replaced by the final delivery diagnosis. Canceling the start prompt or rejecting an engine start skips the final delivery-diagnosis writeback; engine-start errors such as `start.unavailable`, `start.busy` and `start.queue_full` remain available. Manual regression must include a failed display-confirmation round followed by a new S7 start, mixed old/new queue delivery, duplicate old ACKs while a new head is inflight, and an empty new recognition despite old ACKs arriving.

Only the persisted head has a cross-reboot guarantee; additional queued results remain in RAM, so the whole transcription session is not guaranteed to survive power loss. Measurement, ledger and ledger-summary synchronization and their in-flight NVS-writing acknowledgements are deferred while Xiaozhi is busy, retaining pending records and request IDs for retries after exit; S7 text delivery and its acknowledgements remain active during recognition. Capture and playback use bounded RAM buffers for scheduling and network jitter, not offline recording; session audio is not recoverable after power loss or transport failure.

Board-only `ledger.summary` replies with `day=floor((UnixMilliseconds+28800000)/86400000)`, `totals:[today,yesterday,dayBefore]`, `latest:<integer-yuan-or-zero>` and `unknown:<count-with-null-date>`. The room first backfills aggregates from historical ledger sequences, then transactionally updates each aggregate with the deduplicated ledger write. Unknown recording dates are excluded from daily totals. Aggregates and latest amount survive pending-queue acknowledgement in the board's version-2 `ledger/history_v1` blob; v1 queues are imported without claiming complete totals until cloud backfill succeeds. A response is applied only when the queue is empty, the device day matches, fields fit the board's integer ranges, and no new local save has occurred since its request. Incomplete totals are not announced as complete data.
