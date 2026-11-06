/**
 * Regression gate for static X Card metadata.
 *
 * Static tags belong to the shared builder so page emitters cannot drift or
 * add a second copy. The builder's rendered output and override behavior are
 * checked by `seoPageShell-identities.test.ts`; the static page plugin test
 * below pins coverage across all three HTML templates. Runtime DOM injection
 * uses a job-only deduplicating updater under the owner contract of 2026-10-29;
 * scattered runtime updates remain prohibited.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STATIC_META_RE = /<meta\b(?=[^>]*\sname\s*=\s*(?:"twitter:[a-z][a-z0-9:_-]*"|'twitter:[a-z][a-z0-9:_-]*'|twitter:[a-z][a-z0-9:_-]*(?=\s|\/?>)))[^>]*>/gi;
const RUNTIME_META_RE = /updateOrCreateMetaTag\(\s*['"]name['"]\s*,\s*['"]twitter:[a-z][a-z0-9:_-]*['"]/gi;
const SHARED_TWITTER_META_SOURCE = 'build-plugins/shared/twitterCardMeta.ts';

type StaticMetaSource = { file: string; lines: string[] };

function matchStaticMeta(source: string): RegExpMatchArray[] {
  STATIC_META_RE.lastIndex = 0;
  return [...source.matchAll(STATIC_META_RE)];
}

function assertStaticMetaIsCentralized(offenders: StaticMetaSource[]): void {
  const scattered = offenders.filter((offender) => offender.file !== SHARED_TWITTER_META_SOURCE);
  if (scattered.length > 0) {
    const report = scattered.map((o) => `${o.file}:\n  ${o.lines.join('\n  ')}`).join('\n');
    throw new Error(
      `Static twitter:* tags must come from ${SHARED_TWITTER_META_SOURCE}:\n${report}`,
    );
  }
}

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

function findOffenders(root: string, re: RegExp, fastFilter: string) {
  const offenders: { file: string; lines: string[] }[] = [];
  for (const file of walkTs(root)) {
    const src = readFileSync(file, 'utf8');
    // Fast substring pre-filter — services/ has ~10k .ts files (146 MB), most
    // are blog/locale content with no meta code. Skipping them via an
    // includes() check turns this gate from ~minutes to <1 s.
    if (fastFilter && !src.toLowerCase().includes(fastFilter.toLowerCase())) continue;
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

describe('Twitter card metadata policy', () => {
  it('rejects copied tags with reordered and case-insensitive attributes', () => {
    const fixture = [
      "<META property='og:title' NAME = 'TWITTER:card' content='copied'>",
      '<meta content=summary NAME=TWITTER:title/>',
    ].join('\n');
    const matches = matchStaticMeta(fixture);
    expect(matches.map((match) => match[0])).toHaveLength(2);

    const candidate = {
      file: 'build-plugins/copiedMeta.ts',
      lines: matches.map((match) => match[0]),
    };
    expect(() => assertStaticMetaIsCentralized([candidate])).toThrow(/must come from/);
  });

  it('centralizes static tags in the shared builder and covers every static-page shell', () => {
    const offenders = findOffenders('build-plugins', STATIC_META_RE, 'twitter:');
    assertStaticMetaIsCentralized(offenders);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.file).toBe(SHARED_TWITTER_META_SOURCE);

    const shell = readFileSync('build-plugins/shared/seoPageShell.ts', 'utf8');
    expect(shell).toContain("import { buildTwitterCardMetaTags } from './twitterCardMeta';");
    expect(shell.match(/buildTwitterCardMetaTags\s*\(/g) ?? []).toHaveLength(1);

    const seoHubs = readFileSync('build-plugins/seoHubsPlugin.ts', 'utf8');
    expect(seoHubs).toContain("import { buildTwitterCardMetaTags } from './shared/twitterCardMeta';");
    expect(seoHubs.match(/const twitterCardMeta = buildTwitterCardMetaTags\s*\(/g) ?? []).toHaveLength(1);
    expect(seoHubs.match(/\$\{twitterCardMeta\}/g) ?? []).toHaveLength(1);

    const staticPages = readFileSync('build-plugins/staticPagesPlugin.ts', 'utf8');
    expect(staticPages).toContain("import { buildTwitterCardMetaTags } from './shared/twitterCardMeta';");
    expect(staticPages.match(/const twitterCardMeta = buildTwitterCardMetaTags\s*\(/g) ?? []).toHaveLength(1);
    const htmlTemplates = staticPages
      .split('return `<!DOCTYPE html>')
      .slice(1)
      .map((template) => template.split('</html>`', 1)[0] ?? '');
    expect(htmlTemplates).toHaveLength(3);
    for (const template of htmlTemplates) {
      expect(template.match(/\$\{twitterCardMeta\}/g) ?? []).toHaveLength(1);
    }
  });

  it('keeps scattered runtime tags absent and scopes the shared updater to job details', () => {
    const offenders = findOffenders('services', RUNTIME_META_RE, 'updateOrCreateMetaTag(');
    if (offenders.length > 0) {
      const report = offenders.map((o) => `${o.file}:\n  ${o.lines.join('\n  ')}`).join('\n');
      throw new Error(
        `Client-side twitter:* metadata is not part of the approved static-card contract:\n${report}`,
      );
    }
    expect(offenders).toEqual([]);
    const service = readFileSync('services/seoService.ts', 'utf8');
    expect(service.match(/updateJobTwitterCardMeta\(/g)).toHaveLength(1);
    expect(service).toMatch(/if \(isJobDetailPage\) \{\s*const jobOgImage[^;]+;\s*updateJobTwitterCardMeta\(/);
  });
});
