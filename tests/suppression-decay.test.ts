import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifySuppressionDecay,
  classifySuppressionEvidence,
  hasProofOfLife,
  suppressionAgeDays,
  compareOldestSuppressionFirst,
  evaluateReprobeCohort,
  maskAddress,
  publishableReason,
  redactEmails,
  reprobeBatchId,
  ACTIONABLE_TIERS,
  MAX_REPROBE_ATTEMPTS,
  REPROBE_BATCH_SIZE,
  REPROBE_COHORT_SETTLE_HOURS,
  REPROBE_HALT_COMPLAINT_COUNT,
  REPROBE_HALT_HARD_BOUNCE_RATE,
  DECAYABLE_STATUSES,
  ENGAGEMENT_SUNSET_STATUSES,
  HARD_BOUNCE_PATTERN,
  MAX_DECAY_PER_RUN,
  MAX_REASON_LENGTH,
  NEVER_PROBED_COOLDOWN_DAYS,
  RECOVERED_STATUS_BY_COLLECTION,
  SUPPRESSION_COLLECTIONS,
  TERMINAL_STATUSES,
} from '../scripts/lib/suppressionDecay.mjs';

/**
 * Guards scripts/lib/suppressionDecay.mjs — the classifier behind
 * scripts/suppression-decay.mjs and scripts/check-suppression-invariant.mjs.
 *
 * The defect being guarded is asymmetric, so the tests are too. Recovering an
 * address that should have stayed suppressed sends mail to someone who told us
 * to stop, or to a dead mailbox on a free-tier ESP that will punish us for it.
 * Failing to recover one silently deletes a confirmed subscriber. The first
 * class gets exhaustive tests (every terminal status, every hard-bounce
 * phrase); the second gets the tier + coverage tests.
 */

const NOW = 1_700_000_000_000; // fixed reference; every fixture is relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

/** The 281-doc production shape: pre-classifier `reject`, never delivered, never opened. */
function strandedReject(overrides: Record<string, unknown> = {}) {
  return {
    status: 'bounced',
    bounce_reason: 'reject',
    bounced_at: daysAgo(NEVER_PROBED_COOLDOWN_DAYS + 60),
    ...overrides,
  };
}

/** The shape the owner-approved 2026-07-01 run recovered: soft reason, proven alive. */
function provenAlive(overrides: Record<string, unknown> = {}) {
  return {
    status: 'bounced',
    bounce_reason: 'reject',
    last_delivered_at: daysAgo(200),
    open_count: 3,
    bounced_at: daysAgo(150),
    ...overrides,
  };
}

describe('classifySuppressionDecay — tiers', () => {
  it('tiers a proven-alive soft bounce as recoverable', () => {
    const v = classifySuppressionDecay(provenAlive(), NOW);
    expect(v.tier).toBe('proven-alive');
    expect(v.recoverable).toBe(true);
  });

  it('accepts delivery alone as proof of life', () => {
    expect(classifySuppressionDecay(provenAlive({ open_count: 0 }), NOW).tier).toBe('proven-alive');
  });

  it('accepts an open alone as proof of life', () => {
    expect(classifySuppressionDecay(provenAlive({ last_delivered_at: undefined }), NOW).tier).toBe('proven-alive');
  });

  it('reads the legacy camelCase spellings too, so an old doc is not downgraded to the risky tier', () => {
    const legacy = { status: 'bounced', bounce_reason: 'reject', lastDeliveredAt: daysAgo(300), openCount: 2 };
    expect(hasProofOfLife(legacy).alive).toBe(true);
    expect(classifySuppressionDecay(legacy, NOW).tier).toBe('proven-alive');
  });

  it('tiers the stranded never-delivered backlog as never-probed, not proven-alive', () => {
    const v = classifySuppressionDecay(strandedReject(), NOW);
    expect(v.tier).toBe('never-probed');
    expect(v.recoverable).toBe(true);
  });

  it('holds a never-probed suppression inside the cooldown', () => {
    const fresh = strandedReject({ bounced_at: daysAgo(NEVER_PROBED_COOLDOWN_DAYS - 1) });
    expect(classifySuppressionDecay(fresh, NOW).tier).toBe('none');
  });

  it('releases a never-probed suppression exactly at the cooldown boundary', () => {
    const atBoundary = strandedReject({ bounced_at: daysAgo(NEVER_PROBED_COOLDOWN_DAYS) });
    expect(classifySuppressionDecay(atBoundary, NOW).tier).toBe('never-probed');
  });

  it('treats an unknown suppression age as eligible — the pre-classifier backlog has no anchor', () => {
    const noAnchor = { status: 'bounced', bounce_reason: 'reject' };
    expect(suppressionAgeDays(noAnchor, NOW)).toBeNull();
    expect(classifySuppressionDecay(noAnchor, NOW).tier).toBe('never-probed');
  });

  it('never reads updated_at as an age anchor (it moves on re-sends to already-suppressed docs)', () => {
    const misleading = { status: 'suppressed', updated_at: daysAgo(1) };
    expect(suppressionAgeDays(misleading, NOW)).toBeNull();
  });

  it('covers status suppressed as well as bounced', () => {
    const s = { status: 'suppressed', suppressed_at: daysAgo(90), mailtrap_suppression_category: 'Over quota' };
    expect(classifySuppressionDecay(s, NOW).tier).toBe('never-probed');
  });

  it('leaves mailable statuses alone', () => {
    for (const status of ['confirmed', 'active', 'pending', '']) {
      expect(classifySuppressionDecay({ status }, NOW).tier).toBe('none');
    }
  });

  it('normalises whitespace and case before deciding', () => {
    expect(classifySuppressionDecay(provenAlive({ status: '  BOUNCED ' }), NOW).tier).toBe('proven-alive');
    expect(classifySuppressionDecay({ status: 'Complained' }, NOW).tier).toBe('terminal');
  });
});

