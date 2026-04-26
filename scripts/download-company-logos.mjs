#!/usr/bin/env node
/**
 * download-company-logos.mjs
 *
 * Mirrors every external logo URL in CRAWLED_COMPANY_LOGOS
 * (services/jobDataNormalization.ts) to public/images/brands/{slug}.{ext}
 * and writes a manifest at data/company-logos-manifest.json that maps
 * companyKey → public path. The runtime resolver consults the manifest
 * before falling back to the original URL — so the SPA and the static SEO
 * pages serve self-hosted logos instead of relying on Clearbit / Google
 * favicons (both unreliable, half the Clearbit URLs return 404).
 *
 * Also emits public/logos-audit.html — a noindex grid where you can visually
 * QA every saved logo and spot grey-globe favicons or wrong matches.
 *
 * Usage:
 *   node scripts/download-company-logos.mjs
 *
 * Idempotent. Re-running re-downloads everything (logos drift over time).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SOURCE_TS = path.join(ROOT, 'services', 'jobDataNormalization.ts');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'brands');
const MANIFEST = path.join(ROOT, 'data', 'company-logos-manifest.json');
const AUDIT_PAGE = path.join(ROOT, 'public', 'logos-audit.html');

const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

function detectExtFromBytes(buf) {
  if (!buf || buf.length < 8) return null;
  const sig = buf.subarray(0, 8);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return 'png';
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return 'jpg';
  if (sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46) return 'gif';
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46) return 'webp';
  if (sig[0] === 0x00 && sig[1] === 0x00 && sig[2] === 0x01 && sig[3] === 0x00) return 'ico';
  // SVG/XML
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

async function parseLogos() {
  const ts = await readFile(SOURCE_TS, 'utf8');
  const m = ts.match(/CRAWLED_COMPANY_LOGOS:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) throw new Error('Cannot find CRAWLED_COMPANY_LOGOS in jobDataNormalization.ts');
  const block = m[1];
  const entries = [];
  const lineRe = /['"]([a-z0-9-]+)['"]\s*:\s*([^,\n]+),?/g;
  let lm;
  while ((lm = lineRe.exec(block))) {
    const slug = lm[1];
    const raw = lm[2].trim().replace(/,$/, '').trim();
    let url = null;
    let domain = null;
    let kind = 'unknown';

    const cMatch = raw.match(/^cLogo\(['"]([^'"]+)['"]\)$/);
    const gMatch = raw.match(/^gFavicon\(['"]([^'"]+)['"]\)$/);
    const localMatch = raw.match(/^['"](\/[^'"]+)['"]$/);
    const httpMatch = raw.match(/^['"](https?:\/\/[^'"]+)['"]$/);

    if (cMatch) {
      domain = cMatch[1];
      url = `https://logo.clearbit.com/${domain}`;
      kind = 'clearbit';
    } else if (gMatch) {
      domain = gMatch[1];
      url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      kind = 'google-favicon';
    } else if (localMatch) {
      url = null;
      kind = 'local-existing';
      entries.push({ slug, kind, localExisting: localMatch[1] });
      continue;
    } else if (httpMatch) {
      url = httpMatch[1];
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = null;
      }
      kind = 'direct-url';
    } else {
      continue;
    }
    entries.push({ slug, kind, url, domain });
  }
  return entries;
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereTicinoLogoFetch/1.0; +https://frontaliereticino.ch)',
        Accept: 'image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function tryFetchAndSave(entry, url, sourceLabel) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty body');
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[ct] || detectExtFromBytes(buf) || 'png';
  // Google's generic "grey globe" favicon is exactly 726B at sz=128.
  const greyGlobe = sourceLabel === 'google-favicon' && buf.length === 726;
  const dest = path.join(OUT_DIR, `${entry.slug}.${ext}`);
  await writeFile(dest, buf);
  return {
    ...entry,
    status: greyGlobe ? 'grey-globe' : 'downloaded',
    path: `/images/brands/${entry.slug}.${ext}`,
    size: buf.length,
    contentType: ct,
    ext,
    finalSource: url,
    finalKind: sourceLabel,
  };
}

async function downloadOne(entry) {
  if (entry.kind === 'local-existing') {
    return { ...entry, status: 'local-existing', path: entry.localExisting };
  }
  if (!entry.url) {
    return { ...entry, status: 'no-url' };
  }
  try {
    return await tryFetchAndSave(entry, entry.url, entry.kind);
  } catch (primaryErr) {
    // Fallback: if the primary URL is Clearbit (which blocks server-side
    // fetches with no User-Agent allowlist) or any other host that 4xx'd,
    // retry with Google's favicon API on the same domain. Better a real
    // favicon than a broken image.
    if (entry.domain) {
      const fallbackUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(entry.domain)}&sz=128`;
      try {
        const r = await tryFetchAndSave(entry, fallbackUrl, 'google-favicon');
        return { ...r, fellBackFrom: entry.kind, primaryError: String(primaryErr?.message || primaryErr) };
      } catch (fallbackErr) {
        return {
          ...entry,
          status: 'failed',
          error: `primary: ${primaryErr?.message || primaryErr} | fallback: ${fallbackErr?.message || fallbackErr}`,
        };
      }
    }
    return {
      ...entry,
      status: 'failed',
      error: primaryErr?.name === 'AbortError' ? 'timeout' : String(primaryErr?.message || primaryErr),
    };
  }
}

async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function renderAudit(results, counts) {
  const items = results
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => {
      const cls = r.status === 'downloaded' || r.status === 'local-existing' ? 'ok' : r.status;
      const src = r.path || '';
      const sourceLink = r.url
        ? `<a href="${r.url}" target="_blank" rel="noopener">source</a>`
        : '';
      const sizeBit = typeof r.size === 'number' ? ` · ${r.size}B` : '';
      const ctBit = r.contentType ? ` · ${r.contentType}` : '';
      const errBit = r.error ? ` <span class="err">${r.error}</span>` : '';
      return `<li class="${cls}" data-slug="${r.slug}">
      <div class="logo">${
        src
          ? `<img src="${src}" alt="${r.slug}" loading="lazy">`
          : '<span class="ph">—</span>'
      }</div>
      <div class="meta">
        <strong>${r.slug}</strong>
        <div class="row"><span class="status status-${cls}">${r.status}</span>${sizeBit}${ctBit}${errBit}</div>
        <div class="row">${r.kind || ''}${r.domain ? ` · ${r.domain}` : ''}</div>
        <div class="row">${sourceLink}</div>
      </div>
    </li>`;
    })
    .join('');

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Audit logo aziende — Frontaliere Ticino</title>
  <meta name="robots" content="noindex,nofollow">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; padding: 2rem; max-width: 1280px; margin: 0 auto; background: #fafafa; color: #111; }
    @media (prefers-color-scheme: dark) { body { background: #0b1220; color: #e7eaf0; } li { background: #111827 !important; border-color: #1f2937 !important; } .logo { background: #0b1220 !important; } }
    h1 { margin: 0 0 .25rem; }
    .summary { color: #555; margin-bottom: 2rem; font-size: 14px; }
    .legend { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; font-size: 13px; }
    .legend span { padding: 2px 8px; border-radius: 6px; background: #eef2ff; }
    .filters { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .filters button { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; }
    .filters button.active { background: #111827; color: #fff; border-color: #111827; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    li { display: flex; gap: 1rem; align-items: flex-start; padding: 1rem; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
    li.failed { border-color: #fca5a5; background: #fef2f2; }
    li.grey-globe { border-color: #fcd34d; background: #fffbeb; }
    li.no-url { border-color: #d1d5db; background: #f9fafb; opacity: .7; }
    .logo { width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; background: #f3f4f6; border-radius: 8px; flex-shrink: 0; overflow: hidden; border: 1px solid #e5e7eb; }
    .logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .ph { font-size: 11px; color: #9ca3af; }
    .meta { flex: 1; min-width: 0; font-size: 12px; line-height: 1.45; word-break: break-word; }
    .meta strong { font-size: 14px; display: block; margin-bottom: 4px; }
    .row { margin-top: 2px; color: #6b7280; }
    .status { display: inline-block; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
    .status-ok { background: #dcfce7; color: #166534; }
    .status-downloaded { background: #dcfce7; color: #166534; }
    .status-local-existing { background: #dbeafe; color: #1e40af; }
    .status-failed { background: #fee2e2; color: #991b1b; }
    .status-grey-globe { background: #fef3c7; color: #92400e; }
    .status-no-url { background: #e5e7eb; color: #374151; }
    .err { color: #991b1b; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Audit logo aziende</h1>
  <p class="summary">Generato ${new Date().toISOString()} — totale: ${counts.total} · scaricati: ${counts.downloaded} · locali esistenti: ${counts.localExisting} · grey-globe: ${counts.greyGlobe} · falliti: ${counts.failed}</p>
  <div class="legend">
    <span class="status-downloaded">downloaded</span>
    <span class="status-local-existing">local-existing</span>
    <span class="status-grey-globe">grey-globe (Google favicon generic)</span>
    <span class="status-failed">failed</span>
  </div>
  <div class="filters">
    <button data-filter="all" class="active">tutti (${counts.total})</button>
    <button data-filter="downloaded">downloaded (${counts.downloaded})</button>
    <button data-filter="local-existing">local (${counts.localExisting})</button>
    <button data-filter="grey-globe">grey-globe (${counts.greyGlobe})</button>
    <button data-filter="failed">falliti (${counts.failed})</button>
  </div>
  <ul id="grid">${items}</ul>
  <script>
    document.querySelectorAll('.filters button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        const f = b.dataset.filter;
        document.querySelectorAll('#grid li').forEach((li) => {
          li.style.display = f === 'all' || li.classList.contains(f) ? '' : 'none';
        });
      });
    });
  </script>
</body>
</html>`;
}

function parseArgs(argv) {
  const args = { slug: null, domain: null, skipAudit: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug' && argv[i + 1]) args.slug = argv[++i];
    else if (argv[i] === '--domain' && argv[i + 1]) args.domain = argv[++i];
    else if (argv[i] === '--skip-audit') args.skipAudit = true;
  }
  return args;
}

async function readManifestFromDisk() {
  try {
    const raw = await readFile(MANIFEST, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(OUT_DIR, { recursive: true });
  let entries = await parseLogos();
  console.log(`[download-company-logos] Parsed ${entries.length} entries from CRAWLED_COMPANY_LOGOS`);

  if (opts.slug) {
    const filtered = entries.filter((e) => e.slug === opts.slug);
    if (filtered.length === 0) {
      // Slug not in registry yet — synthesise an entry so callers (e.g. the
      // crawler scaffold) can mirror a logo before manually editing
      // CRAWLED_COMPANY_LOGOS. Domain defaults to `{slug}.ch` — override
      // with --domain.
      const domain = opts.domain || `${opts.slug.replace(/-/g, '')}.ch`;
      console.log(
        `[download-company-logos] --slug ${opts.slug} not in registry — synthesising clearbit entry for ${domain}`,
      );
      entries = [
        {
          slug: opts.slug,
          kind: 'clearbit',
          url: `https://logo.clearbit.com/${domain}`,
          domain,
        },
      ];
    } else {
      entries = filtered;
      console.log(`[download-company-logos] Filtered to --slug ${opts.slug} (${entries.length} entry)`);
    }
  }

  const results = await runConcurrent(entries, downloadOne, CONCURRENCY);

  const counts = {
    total: results.length,
    downloaded: results.filter((r) => r.status === 'downloaded').length,
    localExisting: results.filter((r) => r.status === 'local-existing').length,
    greyGlobe: results.filter((r) => r.status === 'grey-globe').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };

  // Manifest write — single-slug runs MERGE into the existing manifest so
  // they don't wipe other entries. Full runs replace the manifest entirely
  // so removed registry slugs don't linger.
  const baseManifest = opts.slug ? await readManifestFromDisk() : {};
  const merged = { ...baseManifest };
  for (const r of results) {
    if (r.path) merged[r.slug] = r.path;
  }
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');

  // Audit page only regenerated on full runs (single-slug runs would emit a
  // misleading 1-entry page). Skip explicitly via --skip-audit if desired.
  if (!opts.slug && !opts.skipAudit) {
    await writeFile(AUDIT_PAGE, renderAudit(results, counts));
    console.log(`[download-company-logos] Audit page: ${AUDIT_PAGE}`);
  }

  console.log(
    `[download-company-logos] Done. downloaded=${counts.downloaded} local-existing=${counts.localExisting} grey-globe=${counts.greyGlobe} failed=${counts.failed}`,
  );
  console.log(`[download-company-logos] Manifest: ${MANIFEST}`);
  if (counts.failed > 0) {
    console.log('\nFailed entries:');
    for (const r of results.filter((x) => x.status === 'failed')) {
      console.log(`  ✗ ${r.slug} (${r.kind}) — ${r.error}`);
    }
  }
}

main().catch((err) => {
  console.error('[download-company-logos] Fatal:', err);
  process.exit(1);
});
