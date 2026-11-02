// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUnverifiedJobArchiveHtml } from '../../build-plugins/shared/unverifiedJobArchiveHtml';
import { REDIRECT_STUB_MARKER } from '../../build-plugins/shared/redirectStubMarker.mjs';
import { legacyRedirectsPlugin } from '../../build-plugins/legacyRedirectsPlugin';
import { createAuditor as createSalaryLandingAuditor } from '../../scripts/audit-salary-landing-template.mjs';
// @ts-expect-error — the Worker is plain JS.
import { upgradeLegacyStub } from '../../infra/cloudflare-worker/locale-router.js';

const SLUG = 'apprendistato-come-impiegata-o-di-commercio-afc-banca-la-posta-svizzera-lugano';
const FROM = `/cerca-lavoro-ticino/${SLUG}/`;
const TO = '/cerca-lavoro-ticino/apprendistato-come-impiegata-o-di-commercio-afc-banca-post/';
const ORIGIN = 'https://frontaliereticino.ch';
const seedScript = (seed: unknown) => `<script>window.__EXPIRED_JOB_DATA__=${JSON.stringify(seed)};</script>`;
const archive = (slug = SLUG, fields: Record<string, unknown> = {}, extraHead = '') =>
  `<!doctype html><html><head><meta name="robots" content="noindex,follow">${seedScript({ slug, company: 'La Posta Svizzera', ...fields })}${extraHead}</head><body>Unverified historical reference.</body></html>`;
const live = '<!doctype html><html><head><meta name="robots" content="index,follow"><title>Real content</title></head><body>Keep the real page.</body></html>';

describe('unverified archive identity is positive and route-specific', () => {
  it('recognizes current and older empty-field wire forms', () => {
    expect(isUnverifiedJobArchiveHtml(archive(), FROM)).toBe(true);
    expect(isUnverifiedJobArchiveHtml(archive(SLUG, { title: '', titleByLocale: {} }), FROM)).toBe(true);
    expect(isUnverifiedJobArchiveHtml(archive('cafe\u0301'), '/cerca-lavoro-ticino/caf%C3%A9/')).toBe(true);
  });

  it('normalizes HTML attribute forms without treating JS identifiers as case-insensitive', () => {
    const html = archive().replace('<head>', '<HEAD>').replace('</head>', '</HEAD>')
      .replace('<meta name="robots" content="noindex,follow">', "<META CONTENT='NOINDEX, FOLLOW' NAME=ROBOTS>")
      .replace('window.__EXPIRED_JOB_DATA__=', "window [ '__EXPIRED_JOB_DATA__' ] = ");
    expect(isUnverifiedJobArchiveHtml(html, FROM)).toBe(true);
    expect(isUnverifiedJobArchiveHtml(html.replace('window [', 'Window ['), FROM)).toBe(false);
    expect(isUnverifiedJobArchiveHtml(archive(), FROM)).toBe(true);
  });

  const keepCases: Array<[string, () => string]> = [
    ['recorded original title', () => archive(SLUG, { title: 'Original title' })],
    ['recorded localized title', () => archive(SLUG, { titleByLocale: { fr: 'Titre original' } })],
    ['malformed title field', () => archive(SLUG, { title: null })],
    ['malformed locale field', () => archive(SLUG, { titleByLocale: ['Original title'] })],
    ['different route slug', () => archive(`${SLUG}-another`)],
    ['encoded path separator', () => archive(`${SLUG}%2Fother`)],
    ['missing robots declaration', () => archive().replace(/<meta[^>]+>/, '')],
    ['indexable content', () => archive().replace('noindex,follow', 'index,follow')],
    ['conflicting robots declarations', () => archive(SLUG, {}, '<meta NAME=Robots content="index,follow">')],
    ['conflicting duplicate attributes', () => archive().replace('content="noindex,follow"', 'content="noindex" CONTENT="index"')],
    ['active job seed', () => archive(SLUG, {}, '<script>window.__JOB_SEED__={id:"active"};</script>')],
    ['active bracket-form job seed', () => archive(SLUG, {}, '<script>window["__JOB_SEED__"]={id:"active"};</script>')],
    ['JobPosting in a graph and type array', () => archive(SLUG, {}, '<script TYPE="application/ld+json">{"@graph":[{"@type":["Thing","https://schema.org/JobPosting"]}]}</script>')],
    ['malformed JSON-LD', () => archive(SLUG, {}, '<script type=application/ld+json>{broken</script>')],
    ['duplicate expired seeds', () => archive(SLUG, {}, seedScript({ slug: SLUG }))],
    ['non-JSON assignment', () => archive().replace(JSON.stringify({ slug: SLUG, company: 'La Posta Svizzera' }), 'JSON.parse("{}")')],
    ['external script seed', () => archive().replace('<script>', '<script src="/seed.js">')],
    ['non-JS script seed', () => archive().replace('<script>', '<script type="application/json">')],
    ['comment-only seed', () => `<!doctype html><html><head><meta name=robots content=noindex><!--${seedScript({ slug: SLUG })}--></head></html>`],
    ['no document head', () => seedScript({ slug: SLUG })],
  ];
  it.each(keepCases)('preserves %s as content or unknown', (_name, html) => {
    expect(isUnverifiedJobArchiveHtml(html(), FROM)).toBe(false);
  });
});

