/**
 * The SERP experiment's arm list is written out by hand in three places that
 * never import each other — the autopilot that promotes an arm
 * (scripts/seo-serp-autopilot.mjs), the client that renders it
 * (services/seoService.ts), and the fallback the client serves when the
 * public-config fetch fails (services/firebase.ts). Nothing links them, so a
 * third arm added in one place is simply ignored by the others, and a typo in
 * the fallback silently drops the visitor out of the experiment.
 *
 * The files are read as text rather than imported: importing services/firebase.ts
 * pulls in the Firebase SDK, and the autopilot runs main() at module scope.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not process.cwd(), so the test does not depend on
// where the runner was launched from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

function autopilotVariants(): string[] {
  const m = /const VARIANTS = \[([^\]]+)\]/.exec(read('scripts/seo-serp-autopilot.mjs'));
  if (!m) throw new Error('VARIANTS not found in scripts/seo-serp-autopilot.mjs');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every `x === 'a' || x === 'b'` variant guard in the client, keyed by its subject. */
function clientAcceptedVariants(): Record<string, string[]> {
  const src = read('services/seoService.ts');
  // The subject is a bare identifier on the Remote Config path (`variantRaw`)
  // and a property access on the cache path (`cached.variant`). `\w+` stops at
  // the dot, so the backreference could not find the same text again and the
  // cache guard went silently uncovered — the exact drift this file exists to
  // catch, hiding in the check meant to catch it.
  const re = /([\w.]+)\s*===\s*'(year_intent|intent_simulation)'\s*\|\|\s*\1\s*===\s*'(year_intent|intent_simulation)'/g;
  const out: Record<string, string[]> = {};
  for (const m of src.matchAll(re)) out[m[1]] = [m[2], m[3]].sort();
  return out;
}

function clientFallbackVariant(): string {
  const m = /SEO_SERP_EXPERIMENT_VARIANT:\s*'([^']+)'/.exec(read('services/firebase.ts'));
  if (!m) throw new Error('SEO_SERP_EXPERIMENT_VARIANT not found in services/firebase.ts');
  return m[1];
}

describe('SERP experiment arm list agreement', () => {
  it('both client paths accept exactly the arms the autopilot can promote', () => {
    const promotable = autopilotVariants().sort();
    const guards = clientAcceptedVariants();
    // Named, not counted: a guard that disappears has to fail this test rather
    // than quietly shrink the set the loop then walks.
    expect(Object.keys(guards).sort()).toEqual(['cached.variant', 'variantRaw']);
    for (const [subject, accepted] of Object.entries(guards)) {
      expect(accepted, `guard on ${subject}`).toEqual(promotable);
    }
  });

  it('the public-config fallback is an arm the client understands', () => {
    // A value outside this set is coerced away at parse time, so the visitor
    // whose config fetch failed would silently leave the experiment.
    expect(autopilotVariants()).toContain(clientFallbackVariant());
  });

  it('the fallback is a real arm, never the control baseline', () => {
    // 'control' would disable the experiment for exactly those visitors,
    // including a crawler that failed to load the public config.
    expect(clientFallbackVariant()).not.toBe('control');
  });
});
