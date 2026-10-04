/**
 * Inventory of every GA4 page_view producer in the site source.
 *
 * The D18 gate of Employer Insights (`findFirstCompleteGa4IdentityAt` in
 * scripts/build-employer-insights.mjs) accepts a GA4 day only when every
 * evidence event carries `emission_id`: ONE page view without it keeps the
 * gate red. This test makes sure the current source cannot be such a
 * producer:
 *
 *   1. every quoted `page_view` token is either an explicit producer whose
 *      params object carries a real `emission_id`, or an allowlisted
 *      non-producer (with the reason written below);
 *   2. the set of producer files is exactly the allowlist, so a new producer
 *      is a deliberate decision;
 *   3. every `gtag('config', …)` disables the automatic page_view
 *      (`send_page_view: false`): that automatic event has no emission_id;
 *   4. Firebase Analytics is never acquired through the SDK `getAnalytics`
 *      (on an uninitialized app it initializes with the default config, which
 *      sends the automatic page_view) and every `initializeAnalytics` call
 *      passes settings with `send_page_view: false`.
 *
 * Behaviour of the producers themselves is covered in
 * tests/page-view-history-entry.test.ts and tests/affiliate-redirect-pubref.test.ts.
 * Failure title: «Employer Insights D18: page view senza emission_id da un
 * produttore senza identità».
 */
import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

/** Client and edge code that can run in a visitor's browser or send GA4 hits. */
const SCAN_DIRS = ['build-plugins', 'services', 'components', 'hooks', 'functions/src', 'server'];
const SCAN_ROOT_FILES = ['App.tsx', 'index.tsx', 'index.html', 'constants.ts'];
/** Tracked hand-written files under public/ (public/data and public/images are generated assets). */
const SCAN_PUBLIC_DIRS = ['public'];
const PUBLIC_SKIP = new Set(['public/data', 'public/images']);
const SOURCE_EXT = /\.(?:ts|tsx|js|mjs|cjs|html)$/;

/** Files allowed to emit a GA4 page_view; each emission must carry emission_id. */
const PAGE_VIEW_PRODUCERS = [
  'build-plugins/affiliateRedirectPlugin.ts', // /go/<partner>/ redirect page_view
  'build-plugins/constants.ts', // GTAG_INIT_CONTENT, the static bounce-safe page_view
  'services/analytics.ts', // Analytics.trackPageView, the SPA page_view
].sort();

/** Quoted page_view tokens that do not emit an event, with the reason. */
const NON_PRODUCER_OCCURRENCES: Record<string, { count: number; reason: string }> = {
  'services/analytics.ts': {
    count: 1,
    reason: "log(): `eventName === 'page_view'` picks the PostHog $pageview mirror of params already built by trackPageView",
  },
};

function walk(dir: string, out: string[]): void {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    const rel = `${dir}/${entry}`;
    if (entry === 'node_modules' || PUBLIC_SKIP.has(rel)) continue;
    const stat = lstatSync(join(ROOT, rel));
    // Symlinks point into packages/articles (shared article engine, data
    // readers) and dangle in sparse worktrees: skip them so the scanned set
    // is the same locally and in CI.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(rel, out);
    else if (SOURCE_EXT.test(entry) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(rel);
  }
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of [...SCAN_DIRS, ...SCAN_PUBLIC_DIRS]) walk(dir, out);
  for (const file of SCAN_ROOT_FILES) if (existsSync(join(ROOT, file))) out.push(file);
  return [...new Set(out)].sort();
}

/** True when the line holding `index` is a comment line (docblock, `//`, `<!--`). */
function inCommentLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const line = text.slice(lineStart, index).trimStart();
  return line.startsWith('*') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('<!--');
}