describe('classifySuppressionDecay — what must NEVER be recovered', () => {
  it('never recovers a human decision, whatever the evidence of life', () => {
    for (const status of TERMINAL_STATUSES) {
      const v = classifySuppressionDecay(
        { status, last_delivered_at: daysAgo(1), open_count: 99, click_count: 40 },
        NOW,
      );
      expect(v.tier).toBe('terminal');
      expect(v.recoverable).toBe(false);
    }
  });

  it('never recovers an unambiguous hard bounce, even with delivery + opens on record', () => {
    const phrases = [
      'mailbox does not exist',
      '550 5.1.1 no such user',
      'No Such Mailbox',
      'user unknown',
      'unknown user',
      'invalid recipient',
      'invalid mailbox',
      'mailbox not found',
      'mailbox unavailable',
      'recipient rejected',
      'address rejected',
      'nonexistent address',
      'non-existent mailbox',
      'account has been disabled',
      'disabled account',
      '550-5.1.10 recipient not found',
      "user doesn't exist",
    ];
    for (const bounce_reason of phrases) {
      expect(HARD_BOUNCE_PATTERN.test(bounce_reason)).toBe(true);
      const v = classifySuppressionDecay(provenAlive({ bounce_reason }), NOW);
      expect(`${bounce_reason} → ${v.tier}`).toBe(`${bounce_reason} → terminal`);
    }
  });

  it('does not read a soft/reputation reason as a hard bounce', () => {
    for (const reason of ['reject', 'Over quota', 'spam content', 'greylisted', 'temporary failure', '']) {
      expect(HARD_BOUNCE_PATTERN.test(reason)).toBe(false);
    }
  });

  it('leaves the engagement sunset to the sunset classifiers', () => {
    for (const status of ENGAGEMENT_SUNSET_STATUSES) {
      const v = classifySuppressionDecay({ status, open_count: 5 }, NOW);
      expect(v.tier).toBe('none');
      expect(v.recoverable).toBe(false);
    }
  });

  it('keeps the terminal and decayable status sets disjoint', () => {
    for (const s of TERMINAL_STATUSES) expect(DECAYABLE_STATUSES.has(s)).toBe(false);
    for (const s of ENGAGEMENT_SUNSET_STATUSES) expect(DECAYABLE_STATUSES.has(s)).toBe(false);
  });
});

describe('classifySuppressionDecay — idempotence', () => {
  it('classifies a decayed doc as none, in every collection, so a second run is a no-op', () => {
    for (const collection of SUPPRESSION_COLLECTIONS) {
      const recovered = {
        ...provenAlive(),
        status: RECOVERED_STATUS_BY_COLLECTION[collection],
        previous_suppression_status: 'bounced',
        previous_bounce_reason: 'reject',
      };
      expect(classifySuppressionDecay(recovered, NOW).tier).toBe('none');
    }
  });

  it('is a pure function of (doc, now) — repeated calls agree', () => {
    const doc = strandedReject();
    const a = classifySuppressionDecay(doc, NOW);
    const b = classifySuppressionDecay(doc, NOW);
    expect(b).toEqual(a);
  });

  it('leaves the residual bounce_reason harmless once the status has moved on', () => {
    // The runner keeps `bounce_reason` (it only copies it to
    // `previous_bounce_reason`). Status is what gates the classifier, so the
    // stale reason cannot resurrect the doc into a tier on the next pass.
    const recovered = { status: 'confirmed', bounce_reason: 'reject', last_delivered_at: daysAgo(200) };
    expect(classifySuppressionDecay(recovered, NOW).tier).toBe('none');
  });
});

