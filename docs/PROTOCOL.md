# EasyInput Studio board protocol

Studio and `firmware/easyinput-monitor` exchange UTF-8 JSON frames over the board's native USB Serial/JTAG interface, encrypted BLE GATT, or a local-network WebSocket. All three connections can remain open simultaneously. Each frame is one JSON object followed by `\n`. The firmware sends a `hello` frame at startup or when requested, a `status` frame every second, and an `event` frame for each debounced input transition or encoder detent.

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

## Shared voice room (web 0.2.1, firmware 0.2.4)

The cloud room is a persistent service, distinct from a direct LAN monitoring socket. The public default room admits Studio browsers with stable `client` / `name` query parameters; board WSS still requires its provisioned token. The room accepts only fresh board telemetry as presence, prioritizes Wi-Fi, and falls back to an authorized browser forwarding its actual BLE frames. Transport changes do not create duplicate messages.

Voice frames have a separate `protocol: 1` namespace from the existing board-monitor protocol 2. Each UTF-8 JSON object remains newline delimited on BLE/USB; a WSS message carries a complete object. The maximum board command line is 2048 bytes. Bluetooth writes are serialized across command producers so chunks from different JSON frames cannot interleave.

```json
{"type":"chat","protocol":1,"op":"begin","req":"upload-1","id":"message-uuid","samples":8000,"text":"optional original text"}
{"type":"chat","protocol":1,"op":"ack","req":"upload-1","id":"message-uuid","next":0}
{"type":"chat","protocol":1,"op":"chunk","req":"chunk-0","id":"message-uuid","index":0,"data":"base64 mu-law bytes"}
{"type":"chat","protocol":1,"op":"commit","req":"commit-1","id":"message-uuid"}
{"type":"chat","protocol":1,"op":"ack","req":"commit-1","id":"message-uuid","committed":true}
```

The sender role and client slot are derived by the server, never taken from an upload's claimed sender. Chunks are 768 bytes, except the final remainder. Index and exact sample count must match before commit. A retry of an acknowledged piece or committed message is idempotent. Errors return `op: error` with the matching `req` and a human-readable `message`.

Browser snapshot/presence frames carry `online`, `via` (`wifi`, `ble`, or null), `clients`, and the initial `self` / `messages`. A committed `op: message` broadcasts full message metadata to every browser. Metadata fields are `id`, `sender`, `name`, `slot`, `samples`, `created` (server Unix ms), optional `text`, `read`, and `cleared`. Board replies use `sender: board`, `slot: -1`. Slots 0–3 map to S1–S4; slot 4 aggregates all later computers on S8. A server retention eviction broadcasts `op: pruned` with IDs.

The board syncs metadata one item at a time with `op: index, offset`. A response contains `id, slot, samples, read, cleared` or `end: true`. Live messages use `op: item` with the same compact fields. The board downloads only the selected message:

```json
{"type":"chat","protocol":1,"op":"pull","req":"play-0","id":"message-uuid","index":0}
{"type":"chat","protocol":1,"op":"audio","req":"play-0","id":"message-uuid","index":0,"samples":8000,"data":"base64 mu-law bytes"}
{"type":"chat","protocol":1,"op":"read","req":"read-1","id":"message-uuid"}
{"type":"chat","protocol":1,"op":"clear","req":"clear-1","slot":0}
{"type":"chat","protocol":1,"op":"cleared","req":"clear-1","slot":0,"ids":["message-uuid"]}
```

`read` is emitted only after complete speaker playback plus DMA drain, never on download or playback start. `clear` can affect only computer messages in that slot that are already read. The server deletes their audio and broadcasts `op: cleared` to browsers; unread messages remain intact. Cleared records are retained as text-only receipts until history retention removes them. Board recording upload IDs are random, permitting retry across a transport reconnect. A failed or interrupted playback does not emit `read`.

A browser Bluetooth gateway sends `{ "type": "gateway", "payload": <actual board frame> }`. The server sends `{ "type": "bridge", "payload": <board-bound frame> }` only to the chosen gateway. BLE disconnection emits `op: gateway.off`. Status frames must continue advancing `uptime_ms`; pings from a browser cannot keep a disconnected board online. Browser `op: ping` / `pong` checks only cloud connectivity. The room alarm updates expired presence while browsers are idle.