describe('canonical aliases versus existing HTML ownership', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

  it('replaces only unverified representations and produces the real Worker 301', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-archive-precedence-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/jobs.json'), '[]');
    fs.writeFileSync(path.join(root, 'data/article-redirects.json'), JSON.stringify({
      '/articoli-frontaliere/old-archive-ref/': '/articoli-frontaliere/renamed-archive-ref/',
    }));
    const write = (url: string, html: string, flat = false) => {
      const file = path.join(root, 'dist', flat ? `${url.replace(/^\/|\/$/g, '')}.html` : `${url}/index.html`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, html); return file;
    };
    const oldIndex = write(FROM, archive());
    const oldFlat = write(FROM, archive(), true);
    const active = write('/cerca-lavoro-ticino/ricerca-ambiente-bern/', live);
    const recordedHtml = archive('ricerca-ambiente-luzern', { title: 'Recorded original vacancy' });
    const recorded = write('/cerca-lavoro-ticino/ricerca-ambiente-luzern/', recordedHtml);
    const flatOnlyActive = write('/guida-frontalieri/', live, true);
    const mixedHtml = archive('pianificatore-pensione');
    const mixedIndex = write('/pianificatore-pensione/', mixedHtml);
    const mixedFlat = write('/pianificatore-pensione/', live, true);
    const article = write('/articoli-frontaliere/old-archive-ref/', archive('old-archive-ref'));
    const hook = legacyRedirectsPlugin(root).closeBundle as unknown as { handler: () => Promise<void> };
    await hook.handler();
    for (const file of [oldIndex, oldFlat]) {
      const html = fs.readFileSync(file, 'utf8');
      expect(html).not.toContain('window.__EXPIRED_JOB_DATA__');
      for (const method of ['GET', 'HEAD']) {
        const response = await upgradeLegacyStub(new Request(`${ORIGIN}${FROM}?utm_source=audit`, { method }),
          new Response(method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html' } }),
          async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
        expect(response.status).toBe(301);
        expect(response.headers.get('Location')).toBe(`${TO}?utm_source=audit`);
      }
    }
    expect(fs.readFileSync(article, 'utf8')).toContain('/articoli-frontaliere/renamed-archive-ref/');
    for (const file of [active, flatOnlyActive, mixedFlat]) expect(fs.readFileSync(file, 'utf8')).toBe(live);
    expect(fs.readFileSync(recorded, 'utf8')).toBe(recordedHtml);
    expect(fs.readFileSync(mixedIndex, 'utf8')).toBe(mixedHtml);
    expect(fs.existsSync(path.join(root, 'dist/guida-frontalieri/index.html'))).toBe(false);
  });

  it('emits the declared TI search aliases with their unchanged target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-search-alias-targets-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/jobs.json'), '[]');
    fs.writeFileSync(path.join(root, 'data/article-redirects.json'), '{}');
    const hook = legacyRedirectsPlugin(root).closeBundle as unknown as { handler: () => Promise<void> };
    await hook.handler();

    for (const slug of ['ricerca-ambiente-bern', 'ricerca-ambiente-luzern']) {
      const from = `/cerca-lavoro-ticino/${slug}/`;
      const html = fs.readFileSync(path.join(root, 'dist', from.slice(1), 'index.html'), 'utf8');
      expect(html, `${from} keeps the section-root target`).toContain(`${ORIGIN}/cerca-lavoro-ticino/`);
    }
  });

  it('emits forced legacy salary aliases as marked noindex bridges without canonicals', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-legacy-bridge-contract-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/jobs.json'), '[]');
    fs.writeFileSync(path.join(root, 'data/article-redirects.json'), '{}');
    const hook = legacyRedirectsPlugin(root).closeBundle as unknown as { handler: () => Promise<void> };
    await hook.handler();

    const aliases = [
      ['calcola-stipendio/confronta-permesso-g-vs-b', '/guida-frontaliere/confronta-permesso-g-vs-b/'],
      ['en/calculate-salary/compare-salaries', '/en/statistics/compare-salaries/'],
      ['en/calculate-salary/what-if', '/en/calculate-salary/what-if-scenarios/'],
    ] as const;
    const auditor = createSalaryLandingAuditor();
    for (const [slug, target] of aliases) {
      const bridgePath = path.join(root, 'dist', slug, 'index.html');
      const html = fs.readFileSync(bridgePath, 'utf8');
      expect(html).toContain(REDIRECT_STUB_MARKER);
      expect(html).toMatch(/<meta\b[^>]*name="robots"[^>]*content="noindex,follow"/i);
      expect(html).not.toMatch(/<link\b[^>]*rel="canonical"/i);
      expect(html).toContain(`${ORIGIN}${target}`);
      auditor.collect(bridgePath, html);
    }
    const audit = await auditor.report();
    expect(audit.extra.scanned).toBe(0);
    expect(audit.offendersTotal).toBe(0);
  });

  it('keeps a non-TI job whose slug begins azienda- as a marked redirect bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-company-namespace-job-bridge-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    const slug = 'azienda-di-consulenza-clienti-tutti-i-tipi-regione-broye-nord-vaudois-tempo-pieno-o-parziale-helvetia-versicherungen';
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify([{ canton: 'VD', slug }]));
    fs.writeFileSync(path.join(root, 'data/article-redirects.json'), '{}');
    const hook = legacyRedirectsPlugin(root).closeBundle as unknown as { handler: () => Promise<void> };
    await hook.handler();

    const bridgePath = path.join(root, 'dist', 'cerca-lavoro-ticino', slug, 'index.html');
    const html = fs.readFileSync(bridgePath, 'utf8');
    expect(html).toContain(REDIRECT_STUB_MARKER);
    expect(html).toMatch(/<meta\b[^>]*name="robots"[^>]*content="noindex,follow"/i);
    expect(html).not.toMatch(/<link\b[^>]*rel="canonical"/i);
    expect(html).toContain(`${ORIGIN}/cerca-lavoro-vaud/${slug}/`);
  });
});
