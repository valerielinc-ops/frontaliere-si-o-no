import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

// Allowlist — drift-proof file/directory prefixes ONLY.
//
// Every per-line exception MUST live in the source file itself as an inline
// `// cathedral-allow: <reason>` marker (for code lines) or
// ` cathedral-allow: <reason>` suffix (for JSDoc/`*`-prefixed lines). Inline
// markers travel with the code as it shifts, so unrelated PRs that add or
// remove lines never break this gate.
//
// Why no more line-pinned entries here? They drifted on every refactor:
// adding one import shifted 60+ entries by 1, requiring a coordinated bump
// in this test. Migrated entirely to inline markers on 2026-05-21 — see
// commit history for the conversion. If you need to allow a NEW hardcode,
// add the inline marker; do NOT add a new entry to this array.
//
// IMPORTANT: never allow a TI URL hardcode outside of the legitimate
// legacy preservation pattern (per-plugin SECTION_SLUG fallback table,
// router slug table, hub-chrome registry, jsdoc reference, or TI-only
// data structure). New canton-aware code MUST import
// `resolveCantonSection()` from `build-plugins/shared/cantonSection`.
const ALLOWLIST = [
  // Canton-section helper itself: defines the TI legacy section table.
  'build-plugins/shared/cantonSection.ts',
  // Tests reference literals for verification.
  'tests/',
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

// Inline-annotation marker. Any line whose content carries this marker is
// auto-skipped by the audit — the marker travels WITH the code as it shifts,
// so the test never breaks on a harmless line-number drift in an unrelated
// PR.
//
// Usage in source:
//   - Code line:   append ` // cathedral-allow: <one-line reason>`
//   - JSDoc line:  append ` cathedral-allow: <one-line reason>` (no `//`,
//                  the `*`-prefixed line is already inside a comment)
const INLINE_ALLOW_MARKER = /\bcathedral-allow\b/;

function hasInlineAllow(content: string): boolean {
  return INLINE_ALLOW_MARKER.test(content);
}

function isAllowlisted(entry: { path: string; lineNo: number; content: string }): boolean {
  // 1) Inline annotation — travels with the line, never drifts.
  if (hasInlineAllow(entry.content)) return true;
  // 2) Path prefix (file or directory).
  for (const allow of ALLOWLIST) {
    if (entry.path === allow || entry.path.startsWith(allow)) return true;
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
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}\n\nTo allowlist a NEW hardcode, append \` // cathedral-allow: <reason>\` to the offending line (or \` cathedral-allow: <reason>\` on a JSDoc/\`*\`-prefixed line). Do NOT add a new entry to ALLOWLIST.`).toEqual([]);
    });
  }
});
