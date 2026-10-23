# EasyInput Studio

EasyInput Studio is a browser PWA for monitoring and managing the EasyInput V2.0 development board (firmware board alias `v2`, PCB marking `AI Keyboard V2.1`). It is a static web app with no desktop runtime or backend.

File locations and collaboration rules are defined in [AGENTS.md](AGENTS.md). Protocol details are in [docs/PROTOCOL.md](docs/PROTOCOL.md). Web builds go in `dist/`; versioned firmware packages go in `release/firmware/` so rebuilding the website does not remove them.

## Features

- Board telemetry and input events over USB Serial/JTAG, encrypted BLE GATT, or local-network Wi-Fi WebSocket.
- Independent USB, BLE and Wi-Fi monitoring sessions, with duplicate input events suppressed and USB preferred for network configuration commands.
- Remembered Bluetooth authorization, automatic reconnection, and persistent board-side pairing.
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

USB and Bluetooth can connect to the same board simultaneously. Connecting or disconnecting one does not close the other. Each connection has its own handshake and protocol state; commands use healthy USB first and fall back to healthy Bluetooth. Each USB connection requests a fresh board handshake, allowing Wi-Fi configuration after a late connection or reconnect without restarting the board. This requires monitor firmware 0.1.2 or later with `hello.get` support.

The service worker caches the versioned static app shell and build assets. While the app is visible, it checks for new deployments every 30 minutes. A detected update activates automatically and reloads once USB, BLE, Wi-Fi monitoring, Wi-Fi command, and firmware operations are idle. It does not cache Wi-Fi passwords, board telemetry, or device commands. The browser owns USB/Bluetooth device selection and permission prompts.

## Automatic Bluetooth connection

Select and authorize the board once using **连接**. Studio remembers only the browser's opaque device ID and the automatic connection preference in local storage. On the same browser profile and origin, it restores the authorized device with `Bluetooth.getDevices()` when opening the page. Unexpected disconnects retry with increasing delays, capped at 30 seconds; background retries wait until the page is visible. No background path opens a device chooser. Use **重新选择设备** to change boards or recover a revoked authorization.

**断开** or **取消重连** disables automatic connection until **连接** is clicked again, including after a page reload. Preview and firmware preparation pause it for the current page session. Browsers without `getDevices()` can still reconnect within the same page session, but may require selection again after reopening the page. Initial authorization, cleared site data, revoked permissions and system pairing prompts still require user interaction. Keep using the same site address and browser profile to retain authorization.

Monitor firmware **0.1.3** enables persistent encrypted BLE bonding in NVS (up to three peers). Update the board to retain pairing across power cycles; the first connection after updating may require pairing once. Repeated pairing replaces the affected peer's stale bond, and full bond storage evicts its oldest peer. It does not erase Wi-Fi credentials or the NVS partition.

## Wi-Fi credentials

Enter Wi-Fi credentials once with **保存并自动连接**. They are stored in the board's NVS and automatically retried after startup and disconnection, independently of the webpage. The default view shows the saved network; **重连** / **使用已保存配置连接** reuses its credentials without asking for a password. The password form appears only for initial setup or **更换网络**. The PWA does not save the password on the host. The current partition table does not enable NVS encryption, so configure Wi-Fi only from a trusted session.

Wi-Fi connects the board to its router independently of USB and Bluetooth. Either monitoring connection can configure it; disconnecting the monitoring sessions does not disconnect Wi-Fi. Wi-Fi and Bluetooth share radio resources, so simultaneous traffic may change speed or latency. Firmware flashing and loss of board power restart the whole device and interrupt its connections.

## Monitor over Wi-Fi with the USB cable unplugged

This requires monitor firmware **0.1.4** or later and the local Studio page at `http://127.0.0.1:5173` (or HTTP localhost). The computer and board must be on the same reachable LAN; guest networks or client isolation can prevent access.

1. Update the firmware to 0.1.4, then connect USB or Bluetooth and configure the board's 2.4 GHz Wi-Fi once.
2. After the board receives an IP address, Studio fills it into **网页监控 · Wi-Fi** in the Wi-Fi diagnostics section. Click **连接 Wi-Fi** in the header or **连接 Wi-Fi 监控** in that section. A known board IP can also be entered manually. Allow local-network access if the browser prompts.
3. Wait until Wi-Fi monitoring shows **通信正常**. Unplug USB, keep the board switched on with its lithium battery, and disconnect Bluetooth. Telemetry, runtime and key/encoder events should keep updating, with **Wi-Fi** shown beside the latest-data time.
4. Studio saves only the board IP and automatic-connection preference. Unexpected disconnects reconnect with backoff up to 30 seconds; missing status for eight seconds triggers recovery. Clicking **断开 Wi-Fi** or **取消重连** disables automatic reconnection, including after a reload. Preview and flashing pause it for the current page session.
5. If the router changes the board IP, disconnect/cancel Wi-Fi monitoring and update the IP manually, or reconnect USB/Bluetooth to learn it again. The browser does not scan the LAN. A DHCP reservation on the router can keep the address stable.

