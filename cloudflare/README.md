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
- The room retains at most 5000 committed messages. At capacity it removes the oldest eligible message (a board recording or an already-read message); unread browser messages are protected. If all 5000 are unread browser messages, new uploads are rejected. The board marks a message read only after complete speaker playback.
- Stored metadata and audio survive reconnects and Worker upgrades. Legacy metadata is atomically migrated from `messages` into one `voice-message:<id>` record per message; legacy audio chunks stay readable. New committed audio is stored as a single binary `clip:<id>` (up to 160,000 bytes), avoiding permanent Base64/chunk overhead. The upload state, binary clip, metadata, and board receipt are committed atomically. Metadata revisions persist across object restarts. Incomplete uploads expire after 10 minutes. Board recordings persist in the eight-slot Flash outbox before upload; only an unsuccessful Flash write leaves a volatile buffer.
- A protected `POST /admin/clear` endpoint requires the `CLEAR_TOKEN` secret. It permanently removes timeline metadata, audio chunks, and incomplete uploads for the default room; connected browsers receive the removal immediately.
- Text messages and the `/tts` endpoint are removed. Board prompt audio is generated at build time instead.
- The webpage directly opens/closes capture through the shared `realtime.set` toggle; `settings.realtime_enabled` is a capture command. Opening requires a fresh direct board Wi-Fi route. Start timeout (8 seconds), disconnect, or stale Wi-Fi presence clears the toggle and active state. Board realtime audio uses 20 ms PCM16 binary frames, is forwarded only to browsers while active, and is never persisted.
- Presence updates still send the unique online-browser count. S7/S8 now record local blood pressure/glucose values and do not control realtime capture or announce presence. Each saved measurement is queued in board NVS and uploaded through Wi-Fi or the selected Bluetooth gateway. The room persists distinct record IDs and deduplicates retries. Browsers export every synchronized measurement with paginated `health.list` requests; measurements are not pruned with voice history. The board retains up to 64 pending records and rejects new saves when full, preserving older records.

The older `agent/` LAN process is not required for either direct Wi-Fi or the browser Bluetooth gateway. Wi-Fi provisioning and firmware flashing remain on local USB/encrypted BLE. See `../docs/VOICE_CHAT.md` and `../docs/PROTOCOL.md` for usage and the wire contract.

Board ping acknowledgements include the actual `wifi` / `ble` transport for local network announcements. Board commit receipts (`delivered:<id>`) remain after audio/history eviction to avoid posting the same persisted recording twice after a lost acknowledgement. These small receipts contain no audio or Wi-Fi credentials. Firmware 0.2.1 also supports phone SoftAP provisioning and a durable eight-clip outbox; see [VOICE_CHAT.md](../docs/VOICE_CHAT.md).

## 5000-message history

Released with Studio 0.4.3 and board firmware 0.4.13. Deploy the gateway before the webpage and firmware so existing messages can be migrated while older clients remain compatible.

Browser snapshots include only the newest 50 messages plus room `total`, `unread`, and an older-history cursor `next`. `list` pages use a `(created, id)` cursor and a fixed `through` bound for full exports; new arrivals cannot move that bound. The webpage offers older-page loading, chronological full-history playback, and ZIP downloads of at most 100 WAV files per package. Each next package is explicitly downloaded from the page; no unbounded audio cache or automatic fifty-file download burst is used.

Board `index` requests with `count:8` return bounded batches (under the existing 2048-byte command ceiling). A persisted revision lets unchanged synchronization finish in one request and requires a restart if the index changes between pages. The legacy single-item request remains supported for older firmware. The new firmware allocates its 5000-entry metadata index in PSRAM, about 440 KB; the offline outbox remains eight recordings.

5000 full-length clips contain 800,000,000 raw audio bytes (about 763 MiB), before SQLite, metadata and receipts. The maximum count is an application retention policy, not a guarantee of remaining account storage or request quota. Verify the deployed Cloudflare plan and actual database usage before filling it. The SQLite Durable Object limit is 1 GB on Workers Free or 10 GB on Workers Paid; free accounts also have a 5 GB account total. Full-length audio exports total about 1.6 GB in PCM WAV form, split across packages. Ordinary deploys must keep the same namespace and binding to preserve data.
