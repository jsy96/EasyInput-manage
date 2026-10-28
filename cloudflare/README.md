# EasyInput shared gateway

The Worker and SQLite Durable Object provide authenticated board WSS, shared presence, a single persistent voice timeline, stable browser identities, and transient realtime microphone forwarding. The static Studio PWA is deployed separately with `studio.wrangler.jsonc`.

`PUBLIC_DEVICE_ID` identifies the one default room. Any browser on an allowed Studio origin can join this room without a token; every visitor shares its messages and board status. The board still requires `PAIRING_SECRET`, saved once to its NVS. Keep this secret unchanged when deploying to preserve already provisioned boards. Non-default rooms require the token for browsers too.

## Deploy

From `cloudflare/`, set the long random `PAIRING_SECRET` with Wrangler secrets when initially provisioning, then use:

```bash
npm run typecheck
npm run deploy
```

From the repository root, run `npm test` and `npm run build`, then publish the static app:

```bash
cd cloudflare
npx wrangler deploy -c studio.wrangler.jsonc
```

The configured custom domains are `easy.leige.online` for the gateway and `studio.leige.online` for the page. `ALLOWED_ORIGINS` must include the page origin. Ordinary deployment retains the Durable Object namespace and stored messages. No new storage product or paid TTS provider is required by this implementation.

## Behavior

- A fresh board status is required for online presence. A WSS connection or cached status alone is insufficient. The freshness window is 8 seconds; direct board Wi-Fi takes priority over a browser Bluetooth gateway.
- Browser identities persist in localStorage but no longer map to physical S1–S4/S8 slots.
- Voice is 8 kHz mono G.711 mu-law. Each message is at most 160,000 samples (20 seconds), transferred in acknowledged 768-byte pieces and committed atomically into the group history.
- The room retains at most 100 committed messages. New messages never evict unread messages. The board marks a message read only after complete speaker playback.
- Stored metadata and audio survive reconnects and Worker upgrades. Incomplete uploads expire after 10 minutes. The board recording buffer is volatile until upload succeeds.
- A protected `POST /admin/clear` endpoint requires the `CLEAR_TOKEN` secret. It permanently removes timeline metadata, audio chunks, and incomplete uploads for the default room; connected browsers receive the removal immediately.
- Text messages and the `/tts` endpoint are removed. Board prompt audio is generated at build time instead.
- The webpage directly opens/closes capture through the shared `realtime.set` toggle; `settings.realtime_enabled` is a capture command. Opening requires a fresh direct board Wi-Fi route. Start timeout (8 seconds), disconnect, or stale Wi-Fi presence clears the toggle and active state. Board realtime audio uses 20 ms PCM16 binary frames, is forwarded only to browsers while active, and is never persisted.
- Presence updates still send the unique online-browser count. S7/S8 now record local blood pressure/glucose values and do not control realtime capture or announce presence. Each saved measurement is queued in board NVS and uploaded through Wi-Fi or the selected Bluetooth gateway. The room persists distinct record IDs and deduplicates retries. Browsers export every synchronized measurement with paginated `health.list` requests; measurements are not pruned with voice history. The board retains up to 64 pending records and rejects new saves when full, preserving older records.

The older `agent/` LAN process is not required for either direct Wi-Fi or the browser Bluetooth gateway. Wi-Fi provisioning and firmware flashing remain on local USB/encrypted BLE. See `../docs/VOICE_CHAT.md` and `../docs/PROTOCOL.md` for usage and the wire contract.

Board ping acknowledgements include the actual `wifi` / `ble` transport for local network announcements. Board commit receipts (`delivered:<id>`) remain after audio/history eviction to avoid posting the same persisted recording twice after a lost acknowledgement. These small receipts contain no audio or Wi-Fi credentials. Firmware 0.2.1 also supports phone SoftAP provisioning and a durable eight-clip outbox; see [VOICE_CHAT.md](../docs/VOICE_CHAT.md).