Display preference is USB, then BLE, then Wi-Fi, using each connection's own handshake and recent status. Disconnecting USB and BLE leaves a healthy Wi-Fi session active. Wi-Fi monitoring is read-only; network credentials and configuration changes still use USB or encrypted BLE. The board exposes `ws://<board-ip>/ws` on port 80, accepts only HTTP loopback Studio origins, and does not provide TLS or peer authentication. Use it on a trusted LAN. This direct connection is disabled on HTTPS pages, which need a separate secure transport/proxy design.

## Build board firmware

The board-side project targets ESP32-S3 and uses ESP-IDF 5.5.5 or later. Defaults enable the board's Octal PSRAM, per-core FreeRTOS runtime statistics, SPI Flash API counters and the WebSocket server so the app can report those resources over all three monitoring transports.

```sh
cd firmware/easyinput-monitor
idf.py set-target esp32s3
idf.py build
python3 ../../scripts/export-firmware.py --version 0.1.4
```

The export command writes `release/firmware/0.1.4-v2-monitor` containing `firmware.json` and the bootloader, partition table, and app images. The output is relative to the repository root, regardless of the shell's current directory. Firmware packages stay outside the website build output and are excluded from Git. The app checks the manifest, image sizes and SHA-256 hashes before flashing; the manifest is not a signed publisher identity. The WebSocket options in `sdkconfig.defaults` require ESP-IDF 5.5.5 or later. When reusing older generated configurations, regenerate them from these defaults before building so WebSocket support and both handshake callbacks are enabled.

## Automatic connection hardware check

Use Studio with monitor firmware 0.1.3:

1. Connect and authorize Bluetooth once, then reload the same site in the same browser profile. A supporting browser should restore the same board without a device chooser. Power-cycle the board while keeping the page visible; Bluetooth should reconnect and resume telemetry using the stored pairing.
2. Click **断开** or **取消重连**, then reload. Bluetooth should stay disconnected until **连接** is clicked. Preview and firmware preparation should also stop reconnection attempts. USB should remain usable throughout ordinary Bluetooth connections and disconnections.
3. Configure Wi-Fi once, then reload and power-cycle the board. After reconnecting USB or Bluetooth, confirm the saved SSID and Wi-Fi connection without entering its password again. Turn the router off and on and confirm automatic recovery. Use **更换网络** only to change its credentials.
4. Revoke Bluetooth site permission and reopen the page. It should request a manual connection without repeatedly opening choosers. Use **重新选择设备** to authorize again. If the browser lacks `getDevices()`, verify reconnection while the page remains open and expect manual selection after reopening it.

## Connection independence hardware check

Use the updated Studio with monitor firmware 0.1.2 or later:

1. Leave the board powered on for at least five seconds before connecting USB in Studio. The USB status should become **通信正常** and the Wi-Fi section should show the saved network or an enabled **保存并自动连接** setup action.
2. Connect Bluetooth while USB is connected. Both should stay connected; a key press should appear once in the input events.
3. Click **断开 USB** in Studio while leaving the board powered on. Bluetooth should stay connected and continue updating inputs and Wi-Fi status. Reconnect USB without restarting the board; USB should return to **通信正常**.
4. Disconnect Bluetooth while USB is connected. USB, Wi-Fi status and input updates should continue. Also try connecting Bluetooth first, then USB, and canceling each device picker while the other transport is connected.
5. With Wi-Fi configured and connected, disconnect both monitoring sessions in Studio while leaving the board powered on. Reconnect either transport and confirm that Wi-Fi is still connected and board uptime has continued.

With firmware 0.1.4, also connect Wi-Fi monitoring before step 5 and verify that it continues updating after both USB and BLE disconnect. Press and rotate inputs, reconnect USB/BLE, and confirm each input appears once. Power-cycle the board or briefly interrupt the router, confirm Wi-Fi monitoring reconnects, then deliberately disconnect it and reload to confirm it stays disconnected. If Wi-Fi cannot connect, verify the IP, local-network browser permission and router client isolation rather than repeatedly reinstalling dependencies.

## Flashing behavior

The browser filters device access through the Web Serial permission prompt. Firmware flashing uses the board's USB Serial/JTAG connection. The app first attempts automatic entry into download mode using the USB reset sequence. If that connection fails, keep the board powered on, short-press/release **BOOT**, then retry and select its download port. After writing, switch the board off and on to return to normal startup. Do not use the generic “hold BOOT while powering on” sequence. The app requires a separate confirmation after identifying the ESP32-S3 and reading its MAC address.

## Hardware validation boundary

Physical USB enumeration, simultaneous USB/BLE/Wi-Fi sessions, Wi-Fi provisioning/recovery and WebSocket monitoring on battery power, PSRAM initialization, ADC voltage accuracy and sampling, power/charge detection, CPU/temperature readings, key/encoder polarity, BLE radio behavior, and flash/resume behavior still need a board-side check. The encoder direction is a project choice and should be checked against the actual knob. Shared-rail audio and LED behavior require separate electrical qualification before GPIO8 is enabled.