describe('classifySuppressionEvidence — the invariant buckets', () => {
  it('buckets a human decision as own-choice', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(classifySuppressionEvidence({ status }, NOW)).toBe('own-choice');
    }
  });

  it('buckets an unambiguous reason as hard-evidence', () => {
    expect(classifySuppressionEvidence({ status: 'bounced', bounce_reason: 'user unknown' }, NOW)).toBe('hard-evidence');
  });

  it('buckets a soft-reason suppression as the violation', () => {
    expect(classifySuppressionEvidence(strandedReject(), NOW)).toBe('no-evidence');
    expect(classifySuppressionEvidence({ status: 'suppressed' }, NOW)).toBe('no-evidence');
  });

  it('reports the engagement sunset in its own bucket, never as evidence it lacks', () => {
    expect(classifySuppressionEvidence({ status: 'inactive' }, NOW)).toBe('engagement-sunset');
  });

  it('buckets a mailable doc as not-suppressed', () => {
    expect(classifySuppressionEvidence({ status: 'confirmed' }, NOW)).toBe('not-suppressed');
  });

  it('buckets a recorded opt-out as own-choice even when the status has moved on', () => {
    const doc = { status: 'bounced', bounce_reason: 'reject', unsubscribed_at: daysAgo(500) };
    expect(classifySuppressionEvidence(doc, NOW)).toBe('own-choice');
  });

  it('gives an exhausted probe budget its OWN bucket, not own-choice and not hard-evidence', () => {
    // It is evidence — our own, empirical — but neither of the two the
    // invariant names. Folding it into either would overstate what we know.
    const doc = { status: 'bounced', bounce_reason: 'reject', reprobe_count: MAX_REPROBE_ATTEMPTS };
    expect(classifySuppressionEvidence(doc, NOW)).toBe('probe-exhausted');
  });

  it('buckets on the machine-readable code, never on the prose', () => {
    // Bucketing on `reason` would tie the monitor's output to a string that is
    // meant to stay editable.
    const codes = [
      [{ status: 'unsubscribed' }, 'human-status'],
      [{ status: 'bounced', bounce_reason: 'reject', complained_at: daysAgo(9) }, 'human-complaint-stamp'],
      [{ status: 'bounced', bounce_reason: 'reject', unsubscribed_at: daysAgo(9) }, 'human-unsubscribe-stamp'],
      [{ status: 'bounced', bounce_reason: 'user unknown' }, 'hard-reason'],
      [{ status: 'bounced', bounce_reason: 'reject', reprobe_count: MAX_REPROBE_ATTEMPTS }, 'probe-exhausted'],
      [provenAlive(), 'proof-of-life'],
      [strandedReject(), 'reprobe-eligible'],
      [{ status: 'confirmed' }, 'mailable'],
      [{ status: 'inactive' }, 'engagement-sunset'],
      [strandedReject({ bounced_at: daysAgo(1) }), 'cooldown'],
    ] as const;
    for (const [doc, code] of codes) {
      expect(`${code}: ${classifySuppressionDecay(doc as Record<string, unknown>, NOW).code}`).toBe(`${code}: ${code}`);
    }
  });

  it('agrees with the decay classifier: nothing recoverable is ever legitimate evidence', () => {
    const docs = [provenAlive(), strandedReject(), { status: 'suppressed', suppressed_at: daysAgo(90) }];
    for (const doc of docs) {
      const v = classifySuppressionDecay(doc, NOW);
      if (v.recoverable) expect(classifySuppressionEvidence(doc, NOW)).toBe('no-evidence');
    }
  });
});

