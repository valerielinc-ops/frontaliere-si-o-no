/**
 * Regression gate: forbid `<meta name="twitter:(title|description|url|image|image:src)">`
 * emissions in build-plugins/*.ts.
 *
 * Why: X (Twitter) falls back to og:title / og:description / og:url /
 * og:image when the twitter:* equivalent is absent. Emitting both
 * doubles the meta bytes on every page (~140 MB across 825k pages on
 * the May 21 2026 artifact). The codemod that removed these from the
 * 26 plugins must not be reverted file-by-file as new plugins land.
 *
 * Allow-list — these stay because they have NO og:* fallback:
 *   - twitter:card           — controls X card layout (summary vs. summary_large_image)
 *   - twitter:site           — X account attribution
 *   - twitter:creator        — content author attribution
 *   - twitter:image:alt      — accessibility for the X card image
 *   - twitter:player, twitter:app:* — distinct surfaces
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'build-plugins';

const FORBIDDEN = /<meta\s+name="twitter:(?:title|description|url|image|image:src)"/g;

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

describe('no twitter:* duplicates in build-plugins/*.ts', () => {
  it('forbids twitter:title/description/url/image/image:src in any plugin', () => {
    const offenders: { file: string; lines: string[] }[] = [];
    for (const file of walkTs(ROOT)) {
      const src = readFileSync(file, 'utf8');
      const matches = [...src.matchAll(FORBIDDEN)];
      if (matches.length === 0) continue;
      const lines = src.split('\n');
      const hits = matches.map((m) => {
        const upto = src.slice(0, m.index ?? 0);
        const lineNo = upto.split('\n').length;
        return `${lineNo}: ${lines[lineNo - 1]?.trim() ?? ''}`;
      });
      offenders.push({ file, lines: hits });
    }
    if (offenders.length > 0) {
      const report = offenders.map((o) =>
        `${o.file}:\n  ${o.lines.join('\n  ')}`,
      ).join('\n');
      throw new Error(
        `twitter:* duplicates re-introduced in build-plugins/*.ts:\n${report}\n` +
        `X falls back to og:* — remove these meta tags. See tests/seo/no-twitter-meta-dupes.test.ts.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
