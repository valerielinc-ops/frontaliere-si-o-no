// edgeLegacyStubRedirects.ts
//
// The STATIC half of legacyRedirectsPlugin's map, as the apex Worker needs it.
//
// legacyRedirectsPlugin answers a legacy URL with a 200 "Pagina spostata" page
// (noindex,follow + meta-refresh): a fake page, not a redirect. The Worker
// (infra/cloudflare-worker/locale-router.js) turns that stub into a real 301 at
// the edge, but it is a single bundled script that cannot import this TS build
// graph, so it reads a GENERATED copy of this table:
//
//   infra/cloudflare-worker/legacy-stub-redirects.generated.mjs
//
// regenerated with
//
//   npx tsx scripts/build-edge-legacy-stub-redirects.ts
//
// and kept honest by tests/edge-legacy-stub-redirects.test.ts, which rebuilds
// the module from this function and fails on any byte of drift. Edit the plugin
// table, regenerate, commit both — the test names the command.
//
// WHAT IS IN IT. Exactly the entries whose (from → to) is known before the build
// runs, with the plugin's own precedence:
//   1. the hand-authored literal in legacyRedirectsPlugin.ts (read with the
//      same scanner every other consumer of that literal uses), on top of
//      LEGACY_LUGANO_COMPETITION_REDIRECTS, which the literal spreads first;
//   2. BORDER_WAIT_LEGACY_REDIRECTS, added only where the literal is silent;
//   3. data/article-redirects.json, added only where the literal is silent.
// NOT in it: the cathedral job map (derived from data/jobs.json at build time)
// and the Search Console compat pages (derived from the compat store): neither
// is static, and both stay noindex,follow bridges.
//
// WHY THE WORKER CHECKS THE ORIGIN FIRST. A path in this table is only 301'd
// when the origin actually answers it with the plugin's stub (the
// REDIRECT_STUB_MARKER comment in <head>). The plugin itself never overwrites a
// page another plugin emitted at the same path, so "the table lists it" does not
// mean "nothing lives there": a live page always wins over the table.

import { readHardcodedRedirects, loadArticleRedirects } from './articleRedirects.mjs';
import { LEGACY_LUGANO_COMPETITION_REDIRECTS } from './legacyLuganoCompetitionRedirects';
import { BORDER_WAIT_LEGACY_REDIRECTS } from './borderWaitLegacyRedirects';

export const EDGE_LEGACY_STUB_MODULE_PATH = 'infra/cloudflare-worker/legacy-stub-redirects.generated.mjs';
export const EDGE_LEGACY_STUB_GENERATOR = 'npx tsx scripts/build-edge-legacy-stub-redirects.ts';

function withSlash(p: string): string {
  const n = p.startsWith('/') ? p : `/${p.replace(/^\/+/, '')}`;
  return n === '/' || n.endsWith('/') ? n : `${n}/`;
}

/** from → to, both in trailing-slash form, in the plugin's precedence order. */
export function buildEdgeLegacyStubRedirects(rootDir: string): Record<string, string> {
  const out = new Map<string, string>();
  const put = (from: string, to: string, override: boolean) => {
    const f = withSlash(from);
    const t = withSlash(to);
    if (f === '/' || f === t) return;
    if (!override && out.has(f)) return;
    out.set(f, t);
  };
  for (const [from, to] of Object.entries(LEGACY_LUGANO_COMPETITION_REDIRECTS)) put(from, to, true);
  for (const [from, to] of Object.entries(readHardcodedRedirects(rootDir) as Record<string, string>)) put(from, to, true);
  for (const [from, to] of BORDER_WAIT_LEGACY_REDIRECTS) put(from, to, false);
  for (const [from, to] of Object.entries(loadArticleRedirects(rootDir, { warn: () => {} }) as Record<string, string>)) {
    put(from, to, false);
  }
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The generated Worker module, byte-for-byte. */
export function renderEdgeLegacyStubModule(table: Record<string, string>): string {
  const rows = Object.entries(table).map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)},`);
  return [
    '// GENERATED — do not edit by hand.',
    `// Source: build-plugins/shared/edgeLegacyStubRedirects.ts (legacyRedirectsPlugin static map).`,
    `// Regenerate: ${EDGE_LEGACY_STUB_GENERATOR}`,
    '// Drift gate: tests/edge-legacy-stub-redirects.test.ts',
    '//',
    '// Read by infra/cloudflare-worker/locale-router.js: a GET/HEAD on one of these',
    '// paths that the origin answers 200 with the legacy redirect stub becomes a',
    '// real 301 to the value. A live page at the same path is served untouched.',
    `// ${rows.length} entries.`,
    'export const EDGE_LEGACY_STUB_REDIRECTS = Object.freeze({',
    ...rows,
    '});',
    '',
  ].join('\n');
}
