# Cloudflare R2 staging

Test bed for migrating hosting off GitHub Pages (which is hitting its 10GB
artifact limit on this site). Reuses the **exact `github-pages` artifact** built
by `.github/workflows/deploy.yml` — no rebuild, byte-identical to prod.

## Layout

```
cloudflare-staging/
├── wrangler.toml        # Worker config + R2 binding
├── src/worker.js        # Serves objects with noindex baked in
└── README.md            # this file
```

Companion workflow: `.github/workflows/deploy-r2-staging.yml`.

## Safety guarantees (staging only)

The Worker hard-wires three rules that must NOT be carried over to prod:

1. Every response carries `x-robots-tag: noindex, nofollow`
2. `/robots.txt` always returns `Disallow: /` (regardless of bucket contents)
3. `/sitemap*` returns 404

This prevents Google from indexing `astro.frontaliereticino.ch` and cannibalizing
the prod domain. **Remove these rules from the prod Worker.**

## One-time setup (manual)

### 1. Cloudflare account + zone

1. Sign up at cloudflare.com
2. Add site `frontaliereticino.ch`
3. CF auto-imports DNS records from Swizzonic — **disable proxy (grey cloud) on
   all records** so prod traffic continues to hit GitHub Pages unchanged
4. CF gives you 2 nameservers; **do not switch NS at Swizzonic yet** —
   prepare everything first

### 2. R2 bucket + API token

1. Dashboard → R2 → Create bucket `frontaliereticino-staging`,
   location `EEUR` (Europe East)
2. Bucket Settings → Object Versioning: **Enable** (rollback safety)
3. R2 → "Manage R2 API Tokens" → Create:
   - Permission: **Object Read & Write**
   - Specific bucket: `frontaliereticino-staging`
   - TTL: none
4. Save Access Key ID, Secret Access Key, S3 endpoint URL

### 3. GitHub Secrets

```bash
gh secret set R2_ACCESS_KEY          # from step 2.4
gh secret set R2_SECRET_KEY          # from step 2.4
gh secret set R2_ENDPOINT            # https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com
gh secret set CLOUDFLARE_API_TOKEN   # for wrangler deploys (Workers Scripts: Edit, R2: Edit)
```

### 4. Deploy the Worker

```bash
cd cloudflare-staging
npx wrangler deploy
```

This publishes `astro-staging.<your-subdomain>.workers.dev`. Smoke test:

```bash
# Upload one test file
npx wrangler r2 object put frontaliereticino-staging/index.html --file=<(echo '<h1>hello R2</h1>')

# Hit it
curl -I https://astro-staging.<your-subdomain>.workers.dev/
# Expect: 200 + x-robots-tag: noindex, nofollow
```

### 5. NS migration (only when ready)

Off-hours. Backup all current DNS records first (screenshot).

1. Swizzonic dashboard → DNS / Nameservers for `frontaliereticino.ch`
2. Change NS to those provided by Cloudflare
3. Propagation: usually <30min, can be up to 24h
4. Verify: `dig NS frontaliereticino.ch +short`
5. Prod stays UP throughout (A records unchanged, still point to GH Pages)

### 6. Bind subdomain to Worker

CF dashboard → Workers & Pages → `astro-staging` → Settings → Domains & Routes:

- "Add Custom Domain" → `astro.frontaliereticino.ch`
- CF auto-creates DNS + Let's Encrypt SSL (~1-2 min)

```bash
curl -I https://astro.frontaliereticino.ch/
# Expect: 200 + x-robots-tag: noindex, nofollow
```

## Triggering deploys

### Automatic

The workflow listens to `workflow_run` on **"Deploy to GitHub Pages"**. After
every successful Pages deploy, the R2 sync fires automatically with the same
artifact.

### Manual

```bash
# Use latest successful Pages run
gh workflow run deploy-r2-staging.yml

# Pick a specific historical Pages run
gh workflow run deploy-r2-staging.yml -f run_id=<PAGES_RUN_ID>
```

## Validation checklist

Once staging serves real content:

```bash
# Header sanity
for path in / /sitemap.xml /robots.txt /404.html; do
  echo "=== $path ==="
  curl -sI "https://astro.frontaliereticino.ch$path" | head -5
done

# Byte-diff a rich page vs prod
diff \
  <(curl -s https://frontaliereticino.ch/lavoro-frontalieri/ticino/) \
  <(curl -s https://astro.frontaliereticino.ch/lavoro-frontalieri/ticino/)
# Expect: identical (artifact is the same)
```

DOM hydration: open in a browser, DevTools console must be clean, router must
classify static vs SPA correctly (see `static_overlay_truth_is_router`
feedback).

## Rollback

| Issue | Action |
|---|---|
| Worker misbehaves | `npx wrangler delete astro-staging` |
| Subdomain wrong | Remove custom domain binding + DNS record `astro` on CF |
| NS migration regret | Restore original NS at Swizzonic (DNS backup from setup) |
| R2 costs spike | Bucket idle = $0; delete if needed |

## Cost expectations (free tier)

| Item | Free quota | Expected use |
|---|---|---|
| R2 storage | 10 GB | ~10 GB (at limit, may need monitoring) |
| Class A ops (PUT/LIST) | 1M/mo | Initial seed ~800k one-shot; incrementals <50k/deploy |
| Class B ops (GET) | 10M/mo | Only cache misses; CF edge absorbs ~95% |
| Egress | unlimited free | n/a |
| Workers requests | 100k/day | Same — cache absorbs most |

## Cutover to prod (later, separate work)

When staging passes validation:

1. Create bucket `frontaliereticino` (no `-staging` suffix)
2. Fork Worker → `frontaliereticino-prod`, **remove** the noindex / robots /
   sitemap blocks
3. Add a parallel sync job in the workflow (or a separate workflow)
4. Cutover DNS apex `frontaliereticino.ch` from GH Pages IPs → CF proxy
5. Keep GH Pages deploy running for 7-14 days as instant rollback
