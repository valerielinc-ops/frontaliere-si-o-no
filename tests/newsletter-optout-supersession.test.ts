/**
 * tests/newsletter-optout-supersession.test.ts — #5711
 *
 * `unsubscribed_at` is append-only from #5711 on: nothing deletes it, because
 * deleting it destroyed the record that the person had opted out — the evidence
 * an art. 25 request asks for, and the signal the 186 resurrections of #5672
 * were found by.
 *
 * That moves the whole question onto the READERS. Before, "carries a stamp"
 * meant "do not mail"; now it means "did an explicit re-opt-in land after it?"
 * Two things have to be true for that to be safe, and both are asserted here:
 *
 *   1. the rule lifts an opt-out ONLY for a strictly later `resubscribed_at`,
 *      never for a later `confirmed_at` — all 186 resurrected documents carry a
 *      newer `confirmed_at`, so that rule would exempt exactly the cohort the
 *      guard exists for;
 *   2. the two copies of the rule agree. services/newsletterOptOut.mjs is the
 *      canonical one; functions/src/lib/newsletterOptOut.js is a pinned mirror,
 *      because the Cloud Functions bundle cannot import outside `functions/`.
 *      The fixture table below runs through BOTH.
 *
 * Every address here is on example.com — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as canonical from '../services/newsletterOptOut.mjs';
import * as mirror from '../functions/src/lib/newsletterOptOut.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = '2026-08-01T09:00:00.000Z';
const T1 = '2026-08-02T09:00:00.000Z';

/** A Firestore Timestamp, as the admin SDK hands it back. */
const ts = (iso: string) => ({ toMillis: () => Date.parse(iso) });

type Case = { name: string; doc: any; binding: boolean };

const CASES: Case[] = [
  { name: 'never touched', doc: { email: 'a@example.com', status: 'confirmed' }, binding: false },
  { name: 'no document at all', doc: null, binding: false },
  { name: 'status unsubscribed, no stamp', doc: { status: 'unsubscribed' }, binding: true },
  { name: 'snake_case stamp only (the CF path)', doc: { status: 'pending', unsubscribed_at: T0 }, binding: true },
  { name: 'camelCase stamp only (the 458 SPA documents)', doc: { status: 'pending', unsubscribedAt: T0 }, binding: true },
  { name: 'stamp as a Firestore Timestamp', doc: { status: 'pending', unsubscribed_at: ts(T0) }, binding: true },
  { name: 'stamp as a Date', doc: { status: 'pending', unsubscribed_at: new Date(T0) }, binding: true },
  {
    name: 'later re-opt-in lifts it',
    doc: { status: 'confirmed', unsubscribed_at: T0, resubscribed_at: T1 },
    binding: false,
  },
  {
    name: 'later re-opt-in in camelCase lifts it too',
    doc: { status: 'confirmed', unsubscribedAt: T0, resubscribedAt: T1 },
    binding: false,
  },
  {
    name: 'mixed spellings and mixed shapes still order correctly',
    doc: { status: 'confirmed', unsubscribedAt: ts(T0), resubscribed_at: new Date(T1) },
    binding: false,
  },
  {
    name: 'EARLIER re-opt-in does not lift it',
    doc: { status: 'confirmed', unsubscribed_at: T1, resubscribed_at: T0 },
    binding: true,
  },
  {
    name: 'SIMULTANEOUS does not lift it — strictly later, or nothing',
    doc: { status: 'confirmed', unsubscribed_at: T0, resubscribed_at: T0 },
    binding: true,
  },
  {
    name: 'a later confirmed_at lifts NOTHING — the shape of all 186 resurrections',
    doc: { status: 'confirmed', unsubscribed_at: T0, confirmed_at: T1, confirmedAt: T1 },
    binding: true,
  },
  {
    name: 'status unsubscribed wins over any stamp ordering',
    doc: { status: 'unsubscribed', unsubscribed_at: T0, resubscribed_at: T1 },
    binding: true,
  },
  {
    name: 'unreadable re-opt-in stamp fails CLOSED',
    doc: { status: 'confirmed', unsubscribed_at: T0, resubscribed_at: 'not-a-date' },
    binding: true,
  },
  {
    name: 'unreadable opt-out stamp is still an opt-out (present ≠ orderable)',
    doc: { status: 'confirmed', unsubscribed_at: 'not-a-date', resubscribed_at: T1 },
    binding: true,
  },
  {
    name: 're-opt-in with no opt-out at all is not "superseded", just clean',
    doc: { status: 'confirmed', resubscribed_at: T1 },
    binding: false,
  },
  {
    name: 'an unresolved serverTimestamp sentinel is not a timestamp',
    doc: { status: 'confirmed', unsubscribed_at: T0, resubscribed_at: { _methodName: 'serverTimestamp' } },
    binding: true,
  },
];

describe('isNewsletterOptOutBinding — the supersession rule', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.binding ? 'binding' : 'not binding'}`, () => {
      expect(canonical.isNewsletterOptOutBinding(c.doc)).toBe(c.binding);
    });
  }
});

describe('the Cloud Functions mirror agrees with the canonical module, case by case', () => {
  it('same verdict on every fixture', () => {
    const divergent = CASES.filter(
      (c) => canonical.isNewsletterOptOutBinding(c.doc) !== mirror.isNewsletterOptOutBinding(c.doc),
    ).map((c) => c.name);
    expect(divergent, 'the pinned mirror has drifted — change both in the same PR').toEqual([]);
  });

  it('same timestamp coercion, including the shapes that must yield null', () => {
    const values: unknown[] = [
      T0, new Date(T0), ts(T0), Date.parse(T0), null, undefined, 'not-a-date', {}, NaN,
      { seconds: 1754038800, nanoseconds: 0 },
      { _seconds: 1754038800, _nanoseconds: 0 },
    ];
    for (const v of values) {
      expect(mirror.toEpochMillis(v), `divergence on ${JSON.stringify(v)}`)
        .toEqual(canonical.toEpochMillis(v));
    }
  });

  it('the mirror declares itself a mirror, so the next reader knows where to edit', () => {
    expect(read('functions/src/lib/newsletterOptOut.js')).toMatch(/PINNED MIRROR of services\/newsletterOptOut\.mjs/);
  });
});

describe('the senders consult the shared predicate rather than re-deriving it', () => {
  // Not style: the two spellings of #5673 drifted apart precisely because the
  // rule was copied into each reader. A reader still testing the bare stamp
  // would now suppress everyone who ever came back.
  const READERS = [
    'scripts/send-newsletter.mjs',
    'scripts/send-onboarding-drip.mjs',
  ];

  for (const rel of READERS) {
    it(`${rel} imports it`, () => {
      expect(read(rel)).toMatch(/from '\.\.\/services\/newsletterOptOut\.mjs'/);
    });

    it(`${rel} no longer gates on a bare opt-out stamp`, () => {
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src).not.toMatch(/if\s*\([^)]*\.unsubscribedAt\s*\|\|[^)]*\.unsubscribed_at[^)]*\)/);
      expect(src).not.toMatch(/if\s*\([^)]*\.unsubscribed_at\s*\|\|[^)]*\.unsubscribedAt[^)]*\)/);
    });
  }

  it('the preferences page reads it too — it is the surface that ANSWERS "am I subscribed?"', () => {
    expect(read('functions/src/newsletterSubscriptionManagement.js'))
      .toMatch(/isNewsletterOptOutBinding\(data\)/);
  });
});