describe('constants are pinned', () => {
  it('exposes a conservative per-run cap and cooldown', () => {
    expect(MAX_DECAY_PER_RUN).toBe(200);
    expect(NEVER_PROBED_COOLDOWN_DAYS).toBe(30);
  });

  it('offers exactly the two actionable tiers, and no terminal one', () => {
    expect(ACTIONABLE_TIERS).toEqual(['proven-alive', 'never-probed']);
    expect(ACTIONABLE_TIERS).not.toContain('terminal');
  });

  it('restores a channel-appropriate mailable status for every collection', () => {
    for (const collection of SUPPRESSION_COLLECTIONS) {
      expect(RECOVERED_STATUS_BY_COLLECTION[collection]).toBeTruthy();
    }
    // A job-alert doc restored to `confirmed` stays mailable but becomes
    // permanently immune to classifyJobAlertSunset (whose MAILABLE_STATUSES is
    // {'active', ''}) — a zombie that list hygiene can never reach again.
    expect(RECOVERED_STATUS_BY_COLLECTION.job_alert_subscribers).toBe('active');
    expect(RECOVERED_STATUS_BY_COLLECTION.newsletter_subscribers).toBe('confirmed');
  });
});

/* ── The re-probe rails ──────────────────────────────────────────────────── */

/**
 * The `never-probed` tier now runs automatically (owner decision, 2026-08-10),
 * so its safety is no longer "a human looks at it first" — it is these rails.
 * Each one is tested against the failure it exists to prevent, not just for
 * its happy path.
 *
 * The probe itself is the NORMAL send: the runner un-suppresses a batch, the
 * next regular newsletter reaches them through the existing cascade, and the
 * webhook records delivered/bounce. So the only thing under this file's
 * control is HOW FAST addresses enter that loop.
 */
const HOUR = 60 * 60 * 1000;

/** A cohort doc as the breaker sees it: only `status` matters. */
const cohortDocs = (spec: { ok?: number; bounced?: number; complained?: number }) => [
  ...Array.from({ length: spec.ok ?? 0 }, () => ({ status: 'confirmed' })),
  ...Array.from({ length: spec.bounced ?? 0 }, () => ({ status: 'bounced' })),
  ...Array.from({ length: spec.complained ?? 0 }, () => ({ status: 'complained' })),
];

const settledBatchId = new Date(NOW - (REPROBE_COHORT_SETTLE_HOURS + 1) * HOUR).toISOString();

describe('re-probe rail: batch cap', () => {
  it('defaults to a batch far smaller than the proven-alive cap', () => {
    expect(REPROBE_BATCH_SIZE).toBe(50);
    expect(REPROBE_BATCH_SIZE).toBeLessThan(MAX_DECAY_PER_RUN);
  });

  it('caps a backlog to one batch, leaving the rest for later runs', () => {
    // The runner slices after sorting; this pins the arithmetic the ramp claim
    // rests on: a 357-address backlog takes ⌈357/50⌉ = 8 weekly runs.
    const backlog = 357;
    expect(Math.ceil(backlog / REPROBE_BATCH_SIZE)).toBe(8);
  });
});

describe('re-probe rail: deterministic ordering', () => {
  it('puts the oldest suppression first', () => {
    const items = [
      { ageDays: 10, key: 'a' },
      { ageDays: 400, key: 'b' },
      { ageDays: 100, key: 'c' },
    ];
    expect([...items].sort(compareOldestSuppressionFirst).map((i) => i.key)).toEqual(['b', 'c', 'a']);
  });

  it('treats a missing age anchor as infinitely old — that IS the backlog this tier targets', () => {
    const items = [
      { ageDays: 900, key: 'old' },
      { ageDays: null, key: 'no-anchor' },
    ];
    expect([...items].sort(compareOldestSuppressionFirst).map((i) => i.key)).toEqual(['no-anchor', 'old']);
  });

  it('breaks ties by key, so two runs over the same data select the same batch', () => {
    const items = [
      { ageDays: 100, key: 'z' },
      { ageDays: 100, key: 'a' },
      { ageDays: 100, key: 'm' },
    ];
    const first = [...items].sort(compareOldestSuppressionFirst).map((i) => i.key);
    const second = [...items].reverse().sort(compareOldestSuppressionFirst).map((i) => i.key);
    expect(first).toEqual(['a', 'm', 'z']);
    // Without a total order the cap would slice an arbitrary subset each run,
    // no cohort would have a measurable outcome, and the breaker below would
    // be reading noise.
    expect(second).toEqual(first);
  });
});

