/**
 * tests/resubscribe-pairs.test.ts — #5711, the measurement
 *
 * The count the issue asks for cannot be taken the way the 186 resurrections of
 * #5672 were counted. That query looked for documents carrying `unsubscribed_at`
 * that are nevertheless active, and until #5711 a re-subscription DELETED the
 * stamp: the production case that opened the issue (opt-out 12:40:53 → active
 * 12:40:55, `source_channel: resubscribe_link`) reads back with
 * `unsubscribed_at: null`. The faster the reactivation, the cleaner the document.
 *
 * What survives is the append-only `events` subcollection, so the measurement
 * runs on PAIRS there. This file tests the pairing rule against fixtures; it
 * needs no credentials and touches no network, which is the reason the rule was
 * extracted out of scripts/audit-resubscribe-pairs.mjs in the first place.
 *
 * Every address here is on example.com — the repo is public.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRapidResubscribePairs,
  summarizePairs,
  DEFAULT_WINDOW_SECONDS,
} from '../scripts/lib/resubscribePairs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const at = (iso: string) => ({ occurred_at: iso });

/** The production sequence from the issue, to the second. */
const SCANNER_TRAIL = [
  { email: 'scanned@example.com', event_type: 'send', ...at('2026-08-12T12:40:03.000Z') },
  { email: 'scanned@example.com', event_type: 'delivered', ...at('2026-08-12T12:40:04.000Z') },
  {
    email: 'scanned@example.com',
    event_type: 'unsubscribe',
    source_channel: 'unsubscribe_link',
    unsubscribe_user_agent: 'SafeLinksScanner/1.0',
    ...at('2026-08-12T12:40:53.500Z'),
  },
  {
    email: 'scanned@example.com',
    event_type: 'subscribe_completed',
    source_channel: 'resubscribe_link',
    ...at('2026-08-12T12:40:55.000Z'),
  },
];

describe('findRapidResubscribePairs', () => {
  it('finds the production case, with the gap the issue measured', () => {
    const pairs = findRapidResubscribePairs(SCANNER_TRAIL);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      email: 'scanned@example.com',
      optOutType: 'unsubscribe',
      reOptInType: 'subscribe_completed',
      gapMs: 1500,
      sourceChannel: 'resubscribe_link',
      userAgent: 'SafeLinksScanner/1.0',
    });
  });

  it('ignores unrelated event types entirely — send/delivered are not a pair', () => {
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'send', ...at('2026-08-12T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'delivered', ...at('2026-08-12T10:00:01.000Z') },
      { email: 'a@example.com', event_type: 'open', ...at('2026-08-12T10:00:02.000Z') },
    ]);
    expect(pairs).toEqual([]);
  });

  it('does not pair a re-subscription that came LATER than the window', () => {
    const pairs = findRapidResubscribePairs([
      { email: 'human@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'human@example.com', event_type: 'subscribe_completed', ...at('2026-08-01T10:05:00.000Z') },
    ]);
    expect(pairs).toEqual([]);
  });

  it('honours a widened window', () => {
    const events = [
      { email: 'human@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'human@example.com', event_type: 'subscribe_completed', ...at('2026-08-01T10:05:00.000Z') },
    ];
    expect(findRapidResubscribePairs(events, { windowSeconds: 600 })).toHaveLength(1);
  });

  it('never pairs BACKWARDS — a re-subscription before the opt-out is not a reversal', () => {
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'subscribe_completed', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:01.000Z') },
    ]);
    expect(pairs).toEqual([]);
  });

  it('keeps two separate opt-out/re-opt-in cycles separate', () => {
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'subscribe_completed', ...at('2026-08-01T10:00:01.000Z') },
      { email: 'a@example.com', event_type: 'unsubscribe', ...at('2026-09-01T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'subscribe_completed', ...at('2026-09-01T10:00:02.000Z') },
    ]);
    expect(pairs.map((p) => p.gapMs).sort((x, y) => x - y)).toEqual([1000, 2000]);
  });

  it('does not cross addresses', () => {
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'b@example.com', event_type: 'subscribe_completed', ...at('2026-08-01T10:00:01.000Z') },
    ]);
    expect(pairs).toEqual([]);
  });

  it('covers the preference-centre and double-opt-in event names too', () => {
    // A measurement that only counted `subscribe_completed` would under-report
    // by exactly the routes nobody thought to look at — the mistake #5673 made
    // with the two spellings of the stamp.
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'subscription_unsubscribed', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'subscription_resubscribed', ...at('2026-08-01T10:00:03.000Z') },
      { email: 'b@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      { email: 'b@example.com', event_type: 'confirm', ...at('2026-08-01T10:00:04.000Z') },
    ]);
    expect(pairs).toHaveLength(2);
  });

  it('reads a Firestore Timestamp when occurred_at is absent, and drops what it cannot read', () => {
    const stamp = (iso: string) => ({ toMillis: () => Date.parse(iso) });
    const pairs = findRapidResubscribePairs([
      { email: 'a@example.com', event_type: 'unsubscribe', timestamp: stamp('2026-08-01T10:00:00.000Z') },
      { email: 'a@example.com', event_type: 'subscribe_completed', timestamp: stamp('2026-08-01T10:00:01.000Z') },
      { email: 'b@example.com', event_type: 'unsubscribe' },
      { email: 'b@example.com', event_type: 'subscribe_completed' },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].email).toBe('a@example.com');
  });

  it('tolerates junk input instead of throwing mid-scan', () => {
    expect(findRapidResubscribePairs(null as any)).toEqual([]);
    expect(findRapidResubscribePairs([null, undefined, {}, { email: '' }] as any)).toEqual([]);
  });
});

