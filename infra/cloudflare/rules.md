# Cloudflare zone rules — `frontaliereticino.ch` (zone `435c32ec15993fe826d2bb5eb62d3d43`)

Tracking doc for zone-level Cloudflare **Cache Rules** / **Response Header
Transform Rules** that are applied directly via the Cloudflare API (not
declared in a repo script, unlike `scripts/cf-locale-failover-setup.mjs`).
Added for issue #3216 item 3: two `cdn.frontaliereticino.ch/assets/early-boot.js`
rules existed live with no in-repo record. While auditing them, a third
rule in the same response-headers ruleset (`cdn-assets-revalidate`) was found
to have the same gap — included below for completeness so this doc reflects
the zone's actual state, not just the two rules named in the issue.

Query current state with (needs `CF_API_TOKEN`, e.g. via
`node scripts/load-rc-env.mjs`):

```bash
ZONE=435c32ec15993fe826d2bb5eb62d3d43
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/rulesets/<ruleset_id>" | jq
```

## Ruleset `d738dd4c3c32463ba40f1ac6bdd74d78` — phase `http_request_cache_settings`

Rule 1 (`locale-shard-failover-cache`) and rule 2 (`it-apex-html-cache`) are
managed by `scripts/cf-locale-failover-setup.mjs` — see that script for
purpose/rollback. Rule 3 is the subject of this doc:

### `early-boot-js-bypass-cache`

- **Rule id:** `856ceaeb0c354cdfba01c3e162762ab8`
- **Expression:** `(http.host eq "cdn.frontaliereticino.ch" and http.request.uri.path eq "/assets/early-boot.js")`
- **Action:** `set_cache_settings` → `cache: false` (bypass CF edge cache entirely)
- **Applied:** 2026-07-01 (PR #3208, alongside the version-skew self-heal
  script)
- **Purpose:** `early-boot.js` (`build-plugins/constants.ts` →
  `EARLY_BOOT_CONTENT`, emitted by `build-plugins/staticScriptsPlugin.ts`) is
  the pre-module bootstrap script that registers the cross-chunk
  version-skew self-heal listeners on every static SEO page. Its filename is
  **stable** (not content-hashed), so a normal CDN edge cache would keep
  serving a stale copy for up to a day after a deploy — during that window a
  browser could load an *old* self-heal script that lacks a fix for a
  *newly introduced* skew signature (this is literally how issue #3216 item 1
  happened: a fix landed in `resilientImport.ts` but the stale cached
  early-boot.js kept serving the pre-fix pattern list). Bypassing the edge
  cache for this one path means the origin (GitHub Pages) is hit on every
  request, shrinking the stale-self-heal-script window to ~0 at the CDN
  layer. Pairs with the `early-boot-js-no-cache` response-header rule below,
  which does the same for the *browser* cache.
- **Rollback:** delete rule `856ceaeb0c354cdfba01c3e162762ab8` from ruleset
  `d738dd4c3c32463ba40f1ac6bdd74d78` (leaves rules 1-2 untouched):
  ```bash
  curl -s -X DELETE \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/435c32ec15993fe826d2bb5eb62d3d43/rulesets/d738dd4c3c32463ba40f1ac6bdd74d78/rules/856ceaeb0c354cdfba01c3e162762ab8"
  ```
  Effect of rollback: `early-boot.js` falls back to the zone's default edge
  cache behavior — re-introduces the stale-self-heal-window this rule closes.
  Only roll back if the bypass itself is causing a problem (e.g. origin
  overload from every SEO-page load re-fetching early-boot.js); the origin is
  static GitHub Pages, so this is not expected to matter in practice.

## Ruleset `ea906d4f1c7d46f099ad16c15864896b` — phase `http_response_headers_transform`

### `cdn-assets-revalidate` (pre-existing, undocumented before this doc)

- **Rule id:** `593219bc66044a4ca3e571a2e522703a`
- **Expression:** `(http.host eq "cdn.frontaliereticino.ch" and starts_with(http.request.uri.path, "/assets/"))`
- **Action:** rewrite response header `Cache-Control: public, max-age=600, must-revalidate`
- **Applied:** 2026-06-25
- **Purpose:** overrides GitHub Pages' default `immutable` cache header on
  every `/assets/*` file. Vite chunk filenames in this repo are
  **stable-named, not content-hashed** (see `stable-asset-names.test.ts`), so
  `immutable` would tell browsers to reuse a cached chunk forever even after a
  deploy changes its contents — the root cause of the whole version-skew
  class of bugs this repo works around (issue #3097 and its followups,
  including #3216). `max-age=600, must-revalidate` caps the staleness window
  to 10 minutes and forces a conditional GET after that instead of trusting
  the cache indefinitely. Must match `public/_headers` (kept in sync by hand;
  no automated parity check exists yet).
- **Rollback:** delete rule `593219bc66044a4ca3e571a2e522703a` from ruleset
  `ea906d4f1c7d46f099ad16c15864896b`. Effect: `/assets/*` reverts to GitHub
  Pages' default (long/immutable) cache header — reopens the stale-chunk
  window this rule was added to close. Do not roll back without also
  reverting to content-hashed chunk filenames, or removing this rule
  reintroduces long-lived stale-chunk skew for every asset, not just
  `early-boot.js`.

### `early-boot-js-no-cache`

- **Rule id:** `4209141be16e401d93b90340fcd94966`
- **Expression:** `(http.host eq "cdn.frontaliereticino.ch" and http.request.uri.path eq "/assets/early-boot.js")`
- **Action:** rewrite response header `Cache-Control: no-cache, must-revalidate`
- **Applied:** 2026-07-01 (PR #3208, same change as the cache-bypass rule
  above)
- **Purpose:** `early-boot-js-bypass-cache` (above) only stops the *CDN edge*
  from caching a stale copy — it says nothing about the requesting
  **browser**. Without this rule, `early-boot.js` would still match the
  broader `cdn-assets-revalidate` rule above (`max-age=600, must-revalidate`)
  and a browser could serve its own disk-cached copy for up to 10 minutes.
  Because this rule's expression is more specific (exact path match vs the
  `/assets/` prefix match above) it takes precedence for this one file,
  forcing `no-cache` — the browser must always revalidate (conditional GET)
  before reusing a cached copy, never serve it outright. Combined with the
  edge bypass, this makes `early-boot.js` effectively "always fresh" end to
  end.
- **Rollback:** delete rule `4209141be16e401d93b90340fcd94966` from ruleset
  `ea906d4f1c7d46f099ad16c15864896b`:
  ```bash
  curl -s -X DELETE \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/435c32ec15993fe826d2bb5eb62d3d43/rulesets/ea906d4f1c7d46f099ad16c15864896b/rules/4209141be16e401d93b90340fcd94966"
  ```
  Effect of rollback: `early-boot.js` falls back to the `cdn-assets-revalidate`
  10-minute browser cache — reopens (a smaller version of) the same
  stale-self-heal-script window the edge-bypass rule closes.

## Why these three matter together

`early-boot-js-bypass-cache` (edge) + `early-boot-js-no-cache` (browser) +
the underlying stable-filename build (no content hash on `early-boot.js`)
combine to make the version-skew self-heal script itself immune to the exact
staleness bug class it exists to recover *other* assets from — self-heal
logic that could itself go stale would be a silent single point of failure
for every static SEO page. `cdn-assets-revalidate` is the general-purpose
version of the same idea for every other `/assets/*` file, at a coarser
10-minute grain (fine for regular chunks, not fine enough for the one script
that has to detect skew involving those chunks in the first place).