describe('re-probe rail: budget maximum', () => {
  const exhausted = (n: number) => ({
    status: 'bounced',
    bounce_reason: 'reject',
    bounced_at: daysAgo(400),
    reprobe_count: n,
  });

  it('still selects an address below the budget', () => {
    expect(classifySuppressionDecay(exhausted(MAX_REPROBE_ATTEMPTS - 1), NOW).tier).toBe('never-probed');
  });

  it('never selects an address that used its whole budget', () => {
    const v = classifySuppressionDecay(exhausted(MAX_REPROBE_ATTEMPTS), NOW);
    expect(v.tier).toBe('terminal');
    expect(v.recoverable).toBe(false);
  });

  it('stays terminal above the budget, so an over-count cannot wrap around', () => {
    expect(classifySuppressionDecay(exhausted(MAX_REPROBE_ATTEMPTS + 5), NOW).tier).toBe('terminal');
  });

  it('lets a probe that DID deliver graduate to the evidence-backed tier despite the budget', () => {
    // Proof of life outranks the budget: the budget only means "no delivery
    // ever came back", and here one did.
    const revived = { ...exhausted(MAX_REPROBE_ATTEMPTS), last_delivered_at: daysAgo(5) };
    expect(classifySuppressionDecay(revived, NOW).tier).toBe('proven-alive');
  });
});

describe('re-probe rail: circuit breaker', () => {
  it('allows the very first batch, when no cohort has ever gone out', () => {
    const v = evaluateReprobeCohort({ batchId: null, docs: [] }, NOW);
    expect(v.allowed).toBe(true);
    expect(v.halted).toBe(false);
  });

  it('allows a clean cohort', () => {
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: cohortDocs({ ok: 49, bounced: 1 }) }, NOW);
    expect(v.hardBounceRate).toBeCloseTo(0.02, 5);
    expect(v.allowed).toBe(true);
  });

  it('does not trip on ordinary variance — one bounce in fifty is 2%, the observed base rate is 0,55%', () => {
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: cohortDocs({ ok: 49, bounced: 1 }) }, NOW);
    expect(v.hardBounceRate).toBeLessThan(REPROBE_HALT_HARD_BOUNCE_RATE);
    expect(v.halted).toBe(false);
  });

  it('trips once the cohort re-bounces above the threshold', () => {
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: cohortDocs({ ok: 40, bounced: 10 }) }, NOW);
    expect(v.hardBounceRate).toBeCloseTo(0.2, 5);
    expect(v.halted).toBe(true);
    expect(v.allowed).toBe(false);
  });

  it('does not trip exactly AT the threshold, only above it', () => {
    const atThreshold = cohortDocs({ ok: 44, bounced: 6 }); // 12% == threshold
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: atThreshold }, NOW);
    expect(v.hardBounceRate).toBeCloseTo(REPROBE_HALT_HARD_BOUNCE_RATE, 5);
    expect(v.halted).toBe(false);
  });

  it('trips on a single spam complaint regardless of the bounce rate', () => {
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: cohortDocs({ ok: 49, complained: 1 }) }, NOW);
    expect(REPROBE_HALT_COMPLAINT_COUNT).toBe(1);
    expect(v.hardBounceRate).toBe(0);
    expect(v.halted).toBe(true);
  });

  it('STAYS tripped: re-evaluating the same cohort later reaches the same verdict', () => {
    const bad = { batchId: settledBatchId, docs: cohortDocs({ ok: 40, bounced: 10 }) };
    const now = evaluateReprobeCohort(bad, NOW);
    const muchLater = evaluateReprobeCohort(bad, NOW + 90 * 24 * HOUR);
    expect(now.halted).toBe(true);
    // Stickiness is by construction, not by a stored flag: while halted no new
    // cohort is created, so this same cohort stays the most recent one and
    // every later run re-derives the same halt. A stored flag in
    // data/suppression-decay-report.json could not do this — that file does
    // not survive between GitHub Actions runs.
    expect(muchLater.halted).toBe(true);
  });

  it('refuses to measure a cohort that has not settled, instead of reading 0% as all-clear', () => {
    const fresh = new Date(NOW - 1 * HOUR).toISOString();
    const v = evaluateReprobeCohort({ batchId: fresh, docs: cohortDocs({ ok: 50 }) }, NOW);
    expect(v.settled).toBe(false);
    expect(v.allowed).toBe(false);
    expect(v.halted).toBe(false); // deferral, not a halt
  });

  it('measures the cohort once the settle window has passed', () => {
    const v = evaluateReprobeCohort({ batchId: settledBatchId, docs: cohortDocs({ ok: 50 }) }, NOW);
    expect(v.settled).toBe(true);
    expect(v.allowed).toBe(true);
  });

  it('mints a sortable cohort id so the latest cohort is max(), with no side ledger', () => {
    const older = reprobeBatchId(NOW - 7 * 24 * HOUR);
    const newer = reprobeBatchId(NOW);
    expect([newer, older].sort().pop()).toBe(newer);
  });
});