Voice data is 8 kHz mono G.711 mu-law, with at most 480,000 bytes per message. The board captures its right I2S slot at 16 kHz / 32-bit stereo and averages adjacent 16-bit samples before encoding; playback repeats each decoded sample at 16 kHz in both 16-bit stereo slots. Physical microphone alignment, speaker gain, rail timing and real LED order still require assembled-board verification.

Status protocol 2 now optionally includes `cloud: { configured: boolean, online: boolean }`, enabling the one-time setup form to hide already saved cloud credentials. This board-reported cloud field does not override the room's presence decision.

### Board delivery and local controls (0.2.1)

A board `ping` receives `pong` with the same `req` and `via: wifi | ble`, derived from the authenticated transport (direct board socket or selected Bluetooth gateway). A connection alone is not proof of Internet reachability. Board announcements use a matching acknowledgement younger than 8 seconds; probes run every 3 seconds.

Board recordings use a durable eight-slot Flash outbox. Each slot is 512 KiB, with its header in the first 4 KiB and at most 480,000 audio bytes. CRCs cover the audio and immutable header fields; the pending header is published after audio. A one-way state bit retires a clip only after a cloud commit acknowledgement. Stable IDs persist across boots. Cloud `delivered:<id>` receipts survive chat/audio retention to deduplicate later board retries. A failed or 12-second timed-out upload is retried after 3 seconds; retries do not rewrite the outbox.

Protocol-2 status optionally adds `voice: { pending, sending, storage_error, s8_enabled, setup_active }`; pending is an integer 0–9 (8 Flash slots plus a possible RAM clip on save failure). The fifth LED prioritizes outgoing delivery: yellow blinking while actively sending, steady yellow while waiting, then the S8 unread/read/off state. S8 disabled affects playback, preserving incoming audio and unread state. Volume and S8 settings persist in the `voice` NVS namespace after one second without changes.

Firmware 0.2.2 gives active recording the highest priority on the fifth LED: orange (`#FF8000`) with approximately 350 ms on / 350 ms off, beginning with an on phase after recording successfully starts. S6, the 60-second cutoff, and other recording-stop paths retire the orange indication before saving audio to Flash. Delivery then uses the yellow states above; a recording that did not start never gets an orange indication.

Firmware 0.2.3 initializes SNTP with `ntp.aliyun.com` and starts it when DHCP supplies the station IPv4 address. The cloud WebSocket task remains closed until system time is at or after 2025-01-01 UTC. This prevents a cold-boot clock from rejecting current TLS certificates as not yet valid. Once connected, the board sends a lightweight protocol-2 status with an advancing `uptime_ms` every three seconds; the server uses it for presence, while full telemetry remains a separate frame.

Firmware 0.2.4 moves status production, BLE transmit and cloud-helper stacks to PSRAM using `xTaskCreateWithCaps`. Tasks that may access flash while caches are disabled, including voice-outbox storage, USB firmware operations and phone setup, remain on internal RAM; the input scanner and audio I/O also remain internal. This preserves internal heap and large contiguous blocks for the mbedTLS handshake without violating the ESP-IDF PSRAM-stack flash rule. Full multi-kilobyte telemetry stays on USB/BLE; the cloud WebSocket receives only the lightweight presence status plus chat frames, and uses a 2 KiB transport buffer.

Knob rotation adjusts voice volume by 5% per detent (0–100%, initially 20%). A short knob press toggles S8 playback; a 3-second hold starts/extends a 120-second WPA2 SoftAP window and suppresses short press. S7 requests a queued local network announcement. Prompts are pre-generated offline assets and are never chat messages or read receipts.

During physical provisioning only, the board exposes `GET /`, `GET /setup-status`, and `POST /setup` at its AP address, http://192.168.4.1. POST JSON contains `ssid`, `password`, and optional `code` (initial cloud pairing code); `X-Setup-Token` matches the fresh page token. The saved station and cloud config survive reboot. Credentials are not in telemetry, chat, responses, or browser storage. The AP closes automatically; this does not erase config or recordings. Phone provisioning does not require Web Bluetooth.
