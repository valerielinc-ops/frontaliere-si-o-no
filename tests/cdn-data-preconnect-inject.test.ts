/**
 * Integration guard for the data/image CDN preconnect resource hint.
 *
 * The post-build offload step (scripts/offload-generated-images-cdn.mjs) injects
 * `window.__CDN_DATA_BASE__` into every dist HTML so runtime cdnDataUrl()/
 * cdnImageUrl() fetches resolve to the dedicated CDN host. That CDN host is a
 * DISTINCT origin from both the site origin and the asset CDN, so the FIRST
 * cross-origin data/image fetch pays a cold DNS+TLS RTT on the critical path
 * (worst on mobile, ~75% of traffic). To warm that connection early, the same
 * step must also inject a `<link rel="preconnect" crossorigin>` (+ dns-prefetch
 * fallback) to the CDN ORIGIN, placed BEFORE the base script so the browser
 * starts the handshake during head parse.
 *
 * This runs the real script end-to-end against a throwaway dist/ to lock the
 * contract: the hint is present, points at the bare origin (no path), is
 * crossorigin-anonymous (required so the anonymous CORS fetch reuses the socket),
 * precedes the base script, and is injected exactly once (idempotent re-run).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mutateFixture } from './helpers/mutateFixture';

const SCRIPT = fileURLToPath(
  new URL('../scripts/offload-generated-images-cdn.mjs', import.meta.url),
);
const CDN_BASE = 'https://valerielinc-ops.github.io/frontaliere-cdn';
const CDN_ORIGIN = 'https://valerielinc-ops.github.io';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function runOffload(htmlBody: string): { html: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-preconnect-'));
  tmpDirs.push(tmp);
  const distDir = path.join(tmp, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const htmlPath = path.join(distDir, 'index.html');
  fs.writeFileSync(htmlPath, htmlBody, 'utf8');
  // Run the real offload script with cwd=tmp so it resolves cwd()/dist to our
  // throwaway tree. CDN push is a separate deploy step — offloadAll only mutates
  // files inside distDir, so there are no external side effects.
  execFileSync('node', [SCRIPT], {
    cwd: tmp,
    env: { ...process.env, CDN_BASE },
    stdio: 'pipe',
  });
  return { html: fs.readFileSync(htmlPath, 'utf8'), tmp };
}

const BASE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head>' +
  '<body><h1>x</h1></body></html>';

describe('data/image CDN preconnect injection', () => {
  it('injects a crossorigin preconnect + dns-prefetch to the CDN origin', () => {
    const { html } = runOffload(BASE_HTML);
    expect(html).toContain(`<link rel="preconnect" href="${CDN_ORIGIN}" crossorigin>`);
    expect(html).toContain(`<link rel="dns-prefetch" href="${CDN_ORIGIN}">`);
    // Base script still injected alongside the hint.
    expect(html).toContain(`window.__CDN_DATA_BASE__="${CDN_BASE}"`);
  });

  it('preconnect targets the bare origin, never the path', () => {
    const { html } = runOffload(BASE_HTML);
    // The preconnect/dns-prefetch href must be scheme+host only — preconnect
    // ignores the path and a pathful href is a no-op hint.
    expect(html).not.toContain(`rel="preconnect" href="${CDN_BASE}"`);
    expect(html).not.toContain(`rel="dns-prefetch" href="${CDN_BASE}"`);
  });

  it('places the preconnect before the base script (handshake starts early)', () => {
    const { html } = runOffload(BASE_HTML);
    const hintAt = html.indexOf('rel="preconnect"');
    const scriptAt = html.indexOf('__CDN_DATA_BASE__');
    const headAt = html.indexOf('<head');
    expect(hintAt).toBeGreaterThan(headAt);
    expect(hintAt).toBeLessThan(scriptAt);
  });

  it('skips the hint when the page already preconnects to the same origin (#3530)', () => {
    // When the data CDN origin coincides with the asset CDN origin, the build
    // already ships this exact preconnect (asyncCssPlugin / template heads) —
    // the offload pass must not add a second one, and must not add a
    // dns-prefetch either (an existing preconnect supersedes it). The base
    // script is still required.
    const preHinted = mutateFixture(
      BASE_HTML,
      '<head>',
      `<head><link rel="preconnect" href="${CDN_ORIGIN}" crossorigin>`,
    );
    const { html } = runOffload(preHinted);
    const count = (s: string) => s.split('rel="preconnect"').length - 1;
    expect(count(html)).toBe(1);
    expect(html).not.toContain(`<link rel="dns-prefetch" href="${CDN_ORIGIN}">`);
    expect(html).toContain(`window.__CDN_DATA_BASE__="${CDN_BASE}"`);
  });

  it('is idempotent — a re-run does not duplicate the hint', () => {
    const { html, tmp } = runOffload(BASE_HTML);
    // Re-run against the already-injected tree.
    execFileSync('node', [SCRIPT], { cwd: tmp, env: { ...process.env, CDN_BASE }, stdio: 'pipe' });
    const html2 = fs.readFileSync(path.join(tmp, 'dist', 'index.html'), 'utf8');
    const count = (s: string) => s.split('rel="preconnect"').length - 1;
    expect(count(html)).toBe(1);
    expect(count(html2)).toBe(1);
  });
});
