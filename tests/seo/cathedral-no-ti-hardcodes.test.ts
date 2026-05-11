import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

const ALLOWLIST = [
  'build-plugins/shared/cantonSection.ts',           // SECTION_LEGACY_TI definition
  'build-plugins/jobsSeoPagesPlugin.ts:772',         // sectionByLocale definition (legacy preservation)
  'build-plugins/jobsSeoPagesPlugin.ts:773',
  'build-plugins/jobsSeoPagesPlugin.ts:774',
  'build-plugins/jobsSeoPagesPlugin.ts:775',
  'build-plugins/jobsSeoPagesPlugin.ts:776',
  'build-plugins/jobBoardSeo.ts:38',                 // JOB_BOARD_LANDING_PATHS — TI legacy entry only
  'build-plugins/jobBoardSeo.ts:39',
  'build-plugins/jobBoardSeo.ts:40',
  'build-plugins/jobBoardSeo.ts:41',
  'tests/',                                          // tests reference literals for verification
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

function isAllowlisted(entry: { path: string; lineNo: number }): boolean {
  for (const allow of ALLOWLIST) {
    // "path:line" form — exact match
    if (allow.includes(':')) {
      const [allowPath, allowLine] = allow.split(':');
      if (entry.path === allowPath && entry.lineNo === parseInt(allowLine, 10)) return true;
    }
    // "path/" or "path" form — prefix match on path only (e.g. "tests/")
    else if (entry.path.startsWith(allow)) return true;
  }
  return false;
}

describe('cathedral — no TI URL hardcodes outside allowlist (P1-E boundary-safe)', () => {
  for (const literal of FORBIDDEN) {
    it(`literal ${literal} appears only in allowlisted locations`, () => {
      const cmd = `grep -rn -F ${JSON.stringify(literal)} build-plugins/ services/ scripts/lib/ || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      const offenders = out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((entry) => !isAllowlisted(entry))
        .map((e) => `${e.path}:${e.lineNo}: ${e.content}`);
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
