/**
 * Regression gate: forbid ANY `<meta name="twitter:*">` emission in
 * build-plugins/*.ts and services/*.ts.
 *
 * Why: X (Twitter) is not a meaningful traffic source for this site
 * (SEO funnel for Swiss-Italian frontalieri). LinkedIn / Facebook /
 * WhatsApp / Discord / Slack all use og:* — twitter:* tags add bytes
 * to every page (~48 MB across 825k HTML pages on the May 21 2026
 * artifact) without value.
 *
 * Also forbids client-side `updateOrCreateMetaTag('name', 'twitter:*', ...)`
 * in services/*.ts — the SPA's runtime meta injection had the same
 * cost (per-route DOM mutation) for zero benefit.
 *
 * If X ever becomes a relevant traffic source, re-introduce these by
 * deleting this test AND adding them centrally in
 * build-plugins/htmlTemplate.ts so all pages emit them consistently
 * (the prior fragmented per-plugin pattern is what caused the original
 * duplication problem — see PR #473).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STATIC_META_RE = /<meta\s+name="twitter:[a-z][a-z0-9:_-]*"/g;
const RUNTIME_META_RE = /updateOrCreateMetaTag\(\s*['"]name['"]\s*,\s*['"]twitter:[a-z][a-z0-9:_-]*['"]/g;

function walkTs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.ts')) out.push(p);
    }
  }
  return out;
}

function findOffenders(root: string, re: RegExp) {
  const offenders: { file: string; lines: string[] }[] = [];
  for (const file of walkTs(root)) {
    const src = readFileSync(file, 'utf8');
    re.lastIndex = 0;
    const matches = [...src.matchAll(re)];
    if (matches.length === 0) continue;
    const lines = src.split('\n');
    const hits = matches.map((m) => {
      const upto = src.slice(0, m.index ?? 0);
      const lineNo = upto.split('\n').length;
      return `${lineNo}: ${lines[lineNo - 1]?.trim() ?? ''}`;
    });
    offenders.push({ file, lines: hits });
  }
  return offenders;
}

describe('no twitter:* meta in source', () => {
  it('forbids static <meta name="twitter:*"> in build-plugins/*.ts', () => {
    const offenders = findOffenders('build-plugins', STATIC_META_RE);
    if (offenders.length > 0) {
      const report = offenders.map((o) => `${o.file}:\n  ${o.lines.join('\n  ')}`).join('\n');
      throw new Error(
        `twitter:* meta re-introduced in build-plugins/*.ts:\n${report}\n` +
        `X is not a traffic source — see tests/seo/no-twitter-meta-dupes.test.ts.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('forbids client-side updateOrCreateMetaTag("name","twitter:*",…) in services/*.ts', () => {
    const offenders = findOffenders('services', RUNTIME_META_RE);
    if (offenders.length > 0) {
      const report = offenders.map((o) => `${o.file}:\n  ${o.lines.join('\n  ')}`).join('\n');
      throw new Error(
        `Client-side twitter:* meta re-introduced in services/*.ts:\n${report}\n` +
        `X is not a traffic source — see tests/seo/no-twitter-meta-dupes.test.ts.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
