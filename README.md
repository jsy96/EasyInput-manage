# EasyInput Studio

EasyInput Studio is a local desktop monitor and firmware manager for the EasyInput V2.0 development board (firmware board alias `v2`, PCB marking `AI Keyboard V2.1`). The app uses the board's single native USB-C connection to receive state and input events, and can flash a local firmware bundle to an ESP32-S3.

## Current features

- USB Serial/JTAG connection and protocol heartbeat state.
- Wi-Fi diagnostics (SSID, signal, channel, IP/mask/gateway/DNS, disconnect code, retry counters), USB-based Wi-Fi setup and configuration clearing.
- BLE advertising/connection state, status LED, shared peripheral power, five WS2812 pixels, microphone level/VAD fields, and speaker state when reported by firmware.
- Live CPU usage by core, frequency and chip temperature; internal RAM and PSRAM totals/free space/fragmentation; Flash partitions, application image headroom, NVS entry headroom, and Flash API read/write/erase rates.
- Host network adapter addresses, masks, and MAC addresses, plus board battery voltage, external-power, and charging state.
- Live S1–S8 press/release events, encoder rotation and press events, plus microphone event slots in the protocol.
- Local firmware bundle import, SHA-256 and target checks, ESP32-S3/MAC identification, explicit write confirmation, per-image progress, and no whole-flash erase.
- A clearly marked interface preview mode that uses synthetic data without connecting to hardware.

The monitor firmware intentionally holds GPIO8 low because the shared LED/microphone/speaker rail still needs a board-qualified ready condition. Until that qualification exists, the app reports those consumers as unavailable rather than showing guessed physical state. Mic audio capture, WS2812 control, and speaker playback are therefore not active in this firmware build. Wi-Fi can be configured from the app; the password travels over USB and is stored in the board's NVS. The current partition table does not enable NVS encryption, so configure Wi-Fi only over a trusted local USB connection.

## Run the desktop app

```sh
npm install
npm run dev
```

The app is local-only. To connect to a running monitor firmware, choose **连接开发板** and select the EasyInput ESP32-S3 USB Serial/JTAG port. The expected application protocol is documented in [PROTOCOL.md](PROTOCOL.md).

## Build board firmware

The board-side project targets ESP32-S3 and uses ESP-IDF 5.5 or later. Defaults enable the board's Octal PSRAM, per-core FreeRTOS runtime statistics, and SPI Flash API counters so the app can report those resources.

```sh
cd firmware/easyinput-monitor
idf.py set-target esp32s3
idf.py build
python3 ../../scripts/export-firmware.py --version 0.1.0 --output ../../dist/firmware/0.1.0-v2-monitor
```

The export command writes `dist/firmware/0.1.0-v2-monitor` containing `firmware.json` and the bootloader, partition table, and app images. The app version is embedded in the firmware build and the export command rejects a mismatched package version. Select that directory in the app. The manifest contains byte sizes and SHA-256 hashes for accidental-corruption checks; it is not a signed publisher identity.

## Flashing behavior

The app filters to the board's native ESP32-S3 USB Serial/JTAG port, reads the chip and MAC from the ROM loader, then requires a separate user confirmation showing the detected target. It writes only the listed images at their declared offsets and never issues an erase-all operation. It uses the no-reset connect mode because this board's boot circuit has a specific physical flow.

For this board, keep it powered on and short-press/release **BOOT** to enter download mode. After writing, switch the board off and on to return to normal startup. Do not use the generic “hold BOOT while powering on” sequence. The desktop interface does not flash a connected board automatically.

## Current hardware validation boundary

The firmware can be built without connecting a board. No physical EasyInput device is available in this workspace session, so USB enumeration, Wi-Fi provisioning/recovery, PSRAM initialization, ADC voltage accuracy and sampling, power/charge detection, CPU/temperature readings, key/encoder polarity, BLE radio behavior, and flash/resume behavior still need a board-side check. The encoder direction is a project choice and should be checked against the actual knob. Shared-rail audio and LED behavior require separate electrical qualification before GPIO8 is enabled. Flash rates count SPI Flash API calls, CPU usage is inferred from idle-task runtime, and chip temperature comes from the ESP32-S3 internal sensor.
