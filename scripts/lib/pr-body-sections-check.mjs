/**
 * pr-body-sections-check.mjs — Deterministic validator for PR body SECTION
 * CONTENT quality. ZERO Claude (pure regex+string). Companion to
 * pr-body-closes-check.mjs.
 *
 * Problem (escalation #3250, bucket `reviewer-finding/pr-body-contract` 6×/14d):
 * pr-body-contract.yml checks only that the two required headers are PRESENT,
 * not that they contain substantive content. The PR template leaves bare `- `
 * placeholder bullets in both sections; a fixer that submits without filling them
 * passes the CI gate but triggers a 🔴 reviewer finding — wasting a review cycle.
 *
 * This module closes the gap: it validates content quality so fixers can catch the
 * error locally BEFORE `gh pr create`. The exported functions are unit-tested and
 * mirror the modulo-condiviso pattern of pr-body-closes-check.mjs — they can be
 * inlined into a future pr-body-contract.yml step once that workflow can be updated
 * (requires PAT with `workflows` scope, separate PR).
 *
 * CHECKS:
 * 1. `## Implementato` present with the exact canonical header name.
 *    (catches `## Summary`, `## Fix`, `## Verify`, etc.)
 * 2. `## Non implementato (ancora)` present WITH "(ancora)".
 *    (pr-body-contract.yml regex matches without "(ancora)", but the reviewer
 *    expects the canonical name and the template enforces it.)
 * 3. `## Implementato` section has ≥1 substantive bullet (not just bare `- `
 *    from the template placeholder) OR non-empty prose.
 * 4. `## Non implementato (ancora)` section has valid content: either the word
 *    "Nessuno" (task complete, per AGENTS.md #8) OR ≥1 substantive bullet.
 *
 * Usage:
 *   node scripts/lib/pr-body-sections-check.mjs "$BODY"   # exit 1 on violation
 *   echo "$BODY" | node scripts/lib/pr-body-sections-check.mjs
 *   node scripts/lib/pr-body-sections-check.mjs --json "$BODY"
 *
 * Returns: { ok: boolean, violations: Violation[] }
 * Each Violation: { type: string, section?: string, message: string }
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported — imported by unit tests and future CI callers)
// ---------------------------------------------------------------------------

/**
 * Extract the section body between `headerRe` and the next markdown heading (or EoF).
 * The header match itself is NOT included.  Returns null if the header is absent.
 *
 * @param {string} body full PR body text
 * @param {RegExp} headerRe must be non-global; the first match is used
 * @returns {string|null}
 */
