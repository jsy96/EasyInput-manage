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

Released on 2026-10-29: Studio 0.4.7 and the companion gateway are deployed together. The public HTML, application script, stylesheet and Service Worker match the local build. All 127 automated tests, type checks, the webpage build and ESP-IDF 5.5.5 firmware build passed. Firmware 0.4.18 is flashed to the target ESP32-S3 with NVS and the recording outbox preserved; serial output confirms the application version and normal startup without a panic signature in the startup log. The gateway health/session checks return HTTP 200 with the expected CORS headers. S7 continuous recognition, browser text display and audible success/failure still require user hardware testing.

Deployment version IDs: gateway `79e77ee8-cbe9-431f-a7d5-285e9037aabc`; Studio `df8b0099-f77b-4a84-b58b-ca05a399412a`. The exported package is `release/firmware/0.4.18-v2-monitor/`; older firmware packages are retained.

The subsequent firmware 0.4.19 S7 retry fix was built, exported and flashed on 2026-10-29. Studio remains at 0.4.7; neither the webpage nor gateway was redeployed, and the deployment version IDs above remain unchanged. This round's actual checks passed: 14 test files with 127 tests, type checking, the webpage build and the final ESP-IDF 5.5.5 firmware build. The 2,857,152-byte application leaves approximately 31% application-partition headroom; the package is exported to `release/firmware/0.4.19-v2-monitor/`. The target identity matched and flashing exited successfully with all three image hashes verified. Only the bootloader, partition table and application were written, preserving NVS and the recording outbox. Post-flash verification confirmed application mode; serial output explicitly shows version 0.4.19 and normal firmware startup without panic, Guru Meditation, abort, stack-canary/overflow or brownout signatures. Startup confirmation does not validate the S7 voice path. The user's initial recognition-failure trigger has not been reproduced on hardware; S7 end-to-end text display and audible results still require user operation and testing.

Earlier on the same date, Studio 0.4.6 and firmware 0.4.17 fixed insufficient codec stack space and audio mutex contention that stalled S6 Xiaozhi uploads. That earlier firmware was flashed and verified over serial; hardware logs and user listening confirmed two dialogue turns, resumed listening and completed S6 shutdown. These earlier S6 results do not validate the new S7 path. Initial account binding, network loss, and cancellation during connection or reply playback still need separate testing.

- A fresh board status is required for online presence. A WSS connection or cached status alone is insufficient. The freshness window is 8 seconds; direct board Wi-Fi takes priority over a browser Bluetooth gateway.
- Browser identities persist in localStorage but no longer map to physical S1–S4/S8 slots.
- Voice is 8 kHz mono G.711 mu-law. Each message is at most 160,000 samples (20 seconds), transferred in acknowledged 768-byte pieces and committed atomically into the group history.
- The room retains at most 5000 committed messages. At capacity it removes the oldest eligible message (a board recording or an already-read message); unread browser messages are protected. If all 5000 are unread browser messages, new uploads are rejected. The board marks a message read only after complete speaker playback.
- Stored metadata and audio survive reconnects and Worker upgrades. Legacy metadata is atomically migrated from `messages` into one `voice-message:<id>` record per message; legacy audio chunks stay readable. New committed audio is stored as a single binary `clip:<id>` (up to 160,000 bytes), avoiding permanent Base64/chunk overhead. The upload state, binary clip, metadata, and board receipt are committed atomically. Metadata revisions persist across object restarts. Incomplete uploads expire after 10 minutes. Board recordings persist in the eight-slot Flash outbox before upload; only an unsuccessful Flash write leaves a volatile buffer.
- A protected `POST /admin/clear` endpoint requires the `CLEAR_TOKEN` secret. It permanently removes timeline metadata, audio chunks, and incomplete uploads for the default room; connected browsers receive the removal immediately.
- Manual browser text input and the `/tts` endpoint are removed. S7 continuously sends speech to Xiaozhi and adds recognized user text to the shared timeline, potentially as several messages; it does not play Xiaozhi TTS. Existing text and pending deliveries are retained. S6 dialogue does not add text or audio to this timeline. Board prompt audio is generated at build time.
- The webpage directly opens/closes capture through the shared `realtime.set` toggle; `settings.realtime_enabled` is a capture command. Opening requires a fresh direct board Wi-Fi route. Start timeout (8 seconds), disconnect, or stale Wi-Fi presence clears the toggle and active state. Board realtime audio uses 20 ms PCM16 binary frames, is forwarded only to browsers while active, and is never persisted.
- Presence updates still send the unique online-browser count. S5 retains record/send/cancel without a double-click action; S6 retains successive short-press dialogue start/stop. S7 starts continuous transcription and the next short press stops capture, drains final audio and waits for recognized text and browser display receipts. S8 is disabled, and the old S7/S8 measurement editor, knob editor and double-click queries are removed. These keys do not control the webpage realtime capture toggle or announce presence.
- Existing board measurement and ledger data, pending uploads and browser CSV exports remain available. The independent NVS queues retain up to 64 pending measurements and 64 pending ledger entries from earlier firmware, synchronized through Wi-Fi or the selected Bluetooth gateway. The room persists stable IDs and deduplicates retries; browsers export all synchronized records through paginated `health.list` / `ledger.list`, independent of voice-history pruning. Presence and snapshots expose `ledgerPending` alongside `healthPending`, or null when the board is offline. Record synchronization resumes after a Xiaozhi session ends.

