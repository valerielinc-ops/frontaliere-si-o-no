#!/usr/bin/env -S npx -y tsx
// check-article-byte-identity.mjs (#4837 stream A — Deliverable 4)
//
// Byte-identity gate for scripts/publish-article-fast.mjs: renders one
// article standalone (the fast path) and diffs it against the CURRENTLY
// LIVE production HTML for the same 4 locale URLs.
//
// Why "live" and not "a fresh full build": a fresh local full vite build
// OOMs / takes ~25-34 min (see AGENTS.md "Build And Test" — full local SEO
// builds are not to be run without explicit user request). Live-curl is the
// only apples-to-apples baseline reachable from a normal dev/agent session.
// This does mean a stale live deploy (main has moved since the last deploy)
// can show up as a diff that is NOT a fast-path bug — see NORMALIZED FIELDS
// below for the only transform applied before comparing, and treat any
// OTHER diff as a real fast-path defect to investigate, never something to
// paper over with broader normalization.
//
// NORMALIZED FIELDS (exhaustive — nothing else is touched before diffing):
//   NONE structural. Investigated build-plugins/ogPagesPlugin.ts directly:
//   the only wall-clock read in the render path (`new Date().toISOString()`
//   at ogPagesPlugin.ts's buildDateIso/todayIso) is used SOLELY as a
//   last-resort `datePublished`/`dateModified` fallback when an article has
//   NEITHER a declared `date` nor `updatedAt` — every real article in
//   data/blog-articles-data.ts / data/swiss-articles-data.ts declares both,
//   so todayIso is dead code for real content and contributes zero
//   variance. The SPA entry bundle filenames (resolveSpaBundle) and all
//   chunk names (stableChunkFile/stableChunkFiles) are pure, config-fixed
//   constants — never content-hashed, never disk-discovered — so asset URLs
//   are identical build-to-build for the same commit. Net effect: for a
//   well-formed article, the fast path's output and a full build's output
//   are expected to be byte-for-byte identical with NO normalization at all.
//   A trailing-newline-only diff (curl transport vs local fs.writeFileSync)
//   is the one transport artifact tolerated below — not a content
//   normalization, just whitespace at the very end of the byte stream.
//
// TWO PRECONDITIONS publish-article-fast.mjs SETS BEFORE RENDERING (not this
// gate's job to normalize — if either is ever reverted there, this WILL show
// a real, reproducible mismatch, not a live-staleness false positive):
//   1. process.env.ASSET_CDN must be set before ogPagesPlugin.ts/constants.ts
//      is first imported (module-top-level IIFE, read once). Unset -> the
//      CDN preconnect hint ogPagesPlugin normally emits before blogPreloads
//      never appears, so offload-generated-images-cdn.mjs's dedup (keyed on
//      an existing same-origin preconnect tag) fails to find it and injects
//      its own redundant preconnect+dns-prefetch pair at the top of <head>
//      instead — confirmed by tracing both code paths and reproducing the
//      exact <head> diff.
//   2. process.env.TZ must be pinned to 'UTC' before that same import.
//      ogPagesPlugin.ts's formatHumanDate/formatHumanDateTime parse a
//      normalizeDateTime()-produced "+01:00"-offset ISO string with
//      `new Date(...)` and then read the calendar day via LOCAL accessors
//      (getDate/getMonth/getFullYear), not getUTC*() — so the displayed
//      "Pubblicato il ..." day is one calendar day earlier on a CET/CEST
//      machine than on a UTC one for a midnight-CET date (confirmed
//      empirically: same source date rendered "15 gennaio" on a CEST
//      dev machine vs "14 gennaio" on this repo's UTC-TZ GitHub Actions
//      runners). This is a genuine pre-existing bug in the shared renderer
//      (present in the full build too, dormant only because CI runs in
//      UTC) — out of scope to fix in ogPagesPlugin.ts from this stream;
//      TZ=UTC only makes THIS script's output match production regardless
//      of the invoking machine's timezone.
//
// KNOWN EXPECTED DIVERGENCE SOURCES against a STALE live deploy (real,
// explained, NOT a fast-path defect — investigate anything else):
//   - Related-articles cross-link picks (buildRelatedArticlesHtml in
//     ogPagesPlugin.ts) are computed from `entries`, parsed from EVERY file
//     in SECTION.seoFiles (services/seo/seo-blog.ts + seo-blog-2..10.ts for
//     frontaliere, seo-blog-ch.ts for svizzera) — NOT from
//     data/blog-articles-data.ts (that registry only supplies
//     category/image/author lookups). If main has gained new articles in
//     ANY of those shard files since the live deploy, the candidate pool
//     differs and the last 1-2 picks can differ too. Verified by a
//     controlled replay: swapping BOTH data/blog-articles-data.ts AND the
//     specific seo-blog-N.ts shard(s) that changed (found via
//     `git diff --stat <last-deployed-sha> HEAD -- services/seo/seo-blog*.ts`
//     — do not assume shard 1 alone tells the whole story; a shard-1-only
//     diff check gave a false "nothing changed" reading here before the
//     real drift was traced to seo-blog-5.ts) back to the last-deployed
//     commit's exact content eliminated this diff entirely.
//   - A Cloudflare bot-fight/challenge-platform `<script>` tag
//     (`__CF$cv$params={...}`) appended right before `</body>` on every live
//     response. This is injected by Cloudflare's edge/proxy layer at serve
//     time — never present in origin-generated HTML — so it is expected to
//     appear ONLY on the live side and never on the fast-path side.
// CLI:
//   npx -y tsx scripts/check-article-byte-identity.mjs --id <articleId> --section <frontaliere|svizzera>
//
// Exit code 0 = byte-identical (mod. trailing-newline) for all 4 locales.
// Exit code 1 = at least one locale diverged — prints a unified-ish diff
// summary (first N differing line pairs) for investigation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') out.id = argv[++i];
    else if (a === '--section') out.section = argv[++i];
  }
  if (!out.id || !out.section) {
    console.error('[byte-identity] usage: --id <articleId> --section <frontaliere|svizzera>');
    process.exit(1);
  }
  return out;
}