describe('re-probe rail: nothing terminal is ever selected', () => {
  it('never selects a human decision into a probe batch', () => {
    for (const status of TERMINAL_STATUSES) {
      const doc = { status, bounce_reason: 'reject', bounced_at: daysAgo(400) };
      expect(classifySuppressionDecay(doc, NOW).tier).toBe('terminal');
    }
  });

  it('never selects a suppressed doc carrying an opt-out stamp its status has lost', () => {
    // `status` is last-writer-wins; the stamps are append-only. A subscriber
    // who opted out and got one more send before the filter caught up reads
    // `bounced` with `unsubscribed_at` still set.
    const doc = { status: 'bounced', bounce_reason: 'reject', bounced_at: daysAgo(400), unsubscribed_at: daysAgo(500) };
    expect(classifySuppressionDecay(doc, NOW).tier).toBe('terminal');
  });

  it('DOES select someone who unsubscribed and later re-subscribed', () => {
    // 227 of the 773 stamped newsletter docs in production (2026-08-10) came
    // back; treating a superseded stamp as binding deletes them forever on the
    // strength of a decision they reversed.
    const returned = {
      status: 'bounced',
      bounce_reason: 'reject',
      bounced_at: daysAgo(100),
      unsubscribed_at: daysAgo(500),
      confirmed_at: daysAgo(300),
    };
    expect(classifySuppressionDecay(returned, NOW).tier).toBe('never-probed');
  });

  it('does not count a re-confirmation that predates the opt-out', () => {
    const stillOut = {
      status: 'bounced',
      bounce_reason: 'reject',
      bounced_at: daysAgo(100),
      unsubscribed_at: daysAgo(300),
      confirmed_at: daysAgo(500),
    };
    expect(classifySuppressionDecay(stillOut, NOW).tier).toBe('terminal');
  });

  it('never selects a doc carrying a complaint stamp, and a later signup does not undo it', () => {
    const doc = { status: 'bounced', bounce_reason: 'reject', bounced_at: daysAgo(400), complained_at: daysAgo(500) };
    expect(classifySuppressionDecay(doc, NOW).tier).toBe('terminal');
    const jobAlertShape = { status: 'bounced', bounce_reason: 'reject', last_complained_at: daysAgo(500) };
    expect(classifySuppressionDecay(jobAlertShape, NOW).tier).toBe('terminal');
    // A spam complaint is not undone by a later signup form.
    const resignedUp = { ...doc, confirmed_at: daysAgo(10) };
    expect(classifySuppressionDecay(resignedUp, NOW).tier).toBe('terminal');
  });

  it('leaves a healthy re-subscriber out of the terminal bucket entirely', () => {
    // 268 production docs are `confirmed` with a stale `unsubscribed_at`.
    // Checking the stamp before the status gate would label every one of them
    // terminal — no write changes, but every count this module feeds (the
    // breaker, the escalation issue) would be wrong.
    const healthy = { status: 'confirmed', unsubscribed_at: daysAgo(500), confirmed_at: daysAgo(300) };
    expect(classifySuppressionDecay(healthy, NOW).tier).toBe('none');
    const stillOptedOut = { status: 'confirmed', unsubscribed_at: daysAgo(300) };
    expect(classifySuppressionDecay(stillOptedOut, NOW).tier).toBe('none');
  });

  it('never selects an unambiguous hard bounce into a probe batch', () => {
    const doc = { status: 'bounced', bounce_reason: 'no such mailbox', bounced_at: daysAgo(400) };
    expect(classifySuppressionDecay(doc, NOW).tier).toBe('terminal');
  });
});

