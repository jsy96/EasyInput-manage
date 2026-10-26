# EasyInput Cloudflare gateway

This Worker provides an authenticated WSS relay. The board firmware and browsers join the same device room; the Durable Object forwards board protocol lines between the two roles.

Set `ALLOWED_ORIGINS` and a long random `PAIRING_SECRET` with Wrangler secrets, then run `npm install`, `npm run typecheck`, and `npm run deploy` from this directory. The browser uses `wss://<worker-domain>/ws?device=<id>&role=browser&token=<pairing-token>` and the board firmware uses the same path with `role=board`.

The board connects with `role=board`; the browser connects with `role=browser`. The relay is not a data store and does not expose the board directly to the internet. Keep the pairing token private and rotate it if a device is retired.

## Deploy the Studio page

Build the PWA from the repository root, then deploy the generated static assets:

```bash
npm run build
cd cloudflare
npx wrangler deploy -c studio.wrangler.jsonc
```

The static Worker publishes `../dist` with SPA fallback and binds the custom domain configured in `studio.wrangler.jsonc`. Add the deployed HTTPS origin to the gateway's `ALLOWED_ORIGINS` before connecting from a browser.
