# PostHog proxy — MIGRATED to PostHog managed reverse proxy (no Worker)

**This directory is a tombstone.** The Cloudflare Worker that used to proxy
`t.frontaliereticino.ch` → PostHog EU Cloud was **removed on 2026-06-10** and
replaced by PostHog's own **managed reverse proxy** — a plain DNS CNAME, no
Worker, no code.

## Why

The Worker counted every analytics request against the Cloudflare **free-plan
Workers cap (100k requests/day)**. On 2026-06-09 the shared account hit 102k/100k
(locale-router + this proxy together). PostHog's managed reverse proxy is **free
for all PostHog Cloud users** and runs on PostHog's own infrastructure, so the
analytics traffic no longer touches our Cloudflare Workers at all.

This is also how it worked **before** the June NS move to Cloudflare: `api_host`
was switched to `t.frontaliereticino.ch` on 2026-04-12 as a managed-proxy CNAME.
When the zone moved to Cloudflare the CNAME was lost (→ NXDOMAIN, the 2026-06-09
analytics blackout) and a Worker was built as a stopgap instead of just
re-creating the CNAME. The Worker was never actually necessary.

## Current setup (no Worker)

- **Cloudflare DNS:** `CNAME t → e2adb634446919dbda51.cf-prod-eu-proxy.europehog.com`,
  **gray-cloud (DNS-only / Proxy status: DNS only)**. PostHog provisions the TLS
  cert automatically and routes `/static/*` → assets, everything else → ingestion.
  - Must stay **gray-cloud** — PostHog's managed proxy must NOT be proxied by our
    Cloudflare (per PostHog docs).
- **Client:** `services/posthog.ts` keeps `api_host: 'https://t.frontaliereticino.ch'`
  unchanged.
- **PostHog dashboard:** managed reverse proxy configured for `t.frontaliereticino.ch`.

## If analytics breaks (t = NXDOMAIN / 5xx)

Re-create the gray-cloud CNAME above (target is shown in PostHog → Settings →
managed reverse proxy). Do **not** rebuild a Worker — that re-introduces the cap
cost and would conflict with the CNAME by re-claiming the `t` custom domain.