describe('re-probe rail: kill switch', () => {
  /**
   * The switch itself lives in the runner (an env var read, so it needs no
   * deploy and cannot be defeated by a Remote Config parameter missing from
   * `RC_TO_ENV` in scripts/load-rc-env.mjs). What is asserted here is the
   * wiring: the workflow must pass it explicitly, and must expose a dispatch
   * input that forces the proven-alive-only path.
   */
  const runner = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'suppression-decay.mjs'), 'utf-8');
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '.github', 'workflows', 'suppression-hygiene.yml'),
    'utf-8',
  );

  it('the runner reads the switch straight from the environment', () => {
    expect(runner).toContain('process.env.SUPPRESSION_REPROBE_ENABLED');
  });

  it('the switch is NOT routed through Remote Config', () => {
    const loader = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'load-rc-env.mjs'), 'utf-8');
    // A Remote Config parameter that is not also present in the loader's
    // mapping table reads as `undefined` however it is set in the console — a
    // silent no-op at exactly the moment someone is trying to stop the ramp.
    // Keeping the switch out of RC entirely removes that failure mode; if a
    // future change puts it there, this test says the mapping must come too.
    expect(loader.includes('SUPPRESSION_REPROBE_ENABLED')).toBe(false);
  });

  it('disables the re-probe on the literal string false, and defaults to enabled', () => {
    // Mirrors the runner's own expression, so a change to the semantics here
    // is a change to a test that states them.
    const decide = (v: string | undefined) => String(v ?? 'true').trim().toLowerCase() !== 'false';
    expect(decide(undefined)).toBe(true);
    expect(decide('true')).toBe(true);
    expect(decide('false')).toBe(false);
    expect(decide('FALSE')).toBe(false);
    expect(decide(' false ')).toBe(false);
  });

  it('the workflow always passes the switch explicitly and can force proven-alive only', () => {
    expect(workflow).toContain('SUPPRESSION_REPROBE_ENABLED');
    expect(workflow).toContain('proven-alive-only');
  });

  it('the workflow never hands --force-reprobe to the cron', () => {
    // Shell INVOCATIONS only. The workflow also names the flag in the
    // escalation issue body, where it is documented as the owner's manual way
    // out of a tripped breaker — that prose is backticked, an invocation is not.
    const invocations = workflow
      .split('\n')
      .filter((l) => l.includes('node scripts/suppression-decay.mjs') && !l.includes('`'));
    expect(invocations.length).toBeGreaterThan(0);
    // --force-reprobe is the ONLY way a tripped breaker clears. An automated
    // caller holding it would make the breaker decorative.
    for (const line of invocations) expect(line).not.toContain('--force-reprobe');
  });
});

describe('reason strings are safe to publish', () => {
  /**
   * Found by running the dry-run against production on 2026-08-10: one
   * `job_alert_subscribers` reason is literally
   * `"<…@icloud.com>: user is over quota"`. The workflow groups reason strings
   * and renders them into a PUBLIC issue body, so an unredacted breakdown
   * publishes a subscriber's address — AGENTS.md Privacy, and not something a
   * reviewer would catch by reading the workflow.
   */
  it('redacts an address embedded in a provider reason string', () => {
    const raw = '<alessia.example@icloud.com>: user is over quota';
    // The provider's own angle brackets survive; only the address inside them
    // is replaced. What matters is that no local part or domain gets through.
    expect(redactEmails(raw)).toBe('<<email-redacted>>: user is over quota');
    expect(publishableReason(raw)).not.toMatch(/@icloud\.com/);
    expect(publishableReason(raw)).not.toMatch(/alessia/i);
  });

  it('redacts every address when a reason carries more than one', () => {
    const out = redactEmails('a@b.com and c@d.org both failed');
    expect(out).toBe('<email-redacted> and <email-redacted> both failed');
  });

  it('leaves an address-free reason untouched', () => {
    expect(publishableReason('reject')).toBe('reject');
    expect(publishableReason('  overquota  ')).toBe('overquota');
  });

  it('labels an empty reason instead of producing an empty grouping key', () => {
    expect(publishableReason('')).toBe('(empty)');
    expect(publishableReason(null)).toBe('(empty)');
    expect(publishableReason(undefined)).toBe('(empty)');
  });

  it('bounds the 240-char provider prose so it cannot swallow the issue body', () => {
    const prose = "The recipient's email provider sent a bounce message because the recipient's inbox was full. "
      + 'You might be able to send to the same recipient in the future when the mailbox is no longer full. '
      + '(escalated after 3 consecutive soft rejects)';
    expect(prose.length).toBeGreaterThan(MAX_REASON_LENGTH);
    expect(publishableReason(prose).length).toBe(MAX_REASON_LENGTH + 1); // + the ellipsis
  });

  it('masks a subscriber address down to its domain', () => {
    expect(maskAddress('Alessia.Example@iCloud.com')).toBe('a***@icloud.com');
    expect(maskAddress('x@gmail.com')).toBe('x***@gmail.com');
  });

  it('never returns something address-shaped for a malformed id', () => {
    for (const bad of ['', 'not-an-email', 'trailing@', null, undefined]) {
      expect(maskAddress(bad as string)).toBe('(masked)');
    }
  });
});

/* ── Collection coverage ─────────────────────────────────────────────────── */