export function extractSection(body, headerRe) {
  const m = headerRe.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const nextHeading = /\n(?=#{1,6}[ \t])/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/**
 * Strip HTML comments and fenced code blocks so we don't treat template
 * comments or example snippets as real content.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripNonContent(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * True iff `line` is a markdown bullet that has text beyond the marker.
 * A bare `- ` (or `* ` / `+ `) with nothing after counts as an EMPTY placeholder.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isSubstantiveBullet(line) {
  const stripped = line.replace(/^[ \t]*[-*+][ \t]*/, '').trim();
  return stripped.length > 0;
}

/**
 * True iff the section text (with non-content stripped) contains at least one
 * substantive bullet OR non-empty non-heading prose.
 *
 * @param {string} rawContent section text (after the header, before the next heading)
 * @returns {boolean}
 */
export function hasMeaningfulContent(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  return clean.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#{1,6}[ \t]/.test(trimmed)) return false; // heading line (shouldn't appear mid-section)
    // Match a bullet marker followed by space/tab OR at end of line (bare `-`)
    if (/^[-*+](?:[ \t]|$)/.test(trimmed)) return isSubstantiveBullet(trimmed);
    return true; // non-bullet, non-heading, non-empty prose → meaningful
  });
}

/**
 * True iff the section contains ONLY bare placeholder bullets and/or whitespace/comments.
 * Useful for a more precise error message.
 *
 * @param {string} rawContent
 * @returns {boolean}
 */
export function hasOnlyBareBullets(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false; // empty, not "only bare bullets"
  return lines.every((line) => {
    const trimmed = line.trim();
    if (/^#{1,6}[ \t]/.test(trimmed)) return true; // skip any stray headings
    if (/^[-*+][ \t]?$/.test(trimmed)) return true; // bare bullet marker with no text
    if (/^[-*+][ \t]/.test(trimmed)) return false; // bullet WITH text
    return true; // pure whitespace / other structural char → not "content"
  });
}

/**
 * True iff `rawContent` (after stripping HTML comments and code blocks) contains
 * the canonical "Nessuno" marker accepted by AGENTS.md #8 as "task complete, no
 * deferred scope".  Case-insensitive; accepts "Nessuno" / "Nessuna" / "Nessuno."
 *
 * @param {string} rawContent
 * @returns {boolean}
 */
export function hasNessuno(rawContent) {
  const clean = stripNonContent(rawContent ?? '');
  return /\bnessun[oa]?\b/i.test(clean);
}

// ---------------------------------------------------------------------------
// Combined validator
// ---------------------------------------------------------------------------

const IMPL_RE = /^[ \t]{0,3}#{2,3}[ \t]+Implementato\b/im;
const NON_IMPL_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*\(ancora\)/im;
const NON_IMPL_NO_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato\b/im;

/**
 * Check a PR body for section-content quality violations.
 *
 * @param {string} body full PR body text
 * @returns {{ ok: boolean, violations: Array<{type:string,section?:string,message:string}> }}
 */
export function checkPrBodySections(body = '') {
  const s = String(body ?? '');
  const violations = [];

  // --- 1. Required header: ## Implementato ------------------------------------
  const hasImpl = IMPL_RE.test(s);
  if (!hasImpl) {
    violations.push({
      type: 'missing-implementato',
      message:
        'Manca `## Implementato` (header letterale richiesto da REVIEW.md; ' +
        'non usare `## Summary`, `## Fix`, `## Verify`, `## Effetto`, etc.).',
    });
  }

  // --- 2. Required header: ## Non implementato (ancora) ----------------------
  const hasNonImplAncora = NON_IMPL_ANCORA_RE.test(s);
  if (!hasNonImplAncora) {
    const hasNonImplWithout = NON_IMPL_NO_ANCORA_RE.test(s);
    if (hasNonImplWithout) {
      violations.push({
        type: 'missing-ancora',
        section: 'Non implementato',
        message:
          '`## Non implementato` manca di "(ancora)": usa l\'header canonico ' +
          '`## Non implementato (ancora)` (come nella PR template e nel contratto REVIEW.md).',
      });
    } else {
      violations.push({
        type: 'missing-non-implementato',
        message:
          'Manca `## Non implementato (ancora)` (header letterale richiesto da REVIEW.md).',
      });
    }
  }

  // --- 3. ## Implementato section content ------------------------------------
  if (hasImpl) {
    const content = extractSection(s, IMPL_RE) ?? '';
    if (!hasMeaningfulContent(content)) {
      if (hasOnlyBareBullets(content)) {
        violations.push({
          type: 'empty-implementato',
          section: 'Implementato',
          message:
            '`## Implementato` contiene solo bullet placeholder vuoti (`- `) non compilati. ' +
            'Sostituisci ogni `- ` con una descrizione concreta del cambiamento (file / comportamento).',
        });
      } else {
        violations.push({
          type: 'empty-implementato',
          section: 'Implementato',
          message:
            '`## Implementato` è vuota. ' +
            'Aggiungi almeno un bullet che descriva cosa fa la PR (file / comportamento cambiato).',
        });
      }
    }
  }

  // --- 4. ## Non implementato (ancora) section content -----------------------
  if (hasNonImplAncora) {
    const content = extractSection(s, NON_IMPL_ANCORA_RE) ?? '';
    if (!hasNessuno(content) && !hasMeaningfulContent(content)) {
      if (hasOnlyBareBullets(content)) {
        violations.push({
          type: 'empty-non-implementato',
          section: 'Non implementato (ancora)',
          message:
            '`## Non implementato (ancora)` contiene solo bullet placeholder vuoti (`- `) non compilati. ' +
            'Scrivi "Nessuno" (task completo) oppure elenca gli item residui con stato/next-step.',
        });
      } else {
        violations.push({
          type: 'empty-non-implementato',
          section: 'Non implementato (ancora)',
          message:
            '`## Non implementato (ancora)` è vuota. ' +
            'Scrivi "Nessuno" (task completo) oppure elenca gli item residui.',
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// CLI entrypoint (guard: only when invoked directly, not when imported)
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const JSON_OUT = argv.includes('--json');
  const bodyArg = argv.filter((a) => !a.startsWith('--'))[0];

  const run = (body) => {
    const res = checkPrBodySections(body);
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (res.ok) {
      process.stdout.write('✓ PR body sections OK — Implementato e Non implementato (ancora) presenti e compilati.\n');
    } else {
      for (const v of res.violations) {
        process.stderr.write(`✗ [${v.type}] ${v.message}\n`);
      }
      process.exitCode = 1;
    }
  };

  if (typeof bodyArg === 'string') {
    run(bodyArg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf));
  }
}