describe('summarizePairs', () => {
  it('buckets by gap and reports the discriminating fields', () => {
    const pairs = findRapidResubscribePairs([
      ...SCANNER_TRAIL,
      { email: 'c@example.com', event_type: 'unsubscribe', ...at('2026-08-01T10:00:00.000Z') },
      {
        email: 'c@example.com',
        event_type: 'subscribe_completed',
        source_channel: 'resubscribe_link',
        request_method: 'POST',
        ...at('2026-08-01T10:00:30.000Z'),
      },
    ]);
    const s = summarizePairs(pairs);
    expect(s.total).toBe(2);
    expect(s.uniqueEmails).toBe(2);
    expect(s.buckets['<2s']).toBe(1);
    expect(s.buckets['10-60s']).toBe(1);
    expect(s.byChannel['resubscribe_link']).toBe(2);
    // `(unrecorded)` is the pre-#5711 half of the population, not "GET".
    expect(s.byMethod['(unrecorded)']).toBe(1);
    expect(s.byMethod['POST']).toBe(1);
  });
});

describe('the CLI that carries it', () => {
  const src = read('scripts/audit-resubscribe-pairs.mjs');

  it('is DRY-RUN by default and needs --apply to write anything', () => {
    expect(src).toMatch(/const APPLY = argv\.includes\('--apply'\)/);
    expect(src).toMatch(/if \(!APPLY\) \{[\s\S]{0,200}DRY-RUN/);
  });

  it('its only write is an append to the event trail — no status, flag or stamp', () => {
    // Deciding what to DO about a subscription a machine reactivated is a
    // decision about other people's mail; it belongs to the chained
    // remediation, not to the script that counts them.
    const applyBlock = src.slice(src.indexOf('let written = 0'));
    expect(applyBlock).toMatch(/event_type: 'resubscribe_scan_suspected'/);
    expect(applyBlock).not.toMatch(/status:\s*'/);
    expect(applyBlock).not.toMatch(/isActive/);
    expect(applyBlock).not.toMatch(/unsubscribed_at:/);
    expect(applyBlock).not.toMatch(/\.delete\(\)/);
  });

  it('reuses the pure rule instead of re-deriving it next to the Firestore calls', () => {
    expect(src).toMatch(/from '\.\/lib\/resubscribePairs\.mjs'/);
  });

  it('the default window is the module default, stated once', () => {
    expect(DEFAULT_WINDOW_SECONDS).toBe(60);
    expect(src).toMatch(/DEFAULT_WINDOW_SECONDS/);
  });
});