/**
 * The reason this file exists at all: the one-off that ran in production
 * (scripts/dev/reactivate-false-positive-bounces.mjs) hard-coded
 * `newsletter_subscribers`, so `job_alert_subscribers` — 137 bounced docs, 108
 * of them false positives by that same script's own criteria — was never
 * cleaned once. A third channel would repeat that silently, because nothing
 * anywhere states which collections carry a send-gating status.
 *
 * This asserts it mechanically: every `*_subscribers` collection named by a
 * file that calls one of the emailSuppression predicates must be in
 * SUPPRESSION_COLLECTIONS. The `*_subscribers` filter is what keeps the check
 * honest without an allowlist — scripts/send-saved-jobs-digest.mjs reads
 * `users` too, but takes the suppression status from `newsletter_subscribers`,
 * so restricting to the subscriber-doc naming convention matches exactly the
 * collections that can hold one.
 */
const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['scripts', 'services', path.join('functions', 'src')];
const SUPPRESSION_PREDICATE =
  /\bis(?:AddressSuppressed|NewsletterExcluded|JobAlertExcluded|SavedJobsDigestExcluded)\b/;

/**
 * REGULAR files only. `services/` is full of symlinks into
 * `packages/articles/content/` (blog data, locale chunks, seo-blog shards) —
 * none of which can hold a sender, and all of which are DANGLING in a sparse
 * worktree that excludes that path. Following them would make this test red
 * locally and green in CI, the failure mode CLAUDE.md calls out by name.
 * `Dirent.isFile()` is lstat-based, so a symlink is skipped identically in
 * both checkouts instead of only where it happens to resolve.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.isFile() && /\.(mjs|cjs|js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function subscriberCollectionsIn(source: string): string[] {
  const out: string[] = [];
  const re = /\.collection\(\s*['"]([A-Za-z0-9_]*_subscribers)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

describe('SUPPRESSION_COLLECTIONS covers every channel that gates on a suppression status', () => {
  it('names every *_subscribers collection read by a suppression-aware sender', () => {
    const found = new Map<string, string[]>();
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file);
        if (rel.includes('suppressionDecay')) continue; // the list itself
        const source = fs.readFileSync(file, 'utf-8');
        if (!SUPPRESSION_PREDICATE.test(source)) continue;
        for (const collection of subscriberCollectionsIn(source)) {
          const list = found.get(collection) ?? [];
          if (!list.includes(rel)) list.push(rel);
          found.set(collection, list);
        }
      }
    }

    // A sender was found, or the scan itself silently broke.
    expect(found.size).toBeGreaterThan(0);

    const uncovered = [...found.entries()]
      .filter(([collection]) => !SUPPRESSION_COLLECTIONS.includes(collection))
      .map(([collection, files]) => `${collection} (read by ${files.join(', ')})`);

    // Add the collection to SUPPRESSION_COLLECTIONS in
    // `scripts/lib/suppressionDecay.mjs` AND give it an entry in
    // RECOVERED_STATUS_BY_COLLECTION — otherwise the new channel's
    // machine-inferred suppressions are permanent, exactly as job_alert_
    // subscribers' were until 2026-08-10.
    expect(uncovered).toEqual([]);
  });

  it('has a recovered status for every listed collection, and lists no phantom', () => {
    expect(Object.keys(RECOVERED_STATUS_BY_COLLECTION).sort()).toEqual([...SUPPRESSION_COLLECTIONS].sort());
  });
});

/* ── The regex has exactly one home ──────────────────────────────────────── */

describe('the hard-bounce regex is not duplicated', () => {
  it('lives only in scripts/lib/suppressionDecay.mjs', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const rel = path.relative(REPO_ROOT, file);
        if (rel === path.join('scripts', 'lib', 'suppressionDecay.mjs')) continue;
        const source = fs.readFileSync(file, 'utf-8');
        // A literal re-declaration, not an import of the shared constant.
        if (/(?:const|let|var)\s+HARD_BOUNCE_PATTERN\s*=/.test(source)) offenders.push(rel);
      }
    }
    // Two literal copies of a safety regex drift, and the copy that gets
    // widened is never the copy guarding the run you are looking at
    // (AGENTS.md Non-Negotiable #6). Import it from
    // `scripts/lib/suppressionDecay.mjs` instead.
    expect(offenders).toEqual([]);
  });

  it('is actually imported by the one-off that first defined it', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'dev', 'reactivate-false-positive-bounces.mjs'),
      'utf-8',
    );
    expect(source).toContain('HARD_BOUNCE_PATTERN');
    expect(source).toContain('suppressionDecay.mjs');
  });
});
