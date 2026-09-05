import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

// Allowlist — any line that legitimately references a TI legacy section
// literal. Every TI hardcode below has been audited as either (a) a
// fallback default in a per-plugin SECTION_SLUG table, or (b) a TI-only
// data structure (router slugs, section→label maps, hub-chrome) where
// the literal IS the canonical name for TI.
//
// IMPORTANT: never add a NEW entry here without first confirming the
// hardcode is correct legacy preservation. New canton-aware code should
// import resolveCantonSection() from build-plugins/shared/cantonSection.
const ALLOWLIST = [
  // Issue #7491: le voci pinnate `path:riga` erano ~45 e sono state cancellate
  // tutte. Dopo il collasso su `SECTION_LEGACY_TI` ogni occorrenza rimasta
  // dentro SCAN_DIRS porta un marker ` // cathedral-allow: <ragione>` inline, e
  // le righe pinnate non contenevano piu' il literal: era una lista morta i cui
  // commenti di riancoraggio storico («Lines shifted +1 …») descrivevano righe
  // che non esistono piu'. Il meccanismo inline e' l'unico, come il messaggio
  // d'errore di questo file dichiara da sempre.
  //
  // NON reintrodurre voci pinnate per numero di riga: si sfasano al primo
  // refactor e allora allowlistano la riga sbagliata.
  // Le uniche voci per FILE che restano: due posti dove il marker inline non e'
  // materialmente possibile.
  //
  // cantonSection.ts: e' lo shim tipizzato della tabella canonica e cita i
  // quattro literal solo dentro i propri docblock, per spiegare cosa esporta.
  'build-plugins/shared/cantonSection.ts',
  // section-shard-slugs.json: JSON non ammette commenti, quindi un marker
  // inline non e' esprimibile. Qui il literal E' il dato canonico del
  // meccanismo di shard per sezione, non un hardcode che scappa.
  'scripts/lib/section-shard-slugs.json',
  // I test citano i literal per verificarli.
  'tests/',
];

// ── Scan surface ────────────────────────────────────────────────────────────
// Issue #7491: this guard used to grep only build-plugins/, services/ and
// scripts/lib/. That was the whole defect. The TI section table had been
// re-declared in 53 source files (78 declarations) and the guard could see
// barely half of them, because the other half sat in scripts/ proper, in
// components/, in App.tsx, in the Cloud Functions tree and in the Worker —
// all outside those three directories. Every copy that grew, grew here.
//
// Adding a directory to this list is how the guard keeps up with the repo.
// packages/articles/content/ is deliberately absent: it is generated article
// prose that legitimately quotes TI job-board URLs by the hundred, and
// dist/ + node_modules/ are build output.
const SCAN_DIRS = [
  'App.tsx',
  'build-plugins/',
  'components/',
  'functions/src/',
  'hooks/',
  'infra/',
  'scripts/',
  'server/',
  'services/',
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

// Inline-annotation marker (2026-05-18, definitive fix). Any line whose
// content carries this marker is auto-skipped by the audit — the marker
// travels WITH the code as it shifts, so the test never breaks on a
// harmless line-number drift in an unrelated PR.
//
// Usage in source: append ` // cathedral-allow: <one-line reason>` to the
// line. The marker is checked CASE-SENSITIVELY and must appear in the
// content (after the `path:line:` prefix grep emits).
//
// The ALLOWLIST array above is preserved as a transitional safety net for
// lines that have not yet been migrated to inline annotations. New
// hardcodes MUST use the inline marker — do NOT add new entries to
// ALLOWLIST.
const INLINE_ALLOW_MARKER = /\bcathedral-allow\b/;

function hasInlineAllow(content: string): boolean {
  return INLINE_ALLOW_MARKER.test(content);
}

function isAllowlisted(entry: { path: string; lineNo: number; content: string }): boolean {
  // 1) Inline annotation — travels with the line, never drifts.
  if (hasInlineAllow(entry.content)) return true;
  // 2) Legacy line-pinned allowlist — kept as transitional safety net.
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
    // Explicit timeout (vs the 15000ms project default, vitest.config.ts) —
    // this shells out to `grep -rn` synchronously over SCAN_DIRS; under CI's
    // parallel test-worker contention that occasionally exceeds 15s even
    // though the command itself runs in well under 1s in isolation (run
    // 29904198494/job 88871620100 timed out here with no real hardcode
    // offender — a CI-load timeout, not a genuine failure).
    it(`literal ${literal} appears only in allowlisted locations`, () => {
      const cmd = `grep -rn -F ${JSON.stringify(literal)} ${SCAN_DIRS.join(' ')} || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      const offenders = out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((entry) => !isAllowlisted(entry))
        .map((e) => `${e.path}:${e.lineNo}: ${e.content}`);
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}\n\nTo allowlist a NEW hardcode, append \` // cathedral-allow: <reason>\` to the offending line — do not add new line-pinned entries to ALLOWLIST.`).toEqual([]);
    }, 30000);
  }
});