/** The balanced `open…close` span starting at the first non-blank char at/after `from`. */
function balancedSpan(text: string, from: number, open: string, close: string): string | null {
  let i = from;
  while (i < text.length && /[\s,]/.test(text[i])) i += 1;
  if (text[i] !== open) return null;
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === open) depth += 1;
    else if (text[j] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** emission_id present with a value that is not a literal empty/absent one. */
function carriesEmissionId(params: string): boolean {
  const match = params.match(/(?:^|[{,\s])['"]?emission_id['"]?\s*:\s*([^,}\s]+)/);
  if (!match) return false;
  return !/^(?:undefined|null|''|""|``)$/.test(match[1]);
}

const PRODUCER_CALL_BEFORE = [
  /\bgtag(?:\?\.)?\(\s*(['"])event\1\s*,\s*$/, // gtag('event', 'page_view', {...})
  /\b(?:log|logFirebaseOnly|_doLog|logEvent|_logEvent)\(\s*(?:[\w$.]+\s*,\s*)?$/, // log('page_view', {...}) / logEvent(analytics, 'page_view', {...})
];

interface Occurrence { file: string; line: number; kind: 'producer' | 'other'; params: string | null }

function pageViewOccurrences(file: string, text: string): Occurrence[] {
  const out: Occurrence[] = [];
  const token = /(['"`])page_view\1/g;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (inCommentLine(text, match.index)) continue;
    const before = text.slice(Math.max(0, match.index - 120), match.index);
    const isProducer = PRODUCER_CALL_BEFORE.some((pattern) => pattern.test(before));
    out.push({
      file,
      line: text.slice(0, match.index).split('\n').length,
      kind: isProducer ? 'producer' : 'other',
      params: isProducer ? balancedSpan(text, match.index + match[0].length, '{', '}') : null,
    });
  }
  return out;
}

function gtagConfigCalls(file: string, text: string): Array<{ file: string; line: number; call: string | null }> {
  const out: Array<{ file: string; line: number; call: string | null }> = [];
  const pattern = /\bgtag(?:\?\.)?(?=\(\s*(['"])config\1)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (inCommentLine(text, match.index)) continue;
    out.push({
      file,
      line: text.slice(0, match.index).split('\n').length,
      call: balancedSpan(text, match.index + match[0].length, '(', ')'),
    });
  }
  return out;
}

function codeLines(text: string): string {
  return text.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
  }).join('\n');
}

const FILES = sourceFiles();
const TEXTS = new Map(FILES.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));
const OCCURRENCES = FILES.flatMap((file) => pageViewOccurrences(file, TEXTS.get(file)!));

describe('GA4 page_view producers all carry emission_id', () => {
  it('scans the client source tree', () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const file of PAGE_VIEW_PRODUCERS) expect(FILES, `${file} is not scanned`).toContain(file);
  });

  it('the producer files are exactly the allowlist', () => {
    const producerFiles = [...new Set(OCCURRENCES.filter((o) => o.kind === 'producer').map((o) => o.file))].sort();
    expect(
      producerFiles,
      'a new GA4 page_view producer must carry emission_id (ANALYTICS_EMISSION_ID_FACTORY_JS in build-plugins/constants.ts) and be added to PAGE_VIEW_PRODUCERS',
    ).toEqual(PAGE_VIEW_PRODUCERS);
  });

  it('every producer passes a params object with a real emission_id', () => {
    const offenders = OCCURRENCES
      .filter((o) => o.kind === 'producer' && !(o.params && carriesEmissionId(o.params)))
      .map((o) => `${o.file}:${o.line}`);
    expect(offenders, 'page_view emitted without an inline params object carrying emission_id').toEqual([]);
  });

  it('every other quoted page_view token is an allowlisted non-producer', () => {
    const counts = new Map<string, number>();
    for (const o of OCCURRENCES) if (o.kind === 'other') counts.set(o.file, (counts.get(o.file) ?? 0) + 1);
    const unexpected = [...counts].filter(([file, count]) => NON_PRODUCER_OCCURRENCES[file]?.count !== count);
    const vanished = Object.keys(NON_PRODUCER_OCCURRENCES).filter((file) => !counts.has(file));
    expect(
      unexpected.map(([file, count]) => `${file} (${count})`),
      "unclassified 'page_view' token: if it emits an event, write it as gtag('event', 'page_view', {…, emission_id}) / log('page_view', {…}); if it only reads, add it to NON_PRODUCER_OCCURRENCES with the reason",
    ).toEqual([]);
    expect(vanished, 'stale NON_PRODUCER_OCCURRENCES entry').toEqual([]);
  });

  it("every gtag('config', …) disables the automatic page_view", () => {
    const calls = FILES.flatMap((file) => gtagConfigCalls(file, TEXTS.get(file)!));
    expect(calls.length).toBeGreaterThan(0);
    const offenders = calls
      .filter((c) => !(c.call && /['"]?send_page_view['"]?\s*:\s*false\b/.test(c.call)))
      .map((c) => `${c.file}:${c.line}`);
    expect(offenders, "gtag('config') without send_page_view:false sends a page_view without emission_id").toEqual([]);
  });

  it('Firebase Analytics never initializes with the default config', () => {
    const sdkGetAnalytics: string[] = [];
    const initCalls: Array<{ file: string; args: string | null }> = [];
    for (const file of FILES) {
      const code = codeLines(TEXTS.get(file)!);
      const destructured = /\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])firebase\/analytics\2\s*\)/g;
      const imported = /import\s*\{([^}]*)\}\s*from\s*(['"])firebase\/analytics\2/g;
      for (const pattern of [destructured, imported]) {
        for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
          if (/\bgetAnalytics\b/.test(match[1])) sdkGetAnalytics.push(file);
        }
      }
      const init = /\binitializeAnalytics(?=\()/g;
      for (let match = init.exec(code); match; match = init.exec(code)) {
        initCalls.push({ file, args: balancedSpan(code, match.index + match[0].length, '(', ')') });
      }
    }
    expect(sdkGetAnalytics, 'use initializeAnalytics(app, FIREBASE_ANALYTICS_SETTINGS) instead of the SDK getAnalytics').toEqual([]);
    expect(initCalls.length).toBeGreaterThan(0);

    const firebaseSource = TEXTS.get('services/firebase.ts')!;
    const settings = firebaseSource.match(/const FIREBASE_ANALYTICS_SETTINGS\s*=\s*(\{[^;]*\});/);
    expect(settings?.[1]).toMatch(/send_page_view\s*:\s*false\b/);
    const offenders = initCalls
      .filter((c) => !(c.args && (/,\s*FIREBASE_ANALYTICS_SETTINGS\s*\)$/.test(c.args) || /send_page_view\s*:\s*false\b/.test(c.args))))
      .map((c) => `${c.file}: initializeAnalytics${c.args ?? '(?)'}`);
    expect(offenders, 'initializeAnalytics without send_page_view:false sends a page_view without emission_id').toEqual([]);
  });

  it('the producer scan is not vacuous', () => {
    // A regex regression that stopped matching would turn every check above
    // into a silent pass: the known producers must be found as producers.
    const producerFiles = new Set(OCCURRENCES.filter((o) => o.kind === 'producer').map((o) => o.file));
    for (const file of PAGE_VIEW_PRODUCERS) expect(producerFiles.has(file), file).toBe(true);
  });
});
