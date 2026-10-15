/**
 * Regression guard for #3475 — og/image CDN rewrites on SHARD dists.
 *
 * scripts/offload-generated-images-cdn.mjs used to compile its og/image
 * rewrite regexes only for TARGETS whose dir exists under dist/
 * (fs.existsSync gate). On the en/de/fr shard runners and the Ticino staged
 * copies the dist is pruned to a single locale subtree with NO dist/og or
 * dist/images/* — so the rewrite list compiled empty and og:image +
 * brand-logo refs silently stayed on the main domain, paying a Cloudflare
 * 301 hop to cdn.frontaliereticino.ch on every fetch, while the ungated
 * /assets/ + /data/ rewrites on the SAME pages did apply.
 *
 * Contract locked here (runs the real script end-to-end on a throwaway dist):
 *   1. Shard-like dist (no og/images dirs): og:image + /images/brands/ refs
 *      (quoted AND unquoted attr forms) are rewritten to CDN_BASE; refs
 *      already on another host stay untouched.
 *   2. Full-dist behavior unchanged: present target dirs are still rewritten
 *      AND guard-deleted exactly as before.
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-shard-'));
  tmpDirs.push(tmp);
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  return { tmp, distDir };
}

function runOffload(tmp: string): void {
  // Real script, cwd=tmp so it resolves cwd()/dist to the throwaway tree.
  execFileSync('node', [SCRIPT], {
    cwd: tmp,
    env: { ...process.env, CDN_BASE },
    stdio: 'pipe',
  });
}

// Mirrors a live job page in a pruned shard subtree: unquoted brand-logo
// <img src=…> (as emitted), quoted variant, main-domain og:image, plus a ref
// already on a different CDN host that must survive untouched.
const JOB_PAGE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title>' +
  '<meta property="og:image" content="https://frontaliereticino.ch/og/jobs/mansioni-hirslanden-2f7ac8.webp">' +
  '</head><body>' +
  '<img src=/images/brands/hirslanden.png alt=a width=32 height=32>' +
  '<img src="/images/brands/other-logo.png" alt="b">' +
  '<img src="https://cdn.frontaliereticino.ch/images/brands/already.png" alt="c">' +
  '</body></html>';

describe('og/image CDN rewrite on shard dists (#3475)', () => {
  it('rewrites og:image + brand refs even when dist/og and dist/images are ABSENT', () => {
    const { tmp, distDir } = makeDist();
    // Shard reality: HTML nested under the locale subtree, no og/images dirs.
    const pageDir = path.join(distDir, 'cerca-lavoro-ticino', 'lavoro-hirslanden');
    fs.mkdirSync(pageDir, { recursive: true });
    const htmlPath = path.join(pageDir, 'index.html');
    fs.writeFileSync(htmlPath, JOB_PAGE_HTML, 'utf8');

    runOffload(tmp);
    const html = fs.readFileSync(htmlPath, 'utf8');

    // og:image → CDN.
    expect(html).toContain(`content="${CDN_BASE}/og/jobs/mansioni-hirslanden-2f7ac8.webp"`);
    expect(html).not.toContain('https://frontaliereticino.ch/og/');
    // Brand logos → CDN, both unquoted and quoted attr forms.
    expect(html).toContain(`src=${CDN_BASE}/images/brands/hirslanden.png`);
    expect(html).toContain(`src="${CDN_BASE}/images/brands/other-logo.png"`);
    expect(html).not.toContain('src=/images/brands/');
    expect(html).not.toContain('"/images/brands/');
    // Already-offloaded ref on another host untouched (no double-rewrite).
    expect(html).toContain('src="https://cdn.frontaliereticino.ch/images/brands/already.png"');
  });

  it('still rewrites AND guard-deletes target dirs that ARE present (full-dist parity)', () => {
    const { tmp, distDir } = makeDist();
    const ogDir = path.join(distDir, 'og', 'jobs');
    fs.mkdirSync(ogDir, { recursive: true });
    fs.writeFileSync(path.join(ogDir, 'a.webp'), 'x', 'utf8');
    const htmlPath = path.join(distDir, 'index.html');
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><html><head><title>t</title>' +
        '<meta property="og:image" content="https://frontaliereticino.ch/og/jobs/a.webp">' +
        '</head><body></body></html>',
      'utf8',
    );

    runOffload(tmp);
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain(`content="${CDN_BASE}/og/jobs/a.webp"`);
    // No surviving same-origin ref → offloaded dir deleted from the artifact.
    expect(fs.existsSync(path.join(distDir, 'og'))).toBe(false);
  });
});
