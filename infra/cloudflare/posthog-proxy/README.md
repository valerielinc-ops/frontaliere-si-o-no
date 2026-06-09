# PostHog first-party proxy (Cloudflare Worker)

Reverse-proxies PostHog EU Cloud under `https://t.frontaliereticino.ch` so
analytics requests are same-origin and survive ad-blockers. The web client
points `api_host` at this domain in [`services/posthog.ts`](../../../services/posthog.ts).

- `/static/*` → `eu-assets.i.posthog.com` (posthog-js bundle)
- everything else → `eu.i.posthog.com` (ingestion, flags, …)

## Background

On 2026-06-09 `t.frontaliereticino.ch` resolved to NXDOMAIN (no DNS record), so
100% of PostHog events failed — the analytics blackout was a broken proxy, not
just a quota issue. This Worker + its custom domain restore it.

## Deploy

Automatic: any push to `main` touching `infra/cloudflare/posthog-proxy/**`
runs [`.github/workflows/deploy-posthog-proxy.yml`](../../../.github/workflows/deploy-posthog-proxy.yml).

Manual:

```bash
cd infra/cloudflare/posthog-proxy
npx wrangler deploy        # OAuth (wrangler login) or CLOUDFLARE_API_TOKEN
```

The first deploy creates the `t.frontaliereticino.ch` custom domain (proxied DNS
record + edge TLS cert) automatically; later deploys only update the script.

## CI secrets

- `CLOUDFLARE_API_TOKEN` — token with the *Edit Cloudflare Workers* permission set.
- `CLOUDFLARE_ACCOUNT_ID` — `a426452d1d2987ac744c6feff20dd8b3`.
