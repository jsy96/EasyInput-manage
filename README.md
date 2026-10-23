# EasyInput Studio

EasyInput Studio is a browser PWA for monitoring and managing the EasyInput V2.0 development board (firmware board alias `v2`, PCB marking `AI Keyboard V2.1`). It is a static web app with no desktop runtime or backend.

## Features

- Board telemetry and input events over USB Serial/JTAG or encrypted BLE GATT.
- Wi-Fi configuration, saved-credential reconnection, and connection diagnostics.
- Firmware package validation, ESP32-S3 identification, explicit write confirmation, progress, and per-image flashing without whole-flash erase.
- A clearly marked interface preview mode that works without connecting to hardware.
- Installable PWA shell with offline-cached static application assets. Device telemetry and credentials are not cached.

## Run the web app

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. For production, `npm run build` writes static files to `dist/`; serve those files from an HTTPS origin to enable PWA installation and device APIs. `npm run preview` serves the production build locally.

USB Serial and Web Bluetooth require a secure browser context and an explicit browser permission. Use a current desktop Chrome or Edge browser for board connection and firmware flashing. Safari and iOS browsers do not provide the required device APIs. The firmware package importer uses Chromium's directory picker.

The service worker caches the versioned static app shell and build assets. While the app is visible, it checks for new deployments every 30 minutes. A detected update activates automatically and reloads once USB, BLE, Wi-Fi command, and firmware operations are idle. It does not cache Wi-Fi passwords, board telemetry, or device commands. The browser owns USB/Bluetooth device selection and permission prompts.

## Wi-Fi credentials

Wi-Fi credentials are stored in the board's NVS and automatically retried after startup. The PWA does not save the password on the host. Use **重试已保存配置** to retry without entering the password again. The current partition table does not enable NVS encryption, so configure Wi-Fi only from a trusted session.

## Build board firmware

The board-side project targets ESP32-S3 and uses ESP-IDF 5.5 or later. Defaults enable the board's Octal PSRAM, per-core FreeRTOS runtime statistics, and SPI Flash API counters so the app can report those resources.

```sh
cd firmware/easyinput-monitor
idf.py set-target esp32s3
idf.py build
python3 ../../scripts/export-firmware.py --version 0.1.1 --output ../../dist/firmware/0.1.1-v2-monitor
```

The export command writes `dist/firmware/0.1.1-v2-monitor` containing `firmware.json` and the bootloader, partition table, and app images. The app checks the manifest, image sizes and SHA-256 hashes before flashing; the manifest is not a signed publisher identity.

## Flashing behavior

The browser filters device access through the Web Serial permission prompt. Firmware flashing uses the board's USB Serial/JTAG connection. The app first attempts automatic entry into download mode using the USB reset sequence. If that connection fails, keep the board powered on, short-press/release **BOOT**, then retry and select its download port. After writing, switch the board off and on to return to normal startup. Do not use the generic “hold BOOT while powering on” sequence. The app requires a separate confirmation after identifying the ESP32-S3 and reading its MAC address.

## Hardware validation boundary

No physical EasyInput device is available in this workspace session, so USB enumeration, Wi-Fi provisioning/recovery, PSRAM initialization, ADC voltage accuracy and sampling, power/charge detection, CPU/temperature readings, key/encoder polarity, BLE radio behavior, and flash/resume behavior still need a board-side check. The encoder direction is a project choice and should be checked against the actual knob. Shared-rail audio and LED behavior require separate electrical qualification before GPIO8 is enabled.
