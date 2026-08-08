/**
 * Regression guard for the /data/** CDN rewrite on SHARD dists.
 *
 * Sibling of offload-image-refs-shard-dist.test.ts (#3475), same defect class,
 * different phase: the rewrite's authority was per-shard while the served site
 * is the UNION of the ~27 section × 4 locale shards.
 *
 *     const dataRepl = (m, file) =>
 *       distDataRel.has('/data/' + file) ? `${cdnBase}/data/${file}` : m;
 *
 * `distDataRel` is "what is in THIS shard's dist/data". A shard emitting a page
 * that references a data file it does not itself carry got no rewrite and
 * shipped the bare same-origin path — which 404s, because after the offload the
 * apex serves no /data/** at all. Measured live 2026-08-08, same page family:
 *
 *   /meteo-frontalieri/     → fetch('https://cdn…/data/weather-snapshot.json')  ok
 *   /fr/meteo-frontaliers/  → fetch('/data/weather-snapshot.json')              404
 *
 * Contract locked here (runs the real script end-to-end on a throwaway dist):
 *   1. Shard-like dist with NO dist/data: same-origin /data/ refs still rewrite.
 *   2. Full-dist parity: present files still rewrite AND are guard-deleted.
 *   3. IDEMPOTENT: running the offload twice is a no-op the second time — no
 *      `${CDN}${CDN}` and no `${CDN}https://…`.
 *   4. Refs already on the CDN host are never touched.
 *   5. The XML-sitemap keep-guard still pins its file same-origin (untouched).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('../scripts/offload-generated-images-cdn.mjs', import.meta.url),
);
const CDN_BASE = 'https://valerielinc-ops.github.io/frontaliere-cdn';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function makeDist(): { tmp: string; distDir: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-data-'));
  tmpDirs.push(tmp);
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  return { tmp, distDir };
}

function runOffload(tmp: string): void {
  execFileSync('node', [SCRIPT], { cwd: tmp, env: { ...process.env, CDN_BASE }, stdio: 'pipe' });
}

function writeHtml(distDir: string, rel: string, html: string): string {
  const full = path.join(distDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html, 'utf8');
  return full;
}

// The two live shapes that were shipping broken, plus a control already on the CDN.
const PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title>' +
  // JSON-LD DataDownload — the EN/FR comparison hubs declared a 404 here.
  '<script type="application/ld+json">{"@type":"DataDownload",' +
  '"contentUrl":"https://frontaliereticino.ch/data/jobs-salary-aggregate.csv"}</script>' +
  '</head><body>' +
  // Inline hydration fetch — /fr/meteo-frontaliers/ shipped exactly this.
  `<script>fetch('/data/weather-snapshot.json')</script>` +
  '<a href="/data/border-wait-ranking.json" download>d</a>' +
  // Control: already offloaded, must survive byte-identical.
  '<a href="https://cdn.frontaliereticino.ch/data/already.json">c</a>' +
  '</body></html>';

describe('/data/** CDN rewrite on shard dists', () => {
  it('rewrites same-origin /data/ refs even when dist/data is ABSENT (the shard bug)', () => {
    const { tmp, distDir } = makeDist();
    // Shard reality: locale subtree, no dist/data at all.
    const htmlPath = writeHtml(distDir, 'fr/meteo-frontaliers/index.html', PAGE_HTML);

    runOffload(tmp);
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain(`fetch('${CDN_BASE}/data/weather-snapshot.json')`);
    expect(html).toContain(`"contentUrl":"${CDN_BASE}/data/jobs-salary-aggregate.csv"`);
    expect(html).toContain(`href="${CDN_BASE}/data/border-wait-ranking.json"`);
    // No same-origin /data/ ref survives.
    expect(html).not.toContain("fetch('/data/");
    expect(html).not.toContain('href="/data/');
    expect(html).not.toContain('https://frontaliereticino.ch/data/');
    // Control untouched.
    expect(html).toContain('href="https://cdn.frontaliereticino.ch/data/already.json"');
  });

  it('full-dist parity: present files still rewrite AND are guard-deleted', () => {
    const { tmp, distDir } = makeDist();
    const dataDir = path.join(distDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'weather-snapshot.json'), '{"generatedAt":"x"}', 'utf8');
    const htmlPath = writeHtml(distDir, 'index.html', PAGE_HTML);

    runOffload(tmp);

    expect(fs.readFileSync(htmlPath, 'utf8')).toContain(
      `fetch('${CDN_BASE}/data/weather-snapshot.json')`,
    );
    // Rewritten → no surviving same-origin ref → dropped from the artifact.
    expect(fs.existsSync(path.join(dataDir, 'weather-snapshot.json'))).toBe(false);
  });

  it('is IDEMPOTENT — a second offload changes nothing', () => {
    const { tmp, distDir } = makeDist();
    const htmlPath = writeHtml(distDir, 'fr/meteo-frontaliers/index.html', PAGE_HTML);

    runOffload(tmp);
    const afterFirst = fs.readFileSync(htmlPath, 'utf8');
    runOffload(tmp);
    const afterSecond = fs.readFileSync(htmlPath, 'utf8');

    expect(afterSecond).toBe(afterFirst);
    // The two failure shapes a naive `base + path` concatenation would produce.
    expect(afterSecond).not.toContain(`${CDN_BASE}${CDN_BASE}`);
    expect(afterSecond).not.toContain(`${CDN_BASE}https://`);
    // Exactly one CDN base per rewritten ref.
    expect(afterSecond.split(`${CDN_BASE}/data/`).length - 1).toBe(3);
  });

  it('keeps a file same-origin when only an XML sitemap references it', () => {
    // The keep-guard is the one path this change must NOT disturb: XML is
    // collected but never rewritten, so its target stays in the artifact.
    const { tmp, distDir } = makeDist();
    const dataDir = path.join(distDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'pinned.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dataDir, 'unpinned.json'), '{}', 'utf8');
    writeHtml(distDir, 'index.html', '<!doctype html><html><head><title>t</title></head><body>x</body></html>');
    fs.writeFileSync(
      path.join(distDir, 'sitemap-data.xml'),
      '<?xml version="1.0"?><urlset><url><loc>https://frontaliereticino.ch/data/pinned.json</loc></url></urlset>',
      'utf8',
    );

    runOffload(tmp);

    expect(fs.existsSync(path.join(dataDir, 'pinned.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'unpinned.json'))).toBe(false);
  });
});
