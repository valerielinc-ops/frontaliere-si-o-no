import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfHot404BridgePlugin } from '../build-plugins/cfHot404BridgePlugin';

/**
 * The plugin resolves paths via resolveSearchConsoleCompatTarget (reads
 * data/jobs.json, assembled in the CI gate before vitest). These assertions
 * cover the bounded-recovery invariants:
 *   - hot-list non-Ticino job paths get a recovered noindex bridge,
 *   - an already-emitted richer page is never overwritten (gap-fill),
 *   - the hard MAX_EMIT cap bounds the page count regardless of list size.
 */
describe('cfHot404BridgePlugin', () => {
  let tmp: string;

  const hot = {
    generatedAt: '2026-06-15T00:00:00.000Z',
    source: 'cloudflare',
    paths: [
      { path: '/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau', hits: 9 },
      { path: '/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich', hits: 7 },
      { path: '/cerca-lavoro-zurigo/preexisting-richer-role', hits: 5 },
      // Legacy bare page-N whose specific pagination-ladder page was never
      // built for this run (simulates the canton's page count having shrunk
      // below 97 since the original GSC crawl).
      { path: '/cerca-lavoro-argovia/page-97', hits: 4 },
      // Same case, but en's pagination word is the legacy "page" itself, so
      // an unresolved target is textually identical to the source path —
      // must not be dropped as a false self-reference.
      { path: '/en/find-jobs-zurich/page-88', hits: 3 },
    ],
  };

  const rel = (p: string) => p.replace(/^\//, '') + '/index.html';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hot-'));
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'cf-hot-404s.json'), JSON.stringify(hot));
    // Pre-existing richer page the gap-fill guard must preserve.
    const preDir = path.join(tmp, 'dist', 'cerca-lavoro-zurigo', 'preexisting-richer-role');
    fs.mkdirSync(preDir, { recursive: true });
    fs.writeFileSync(path.join(preDir, 'index.html'), '<html>RICHER</html>');

    // Pagination fallbackPath targets (section listing roots) — in real builds
    // these are always-live canton/locale hub pages generated well before this
    // plugin runs; the fallback-existence gap-fill (PR #4252 review round 2)
    // requires them to actually be on disk, same as any other bridge target.
    for (const root of ['cerca-lavoro-argovia', 'en/find-jobs-zurich']) {
      const rootDir = path.join(tmp, 'dist', root);
      fs.mkdirSync(rootDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'index.html'), '<html>SECTION ROOT</html>');
    }

    const plugin = cfHot404BridgePlugin(tmp);
    // Issue #4263 item 4: closeBundle is now an object hook ({order, sequential,
    // handler}), not a plain function — see flat-html-redirect.test.ts's
    // runPluginCloseBundle for the same pattern.
    const closeBundle = plugin.closeBundle;
    if (!closeBundle || typeof closeBundle !== 'object' || !('handler' in closeBundle)) {
      throw new Error('closeBundle must be an object hook with handler');
    }
    await closeBundle.handler.call({} as never);
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('recovers a hot non-Ticino job path as a noindex canonical bridge', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-argovia/recovered-non-ti-role-acme-aarau'));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('noindex');
  });

  it('recovers a hot path in a non-default locale (EN)', () => {
    const file = path.join(tmp, 'dist', rel('/en/find-jobs-zurich/recovered-non-ti-role-acme-zurich'));
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never overwrites an already-emitted richer page (gap-fill)', () => {
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-zurigo/preexisting-richer-role'));
    expect(fs.readFileSync(file, 'utf-8')).toBe('<html>RICHER</html>');
  });

  it('emits a legacy cluster orphan as a meta-refresh REDIRECT to its live target, not an archived bridge', () => {
    // Data-driven: pick a real entry from the committed cluster recovery map so
    // the test survives map regeneration.
    const map = (
      JSON.parse(fs.readFileSync(path.resolve('data/search-cluster-301-map.json'), 'utf-8')) as {
        map: Record<string, string>;
      }
    ).map;
    const [legacyPath, target] = Object.entries(map)[0];
    const file = path.join(tmp, 'dist', rel(legacyPath.replace(/\/$/, '')));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    // Redirects the user straight to the live page…
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=${target}"`);
    expect(html).toContain(`rel="canonical" href="https://frontaliereticino.ch${target}"`);
    expect(html).toContain('noindex');
    // …instead of dead-ending on the archived compat copy.
    expect(html).not.toContain('Pagina archiviata');
  });

  it('falls back to the section listing root when the specific pagination page was never built', () => {
    // The resolver would canonicalize to /cerca-lavoro-argovia/pagina-97/, but
    // that page was never built in this dist (canton page count < 97) — the
    // bridge must point at the always-live section root instead, never at a
    // page that doesn't exist on disk.
    const missingPage = path.join(tmp, 'dist', rel('/cerca-lavoro-argovia/pagina-97'));
    expect(fs.existsSync(missingPage)).toBe(false);
    const file = path.join(tmp, 'dist', rel('/cerca-lavoro-argovia/page-97'));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    expect(html).toContain('rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-argovia/"');
    expect(html).not.toContain('/cerca-lavoro-argovia/pagina-97/');
  });

  it('does not drop the bridge as a false self-reference when en/fr share the "page" word', () => {
    // Before the fallback resolution moved ahead of the self-reference guard,
    // canonicalPath ('/en/find-jobs-zurich/page-88/') was textually identical
    // to the source path, so the loop skipped it entirely — no bridge, no
    // fallback, orphan stayed a blank shell.
    const file = path.join(tmp, 'dist', rel('/en/find-jobs-zurich/page-88'));
    expect(fs.existsSync(file)).toBe(true);
    const html = fs.readFileSync(file, 'utf-8');
    expect(html).toContain('rel="canonical" href="https://frontaliereticino.ch/en/find-jobs-zurich/"');
    expect(html).not.toContain('/en/find-jobs-zurich/page-88/');
  });
});

