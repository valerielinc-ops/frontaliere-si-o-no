/**
 * THE INVARIANT, EXTENDED TO `functions/`: no scheduled Cloud Function trigger
 * bulk-mails `newsletter_subscribers` without consulting the consent gate.
 *
 * `tests/no-channel-mails-unconfirmed.test.ts` (#5686) polices every sender in
 * `scripts/*.mjs` — `discoverSenders()` (`tests/helpers/senders.ts`) scans that
 * directory ONLY, by design (its docblock: "the sender population is derived
 * from disk"). A scheduled trigger living in `functions/src/*.js` that
 * bulk-selects `newsletter_subscribers` would not be caught there. Flagged as
 * a deferred item on #5721's adversarial check (#5736): verified by hand that
 * no such trigger exists today (the three `onSchedule` exports in
 * `functions/index.js` all operate on `publisher_jobs`/`applications`, never
 * `newsletter_subscribers`) — this file turns that one-time verification into
 * a standing guard against it regressing.
 *
 * WHY A SOURCE SCAN, LIKE ITS `scripts/` COUNTERPART. `onSchedule` triggers
 * are wired at module scope in `functions/index.js` with live Firebase Admin
 * calls; importing that file would attempt real Firestore/Admin SDK
 * initialization outside an emulator. A scan is what can be written safely.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const INDEX_SRC = read('functions/index.js');

/** Every `export const X = onSchedule(...)` trigger, with its handler body. */
function discoverScheduledTriggers(): Array<{ name: string; body: string }> {
  const triggers: Array<{ name: string; body: string }> = [];
  const re = /export const (\w+) = onSchedule\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(INDEX_SRC))) {
    const closeIdx = INDEX_SRC.indexOf('\n);', m.index);
    triggers.push({ name: m[1], body: INDEX_SRC.slice(m.index, closeIdx) });
  }
  return triggers;
}

/** Every named import in `functions/index.js`, mapped to its `./src/...` file. */
function buildImportMap(): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s*\{([^}]*)\}\s*from\s*'(\.\/src\/[^']+)';/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(INDEX_SRC))) {
    const file = m[2].replace(/^\.\//, '');
    m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((name) => map.set(name, file));
  }
  return map;
}

/** Bulk (not doc-by-id) read of the newsletter_subscribers collection. */
const BULK_READ = /collection\('newsletter_subscribers'\)\s*\.\s*(get\(\)|where\()/;
const CALLS_GATE = /hasConfirmationProof\s*\(/;

describe('the detector itself', () => {
  // Verified against fixtures, not just production files: an it.each loop
  // whose body condition never fires on today's source would otherwise pass
  // vacuously if the regexes were broken (same failure mode the `scripts/`
  // scan guards against with its own "found the senders at all" canary).
  it('flags a bulk read with no gate', () => {
    const fixture = "const snap = await db.collection('newsletter_subscribers').get();";
    expect(BULK_READ.test(fixture)).toBe(true);
    expect(CALLS_GATE.test(fixture)).toBe(false);
  });

  it('does not flag a doc-by-id read', () => {
    const fixture = "await db.collection('newsletter_subscribers').doc(email).set(patch, { merge: true });";
    expect(BULK_READ.test(fixture)).toBe(false);
  });

  it('recognises a gated bulk read', () => {
    const fixture =
      "const snap = await db.collection('newsletter_subscribers').where('status', '==', 'confirmed').get();\n" +
      'const eligible = snap.docs.filter((d) => hasConfirmationProof(d.data()));';
    expect(BULK_READ.test(fixture)).toBe(true);
    expect(CALLS_GATE.test(fixture)).toBe(true);
  });
});

describe('no scheduled functions/ trigger bulk-mails newsletter_subscribers unconfirmed', () => {
  const triggers = discoverScheduledTriggers();
  const importMap = buildImportMap();

  it('the discovery found the scheduled triggers at all', () => {
    // Guards the scan: a broken regex would otherwise leave the it.each below
    // with zero cases, passing vacuously.
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.map((t) => t.name)).toContain('purgePublisherApplications');
  });

  it.each(triggers)('$name: every function it calls that bulk-reads newsletter_subscribers consults the gate', ({ body }) => {
    const calledNames = [...body.matchAll(/\b(\w+)\(/g)].map((m) => m[1]);
    const files = new Set(
      calledNames.map((n) => importMap.get(n)).filter((f): f is string => Boolean(f)),
    );
    for (const file of files) {
      const src = read(`functions/${file}`);
      if (!BULK_READ.test(src)) continue;
      expect(
        src,
        `${file} bulk-reads newsletter_subscribers from a scheduled trigger — it must consult hasConfirmationProof()`,
      ).toMatch(CALLS_GATE);
      // `.js` as well as `.mjs`: a Cloud Function CANNOT import
      // `services/subscriberConsent.mjs` — no bundler, and nothing outside
      // `functions/` ships — so the only shared gate reachable from here is
      // `functions/src/lib/subscriberConsent.js`, which is where the single
      // definition has lived since #5692 (the `services/` path is its
      // re-export). Demanding the `.mjs` spelling asked a `functions/` file for
      // an import that cannot resolve, so the day a scheduled trigger DID
      // consult the gate this assertion would have failed it for complying.
      expect(src, `${file} must import the shared gate, never a local copy`).toMatch(
        /from ['"][^'"]*subscriberConsent\.m?js['"]/,
      );
      expect(src).not.toMatch(/function hasConfirmationProof/);
    }
  });
});
