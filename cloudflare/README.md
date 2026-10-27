# EasyInput shared gateway

The Worker and SQLite Durable Object provide authenticated board WSS, shared presence, persistent voice messages, stable browser identities, and the Edge read-aloud adapter. The static Studio PWA is deployed separately with `studio.wrangler.jsonc`.

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
- Browser identities persist in localStorage. The first four registrations get slots 0–3 (S1–S4); every later identity gets slot 4 (S8 / fifth light). A later registration does not take an offline client's slot.
- Voice is 8 kHz mono G.711 mu-law. Each message is at most 480,000 samples (60 seconds), transferred in acknowledged 768-byte pieces and committed atomically into the group history.
- The room retains at most 100 committed messages. New messages never evict unread computer messages. Read/clear commands come from the selected board transport; clearing only removes audio already marked read by full board playback.
- Stored metadata and audio survive reconnects and Worker upgrades. Incomplete uploads expire after 10 minutes. The board recording buffer is volatile until upload succeeds.
- `/tts` converts at most 300 characters through Edge read-aloud, with Yunjian at -10%, and returns MP3 for the browser to decode to the board's common format. It uses the same client behavior as the installed edge-tts-chinese skill. See `../docs/EDGE_TTS_LICENSE.txt` for attribution and license.

The older `agent/` LAN process is not required for either direct Wi-Fi or the browser Bluetooth gateway. Light/power diagnostics and Wi-Fi provisioning remain on local USB/encrypted BLE. See `../docs/VOICE_CHAT.md` and `../docs/PROTOCOL.md` for usage and the wire contract.

Board ping acknowledgements include the actual `wifi` / `ble` transport for local network announcements. Board commit receipts (`delivered:<id>`) remain after audio/history eviction to avoid posting the same persisted recording twice after a lost acknowledgement. These small receipts contain no audio or Wi-Fi credentials. Firmware 0.2.1 also supports phone SoftAP provisioning and a durable eight-clip outbox; see [VOICE_CHAT.md](../docs/VOICE_CHAT.md).