function stripTrailingNewline(s) {
  return s.replace(/\r?\n$/, '');
}

function firstDiffLines(a, b, context = 3) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) {
      const start = Math.max(0, i - context);
      const end = Math.min(max, i + context + 1);
      const out = [];
      for (let j = start; j < end; j++) {
        out.push(`  line ${j + 1}:`);
        out.push(`    fast : ${la[j] === undefined ? '<EOF>' : la[j]}`);
        out.push(`    live : ${lb[j] === undefined ? '<EOF>' : lb[j]}`);
      }
      return out.join('\n');
    }
  }
  return '(no line-level diff found — byte-length or trailing-whitespace only)';
}

// Locates the first diverging character (not byte — see below) and returns
// ~contextChars of surrounding text from both sides. Complements
// firstDiffLines(): that one is per-LINE, which is unreadable when the first
// divergence sits inside one very long minified/attribute-heavy line;
// this one pinpoints the exact offset regardless of line length. Character
// offset, not a true UTF-8 byte offset: slicing a JS string by character
// index can never land mid-codepoint, so the printed context is always valid
// text — a byte offset would need re-deriving the char boundary anyway to be
// printable, at the cost of correctness for any non-ASCII content.
function firstDiffOffsetContext(a, b, contextChars = 200) {
  const max = Math.min(a.length, b.length);
  let offset = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) { offset = i; break; }
  }
  if (offset === -1) {
    if (a.length === b.length) return null; // identical
    offset = max; // one is a strict prefix of the other
  }
  const start = Math.max(0, offset - contextChars);
  return {
    offset,
    fast: a.slice(start, offset + contextChars),
    live: b.slice(start, offset + contextChars),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byte-identity-'));
  const summaryPath = path.join(scratchDir, 'summary.json');

  try {
    const scriptPath = path.join(ROOT_DIR, 'scripts', 'publish-article-fast.mjs');
    const result = spawnSync(
      'npx',
      ['-y', 'tsx', scriptPath, '--id', args.id, '--section', args.section, '--out', scratchDir, '--summary', summaryPath],
      { cwd: ROOT_DIR, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error('[byte-identity] publish-article-fast.mjs failed — cannot compare');
      process.exit(1);
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
    let anyMismatch = false;

    for (const shard of summary.shards) {
      const indexRel = shard.paths[0]; // directory-form index.html (the hydrated page; the flat sibling is a noindex redirect bridge, not diffed here)
      const localAbs = path.join(scratchDir, indexRel);
      if (!fs.existsSync(localAbs)) {
        console.error(`[byte-identity] ${shard.locale}: local file missing at ${indexRel} — FAIL`);
        anyMismatch = true;
        continue;
      }
      const localHtml = fs.readFileSync(localAbs, 'utf-8');

      // Shell out to curl rather than Node's fetch (undici): Cloudflare's
      // bot-fight/WAF returns a bare 403 to undici's default User-Agent but
      // allows curl's — confirmed empirically (same URL: curl -> 200, node
      // fetch -> 403 cloudflare). curl is available in every dev/agent shell
      // this script runs in.
      const curlResult = spawnSync('curl', ['-s', '-w', '\n%{http_code}', shard.url], { encoding: 'utf-8' });
      if (curlResult.status !== 0) {
        console.error(`[byte-identity] ${shard.locale}: curl ${shard.url} exited ${curlResult.status} — FAIL`);
        anyMismatch = true;
        continue;
      }
      const curlOut = curlResult.stdout;
      const lastNl = curlOut.lastIndexOf('\n');
      const httpCode = curlOut.slice(lastNl + 1).trim();
      let liveHtml = curlOut.slice(0, lastNl);
      if (httpCode !== '200') {
        console.error(`[byte-identity] ${shard.locale}: live fetch ${shard.url} -> HTTP ${httpCode} — FAIL`);
        anyMismatch = true;
        continue;
      }

      const a = stripTrailingNewline(localHtml);
      const b = stripTrailingNewline(liveHtml);
      if (a === b) {
        console.log(`[byte-identity] ${shard.locale}: OK — byte-identical (${a.length} bytes) — ${shard.url}`);
      } else {
        anyMismatch = true;
        console.error(`[byte-identity] ${shard.locale}: MISMATCH — fast=${a.length}B live=${b.length}B — ${shard.url}`);
        const offsetCtx = firstDiffOffsetContext(a, b);
        if (offsetCtx) {
          console.error(`  first diff at char offset ${offsetCtx.offset}`);
          console.error(`    fast : ...${offsetCtx.fast}...`);
          console.error(`    live : ...${offsetCtx.live}...`);
        }
        console.error(firstDiffLines(a, b));
      }
    }

    if (anyMismatch) {
      console.error('[byte-identity] FAIL — at least one locale diverged from live production output');
      process.exit(1);
    }
    console.log('[byte-identity] PASS — all locales byte-identical to live production output');
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[byte-identity] fatal error:', err);
  process.exit(1);
});