The older `agent/` LAN process is not required for either direct Wi-Fi or the browser Bluetooth gateway. Wi-Fi provisioning and firmware flashing remain on local USB/encrypted BLE. See `../docs/VOICE_CHAT.md` and `../docs/PROTOCOL.md` for usage and the wire contract.

Board ping acknowledgements include the actual `wifi` / `ble` transport for local network announcements. Board commit receipts (`delivered:<id>`) remain after audio/history eviction to avoid posting the same persisted recording twice after a lost acknowledgement. These small receipts contain no audio or Wi-Fi credentials. Firmware 0.2.1 also supports phone SoftAP provisioning and a durable eight-clip outbox; see [VOICE_CHAT.md](../docs/VOICE_CHAT.md).

## 5000-message history

Released with Studio 0.4.3 and board firmware 0.4.13. Deploy the gateway before the webpage and firmware so existing messages can be migrated while older clients remain compatible.

Browser snapshots include only the newest 50 messages plus room `total`, `unread`, and an older-history cursor `next`. `list` pages use a `(created, id)` cursor and a fixed `through` bound for full exports; new arrivals cannot move that bound. The webpage offers older-page loading, chronological full-history playback, and ZIP downloads of at most 100 WAV files per package. Each next package is explicitly downloaded from the page; no unbounded audio cache or automatic fifty-file download burst is used.

Board `index` requests with `count:8` return bounded batches (under the existing 2048-byte command ceiling). A persisted revision lets unchanged synchronization finish in one request and requires a restart if the index changes between pages. The legacy single-item request remains supported for older firmware. The new firmware allocates its 5000-entry metadata index in PSRAM, about 440 KB; the offline outbox remains eight recordings.

5000 full-length clips contain 800,000,000 raw audio bytes (about 763 MiB), before SQLite, metadata and receipts. The maximum count is an application retention policy, not a guarantee of remaining account storage or request quota. Verify the deployed Cloudflare plan and actual database usage before filling it. The SQLite Durable Object limit is 1 GB on Workers Free or 10 GB on Workers Paid; free accounts also have a 5 GB account total. Full-length audio exports total about 1.6 GB in PCM WAV form, split across packages. Ordinary deploys must keep the same namespace and binding to preserve data.


S7 uses `text.put` with `require_display:true`; `text.ack` confirms cloud persistence and includes `displayed:boolean`. Only the board or its selected Bluetooth gateway may publish text. A browser sends `text.displayed` with the message ID only after its mounted chat component commits the text to the DOM; the gateway persists that receipt, acknowledges the browser request and forwards a separate `text.displayed` notification without `req` to the board. A repeated retained `text.put` without a display receipt rebroadcasts the message with `added:false,display_required:true`, preserving message counts and allowing a browser that missed the initial delivery to display it. Legacy submissions without `require_display` keep their cloud-acknowledgement behavior. Mixed timeline pages preserve the 5000-message limit, while board voice indices and ZIP/playback skip text. Stable receipts deduplicate retries.

After S7 stops capture, recognition may drain for up to 20 seconds; once recognition terminates, a separate 12-second deadline bounds remaining display receipts. Success requires at least one result and a display receipt for every result in the session from at least one mounted webpage chat component. Cloud storage alone is insufficient; empty results, processing errors, partial display or an expired deadline produce failure. Unconfirmed text stays in the FIFO and retries after failure without a delayed success cue; it no longer blocks a new S7 session unless the queue is completely full. Only the persisted `stt/pending` head has a cross-reboot guarantee; additional queued text remains in RAM.

Firmware establishes the session boundary atomically when the engine accepts a new start. Older ACKs retire prior FIFO entries without adding to the new session's `acked_texts`. Success uses only the new session's `received_texts`, `acked_texts` and `session_queued_texts`; status `queued_texts` continues to report all pending text across sessions. `session_queued_texts` counts actual remaining FIFO entries for this session, so explicit cancellation can clear it without fabricating ACKs. Diagnostics distinguish `delivery.no_text`, `delivery.offline`, `delivery.display_timeout`, `delivery.engine_failed` and `delivered`, preserving the first existing engine error. Canceling the start prompt or rejecting an engine start skips final delivery-diagnosis writeback while retaining engine-start errors. Manual regression must cover retry after a failed round, old and new deliveries mixed together, duplicate old ACKs after a new message becomes inflight, and an empty new recognition while old messages are acknowledged. No new gateway operation or redeployment is required for this counting fix.

The retained `ledger.summary` protocol describes Beijing-calendar today/yesterday/day-before totals plus latest amount and a count of unknown dates; S6 no longer opens it. Existing ledger history is backfilled on first request and subsequent deduplicated writes update totals transactionally. S6 Xiaozhi dialogue connects directly through board Wi-Fi, pauses microphone capture during response playback, and resumes listening after playback finishes. S7 recognition also uses direct board Wi-Fi, independently of this gateway; the gateway does not host ASR or TTS or persist dialogue audio.