/**
 * Issue #2707: the canton-moved verbatim-copy path forces `noindex,follow` on the
 * copied canonical HTML. PR #478 baked `removeAttributeQuotes` upstream, so the
 * built dist HTML carries an UNQUOTED `<meta name=robots ...>`. A quote-mandatory
 * detect/replace regex (`name=["']robots["']`) misses that minified meta, falls
 * through to the <head>-inject branch, and emits a SECOND robots meta while the
 * original `index,follow` one survives → the drift copy stays indexable.
 *
 * These assertions lock the regex contract: it must match robots metas whether or
 * not the attribute value is quoted, replacing in place (single meta, noindex),
 * and never injecting a duplicate.
 */
describe('cfHot404BridgePlugin robots regex (quote-flexible, issue #2707)', () => {
  // Mirrors the detect + replace regex pair in cfHot404BridgePlugin.ts.
  const DETECT_RE = /<meta\s+name=["']?robots["']?/i;
  const REPLACE_RE = /<meta\s+name=["']?robots["']?[^>]*>/i;
  const forceNoindex = (html: string): string =>
    DETECT_RE.test(html)
      ? html.replace(REPLACE_RE, '<meta name="robots" content="noindex,follow">')
      : html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<meta name="robots" content="noindex,follow">`);

  const robotsCount = (html: string) => (html.match(/<meta\s+name=["']?robots/gi) || []).length;

  it('replaces an UNQUOTED minified robots meta in place (no duplicate)', () => {
    const minified = '<html><head><meta name=robots content=index,follow><title>x</title></head></html>';
    const out = forceNoindex(minified);
    expect(out).toContain('content="noindex,follow"');
    expect(out).not.toContain('content=index,follow');
    expect(robotsCount(out)).toBe(1);
  });

  it('replaces a QUOTED robots meta in place (no duplicate)', () => {
    const quoted = '<html><head><meta name="robots" content="index,follow"><title>x</title></head></html>';
    const out = forceNoindex(quoted);
    expect(out).toContain('content="noindex,follow"');
    expect(out).not.toContain('content="index,follow"');
    expect(robotsCount(out)).toBe(1);
  });

  it('injects a robots meta into <head> when none is present', () => {
    const none = '<html><head><title>x</title></head></html>';
    const out = forceNoindex(none);
    expect(out).toContain('content="noindex,follow"');
    expect(robotsCount(out)).toBe(1);
  });
});
