import { describe, expect, it } from 'vitest';
import {
  buildAlertProfile,
  jobCompanyIdentityQuarantineReason,
  scoreJobForAlert,
} from '../services/jobAlertMatching.mjs';
import {
  buildRecipientSections,
  claimRecipientSections,
  classifyProviderOutcomes,
  classifyRecipientConsent,
  companyAlertJobQuarantines,
  deliveryOutcomeForEmail,
  finalizeRecipientDelivery,
  hasDeferredCompanyAlertWork,
  hasExplicitProviderAcceptance,
  isOpenCompanyAlertJob,
  markRecipientDeliveryAttempted,
  PER_RUN_CAP,
  planDeferredDeliveryWrites,
  planDeliveryWriteback,
  selectNewlyPublishedJobs,
  sortCompanyAlertRecipients,
} from '../scripts/send-company-alerts.mjs';
import {
  DEDUP_WINDOW_MS,
  DEFERRED_MAX_ATTEMPTS,
  DELIVERY_STATES,
  filterUnsentJobs,
  jobIdentityQuarantineReason,
} from '../scripts/lib/alert-sent-jobs.mjs';
import { companyAlertQuarantineReason } from '../scripts/lib/company-alert-routing.mjs';
import { allocateCompanyAlertCards } from '../services/companyAlertEmail.mjs';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

function ref(path: string) {
  return { path, id: path.split('/').at(-1) };
}

function alert(
  id: string,
  companyKey: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    ref: ref(`job_alert_subscribers/fixture/alerts/${id}`),
    email: `${id}@example.invalid`,
    locale: 'it',
    frequency: 'immediate',
    specificCompanyKey: companyKey,
    active: true,
    paused: false,
    ...extra,
  };
}

function job(
  id: string,
  company: string,
  companyKey = canonicalCompanyProfileSlug(company, company),
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    title: `Fixture opening ${id}`,
    company,
    companyKey,
    location: 'Lugano',
    canton: 'TI',
    description: 'Controlled fixture for the sender remediation suite.',
    firstSeenAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    url: `https://jobs.fixture.invalid/${id}`,
    ...extra,
  };
}

function serializedDb(initial: Record<string, Record<string, unknown>>) {
  const docs = new Map(Object.entries(initial));
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    docs,
    runTransaction(fn: (tx: any) => Promise<unknown>) {
      const run = tail.then(async () => {
        const updates: Array<{ ref: { path: string }; data: Record<string, unknown> }> = [];
        const tx = {
          get: async (documentRef: { path: string }) => {
            const data = docs.get(documentRef.path);
            return { exists: Boolean(data), data: () => data };
          },
          update: (documentRef: { path: string }, data: Record<string, unknown>) => {
            updates.push({ ref: documentRef, data });
          },
        };
        const result = await fn(tx);
        for (const update of updates) {
          docs.set(update.ref.path, { ...(docs.get(update.ref.path) || {}), ...update.data });
        }
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
  return db;
}

describe('B1 — exact canonical company identity', () => {
  it('rejects prefix/suffix employers while retaining casing and declared aliases', () => {
    const acmeProfile = buildAlertProfile({ specificCompanyKey: 'Acme' }, null, {});
    const exact = job('acme-exact', 'Acme', 'acme');
    const casing = job('acme-casing', 'ACME', 'ACME');
    const prefix = job('acme-prefix', 'Acme Holdings', 'acme-holdings');
    const suffix = job('acme-suffix', 'Super Acme', 'super-acme');

    expect(scoreJobForAlert(exact, acmeProfile)).toBeGreaterThan(0);
    expect(scoreJobForAlert(casing, acmeProfile)).toBeGreaterThan(0);
    expect(scoreJobForAlert(prefix, acmeProfile)).toBe(0);
    expect(scoreJobForAlert(suffix, acmeProfile)).toBe(0);

    const sections = buildRecipientSections(
      [alert('b1', 'Acme')],
      [exact, casing, prefix, suffix],
      NOW,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].jobs.map((item) => item.id).sort()).toEqual(['acme-casing', 'acme-exact']);

    const aliasProfile = buildAlertProfile({ specificCompanyKey: 'Guess Ticino' }, null, {});
    const alias = job('guess-alias', 'Guess Europe Switzerland', 'guess-europe-switzerland');
    expect(scoreJobForAlert(alias, aliasProfile)).toBeGreaterThan(0);
  });

  it('quarantines unresolved alert and job identities with explicit reasons', () => {
    const unresolvedAlert = alert('b1-unresolved', '??');
    expect(companyAlertQuarantineReason(unresolvedAlert)).toBe('unresolved-canonical-company-key');
    expect(buildRecipientSections([unresolvedAlert], [job('x', 'Acme', 'acme')], NOW)).toEqual([]);

    const profile = buildAlertProfile({ specificCompanyKey: 'Acme' }, null, {});
    const unresolvedJob = job('b1-job-unresolved', '??', '??');
    expect(jobCompanyIdentityQuarantineReason(unresolvedJob, profile)).toBe('unresolved-job-company-key');
    expect(companyAlertJobQuarantines(alert('b1-job-alert', 'Acme'), [unresolvedJob])).toEqual([
      { job: unresolvedJob, reason: 'unresolved-job-company-key' },
    ]);
  });
});

describe('B2 — expired offers never reach selection or rendering', () => {
  it('excludes a fresh-but-expired fixture at both sender boundaries', () => {
    const expired = job('expired-fresh-marker', 'Acme', 'acme', {
      status: 'expired',
      active: false,
      validThrough: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
      expiredAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(isOpenCompanyAlertJob(expired, NOW)).toBe(false);
    expect(selectNewlyPublishedJobs([expired], NOW, 6 * 60 * 60 * 1000)).toEqual([]);
    expect(buildRecipientSections([alert('b2', 'Acme')], [expired], NOW)).toEqual([]);
  });
});

describe('B3 — consent and suppression are fail-closed', () => {
  const knownNewsletter = { exists: true, data: { status: 'confirmed', isActive: true } };
  const knownJobAlert = { exists: true, data: { status: 'active', active: true } };

  it('distinguishes known-ok, known-suppressed and unknown states', () => {
    expect(classifyRecipientConsent(knownNewsletter, knownJobAlert)).toEqual({
      action: 'send',
      reason: 'consent-known-ok',
    });
    expect(classifyRecipientConsent(
      { exists: true, data: { status: 'unsubscribed' } },
      knownJobAlert,
    )).toEqual({ action: 'suppress', reason: 'newsletter-cross-channel-stop' });
    expect(classifyRecipientConsent(
      { exists: true, data: { status: 'pending' } },
      knownJobAlert,
    )).toEqual({ action: 'defer', reason: 'newsletter-consent-status-unknown' });
    expect(classifyRecipientConsent(undefined, knownJobAlert)).toEqual({
      action: 'defer',
      reason: 'consent-document-missing',
    });
  });

  it('makes an unknown lookup recoverable with a durable reason', () => {
    const sourceAlert = alert('b3-recovery', 'Acme');
    const sourceJob = job('b3-job', 'Acme', 'acme');
    const sections = buildRecipientSections([sourceAlert], [sourceJob], NOW);
    const writes = planDeferredDeliveryWrites(sections, NOW, 'suppression-lookup-failed');
    const deferredAlert = { ...sourceAlert, deliveryLedger: writes[0].deliveryLedger };

    expect(writes[0].deliveryLedger['b3-job']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED,
      reason: 'suppression-lookup-failed',
    });
    expect(hasDeferredCompanyAlertWork([deferredAlert])).toBe(true);
    expect(buildRecipientSections(
      [deferredAlert],
      [],
      NOW,
      DEDUP_WINDOW_MS,
      [sourceJob],
    )[0].jobs.map((item) => item.id)).toEqual(['b3-job']);
  });
});

describe('B4 — delivery ledger blocks unsafe retries', () => {
  it('quarantines a candidate with no stable identity', () => {
    const idless = {
      company: 'Acme',
      companyKey: 'acme',
      title: 'Id-less controlled fixture',
      firstSeenAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    };
    expect(jobIdentityQuarantineReason(idless)).toBe('missing-stable-job-identity');
    expect(companyAlertJobQuarantines(alert('b4-idless', 'Acme'), [idless])).toEqual([
      { job: idless, reason: 'missing-stable-job-identity' },
    ]);
    expect(buildRecipientSections([alert('b4-idless', 'Acme')], [idless], NOW)).toEqual([]);
  });

  it('allows only one of two concurrent claims', async () => {
    const sourceAlert = alert('b4-concurrent', 'Acme');
    const sourceJob = job('b4-concurrent-job', 'Acme', 'acme');
    const section = buildRecipientSections([sourceAlert], [sourceJob], NOW)[0];
    const db = serializedDb({ [sourceAlert.ref.path]: { ...sourceAlert, ref: undefined } });

    const [first, second] = await Promise.all([
      claimRecipientSections(db, [section], NOW, 'claim-a'),
      claimRecipientSections(db, [section], NOW, 'claim-b'),
    ]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
    expect(db.docs.get(sourceAlert.ref.path)?.deliveryLedger?.['b4-concurrent-job']).toMatchObject({
      state: DELIVERY_STATES.CLAIMED,
    });
  });

  it('allocates from the fresh unsent set, including a section outside the stale cap', async () => {
    const source = Array.from({ length: 21 }, (_, index) => {
      const sourceAlert = alert(`b4-fresh-allocator-${index}`, 'Acme');
      const sourceJob = job(`b4-fresh-allocator-job-${index}`, 'Acme', 'acme');
      return { sourceAlert, sourceJob, section: buildRecipientSections([sourceAlert], [sourceJob], NOW)[0] };
    });
    const initial = Object.fromEntries(source.map(({ sourceAlert, sourceJob }, index) => [
      sourceAlert.ref.path,
      {
        ...sourceAlert,
        ref: undefined,
        ...(index === 0 ? { sentJobIds: { [sourceJob.id]: NOW } } : {}),
      },
    ]));
    const db = serializedDb(initial);

    const claimed = await claimRecipientSections(db, source.map((item) => item.section), NOW, 'claim-fresh-allocator');
    expect(claimed).toHaveLength(20);
    expect(claimed.some((section) => section.jobs[0].id === 'b4-fresh-allocator-job-0')).toBe(false);
    expect(claimed.some((section) => section.jobs[0].id === 'b4-fresh-allocator-job-20')).toBe(true);
  });

  it('keeps a claimed job blocked when accepted-provider writeback fails', async () => {
    const sourceAlert = alert('b4-writeback', 'Acme');
    const sourceJob = job('b4-writeback-job', 'Acme', 'acme');
    const section = buildRecipientSections([sourceAlert], [sourceJob], NOW)[0];
    const db = serializedDb({ [sourceAlert.ref.path]: { ...sourceAlert, ref: undefined } });
    const [claimed] = await claimRecipientSections(db, [section], NOW, 'claim-writeback');
    expect(await markRecipientDeliveryAttempted(
      db,
      [{ ref: sourceAlert.ref, sentJobs: claimed.jobs }],
      NOW,
      'claim-writeback',
    )).toBe(1);
    expect(db.docs.get(sourceAlert.ref.path)?.deliveryLedger?.['b4-writeback-job']).toMatchObject({
      state: DELIVERY_STATES.AMBIGUOUS,
      reason: 'provider-attempt-unknown',
    });
    const failedWritebackDb = {
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
        get: async (documentRef: { path: string }) => {
          const data = db.docs.get(documentRef.path);
          return { exists: true, data: () => data };
        },
        update: () => { throw new Error('controlled writeback failure'); },
      }),
    };

    await expect(finalizeRecipientDelivery(
      failedWritebackDb,
      [{ ref: sourceAlert.ref, sentJobs: claimed.jobs }],
      'accepted',
      NOW,
    )).rejects.toThrow('controlled writeback failure');
    const current = db.docs.get(sourceAlert.ref.path)!;
    expect(current.deliveryLedger['b4-writeback-job']).toMatchObject({ state: DELIVERY_STATES.AMBIGUOUS });
    expect(filterUnsentJobs(
      [sourceJob],
      {},
      NOW,
      DEDUP_WINDOW_MS,
      current.deliveryLedger,
    )).toEqual([]);
  });

  it('does not claim jobs omitted by the email card budget', async () => {
    const sourceAlert = alert('b4-card-budget', 'Acme');
    const sourceJobs = Array.from({ length: 10 }, (_, index) => (
      job(`b4-card-job-${index}`, 'Acme', 'acme')
    ));
    const section = buildRecipientSections([sourceAlert], sourceJobs, NOW)[0];
    const db = serializedDb({ [sourceAlert.ref.path]: { ...sourceAlert, ref: undefined } });

    const renderable = allocateCompanyAlertCards([section])[0];
    const renderableKeys = new Set(renderable.jobs.map((item) => item.id));
    const cardDeferred = planDeferredDeliveryWrites([{
      ...section,
      jobs: section.jobs.filter((item) => !renderableKeys.has(item.id)),
    }], NOW, 'card-cap')[0];
    const [claimed] = await claimRecipientSections(db, [section], NOW, 'claim-card-budget');
    expect(claimed.jobs).toHaveLength(6);
    expect(Object.keys(db.docs.get(sourceAlert.ref.path)?.deliveryLedger || {})).toHaveLength(6);

    const claimedLedger = (db.docs.get(sourceAlert.ref.path)?.deliveryLedger || {}) as Record<string, unknown>;
    const alertAfterClaim = {
      ...sourceAlert,
      deliveryLedger: {
        ...claimedLedger,
        ...cardDeferred.deliveryLedger,
      },
    };
    expect(alertAfterClaim.deliveryLedger['b4-card-job-6']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED,
      reason: 'card-cap',
    });
    expect(buildRecipientSections([alertAfterClaim], sourceJobs, NOW)[0].jobs).toHaveLength(4);
  });

  it('persists ambiguous separately and consults it on the next retry', () => {
    const sourceJob = job('b4-ambiguous-job', 'Acme', 'acme');
    const plan = planDeliveryWriteback(
      {},
      [sourceJob],
      'ambiguous',
      NOW,
      { provider: 'maileroo', messageId: 'fixture-accepted-ref' },
    );
    expect('sentJobIds' in plan).toBe(false);
    expect(plan.matchCountDelta).toBe(0);
    expect(plan.deliveryLedger['b4-ambiguous-job']).toMatchObject({
      state: DELIVERY_STATES.AMBIGUOUS,
      reason: 'provider-outcome-ambiguous',
    });
    expect(filterUnsentJobs(
      [sourceJob],
      {},
      NOW,
      DEDUP_WINDOW_MS,
      plan.deliveryLedger,
    )).toEqual([]);
  });
});

describe('B5 — provider acceptance requires an explicit acknowledgement', () => {
  const email = 'provider-fixture@example.invalid';

  it('does not treat HTTP 200 with an empty-body fallback id as accepted', () => {
    const explicit = { recipient: { email }, provider: 'maileroo', messageId: 'fixture-accepted-ref' };
    const emptyBodyFallback = { recipient: { email }, provider: 'maileroo', messageId: 'maileroo-123' };
    expect(hasExplicitProviderAcceptance(explicit)).toBe(true);
    expect(hasExplicitProviderAcceptance(emptyBodyFallback)).toBe(false);

    const accepted = classifyProviderOutcomes({ sent: [explicit], failed: [] });
    const ambiguous = classifyProviderOutcomes({ sent: [emptyBodyFallback], failed: [] });
    expect(accepted.sent).toHaveLength(1);
    expect(ambiguous.sent).toHaveLength(0);
    expect(ambiguous.failed[0]).toMatchObject({
      ambiguousDelivery: true,
      providerAcknowledgementMissing: true,
    });
    expect(deliveryOutcomeForEmail({ to: email }, accepted).outcome).toBe('accepted');
    expect(deliveryOutcomeForEmail({ to: email }, ambiguous).outcome).toBe('ambiguous');
  });
});

describe('B6 — the per-run cap leaves a durable, fair backlog', () => {
  it('defers the (PER_RUN_CAP + 1)th recipient and prioritises it on fresh work', () => {
    const alerts = Array.from({ length: PER_RUN_CAP + 1 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return alert(`b6-alert-${suffix}`, `fixture-company-${suffix}`, {
        email: `b6-recipient-${suffix}@example.invalid`,
      });
    });
    const jobs = alerts.map((item, index) => {
      const suffix = String(index).padStart(3, '0');
      return job(`b6-job-${suffix}`, `Fixture Company ${suffix}`, `fixture-company-${suffix}`);
    });
    const byRecipient = new Map(alerts.map((item) => [item.email, [item]]));
    const recipients = sortCompanyAlertRecipients(byRecipient);
    const selected = recipients.slice(0, PER_RUN_CAP);
    const deferredPlans = recipients.slice(PER_RUN_CAP).flatMap((recipient) => planDeferredDeliveryWrites(
      buildRecipientSections(byRecipient.get(recipient), jobs, NOW, DEDUP_WINDOW_MS, jobs),
      NOW,
      'per-run-cap',
    ));
    expect(selected).toHaveLength(PER_RUN_CAP);
    expect(deferredPlans).toHaveLength(1);
    expect(deferredPlans[0]).not.toHaveProperty('deliveryDeferredAttempts');

    const deferredAlert = alerts.at(-1)!;
    const deferred = { ...deferredAlert, deliveryLedger: deferredPlans[0].deliveryLedger };
    expect(hasDeferredCompanyAlertWork([deferred])).toBe(true);

    const freshJobs = jobs.slice(0, PER_RUN_CAP).map((item, index) => ({
      ...item,
      id: `b6-fresh-${String(index).padStart(3, '0')}`,
      firstSeenAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    }));
    const nextAlerts = [...alerts.slice(0, -1), deferred];
    const nextByRecipient = new Map(nextAlerts.map((item) => [item.email, [item]]));
    const nextRecipients = sortCompanyAlertRecipients(nextByRecipient);
    expect(nextRecipients[0]).toBe(deferred.email);
    expect(nextRecipients.slice(0, PER_RUN_CAP)).toContain(deferred.email);

    const recovered = buildRecipientSections(
      [deferred],
      freshJobs,
      NOW,
      DEDUP_WINDOW_MS,
      [...jobs, ...freshJobs],
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].jobs.map((item) => item.id)).toContain('b6-job-300');
    expect(recovered[0].alert.deliveryLedger['b6-job-300']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED,
      reason: 'per-run-cap',
    });
  });

  it('counts repeated deferrals per alert, not per job key', () => {
    const sourceAlert = alert('b6-alert-attempts', 'Acme');
    let persistedAlert = sourceAlert;

    for (let attempt = 1; attempt <= DEFERRED_MAX_ATTEMPTS; attempt += 1) {
      const sourceJob = job(`b6-alert-attempt-job-${attempt}`, 'Acme', 'acme');
      const [write] = planDeferredDeliveryWrites([{
        alert: persistedAlert,
        jobs: [sourceJob],
      }], NOW + attempt, 'consent-lookup-failed');
      persistedAlert = {
        ...persistedAlert,
        deliveryLedger: write.deliveryLedger,
        deliveryDeferredAttempts: write.deliveryDeferredAttempts,
        deliveryDeferredState: write.deliveryDeferredState,
      };
    }

    expect(persistedAlert.deliveryDeferredAttempts).toBe(DEFERRED_MAX_ATTEMPTS);
    expect(persistedAlert.deliveryDeferredState).toBe(DELIVERY_STATES.DEFERRED_EXHAUSTED);
  });

  it('persists repeated deferrals even when no job key is available', () => {
    const sourceAlert = alert('b6-alert-without-job', 'Acme');
    let persistedAlert = sourceAlert;

    for (let attempt = 1; attempt <= DEFERRED_MAX_ATTEMPTS; attempt += 1) {
      const [write] = planDeferredDeliveryWrites([{
        alert: persistedAlert,
        jobs: [],
      }], NOW + attempt, 'consent-lookup-failed');
      persistedAlert = {
        ...persistedAlert,
        deliveryLedger: write.deliveryLedger,
        deliveryDeferredAttempts: write.deliveryDeferredAttempts,
        deliveryDeferredState: write.deliveryDeferredState,
      };
    }

    expect(persistedAlert.deliveryDeferredAttempts).toBe(DEFERRED_MAX_ATTEMPTS);
    expect(persistedAlert.deliveryDeferredState).toBe(DELIVERY_STATES.DEFERRED_EXHAUSTED);
    expect(persistedAlert.deliveryLedger).toEqual({});
    expect(hasDeferredCompanyAlertWork([persistedAlert])).toBe(false);
    expect(buildRecipientSections(
      [persistedAlert],
      [],
      NOW,
      DEDUP_WINDOW_MS,
      [job('b6-alert-without-job-recovery', 'Acme', 'acme')],
    )).toEqual([]);
  });

  it('does not bulk-exhaust older ledger entries when the alert counter reaches its limit', () => {
    const sourceAlert = alert('b6-alert-terminal-scope', 'Acme', {
      deliveryDeferredAttempts: DEFERRED_MAX_ATTEMPTS - 1,
      deliveryDeferredState: DELIVERY_STATES.DEFERRED,
      deliveryLedger: {
        'b6-old-job-1': { state: DELIVERY_STATES.DEFERRED, at: NOW, attempts: 1 },
        'b6-old-job-2': { state: DELIVERY_STATES.DEFERRED, at: NOW, attempts: 2 },
      },
    });
    const [write] = planDeferredDeliveryWrites([{
      alert: sourceAlert,
      jobs: [job('b6-new-job', 'Acme', 'acme')],
    }], NOW + 1, 'consent-lookup-failed');

    expect(write.deliveryDeferredState).toBe(DELIVERY_STATES.DEFERRED_EXHAUSTED);
    expect(write.deliveryLedger['b6-new-job']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED_EXHAUSTED,
      attempts: DEFERRED_MAX_ATTEMPTS,
    });
    expect(write.deliveryLedger['b6-old-job-1']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED,
      attempts: 1,
    });
    expect(write.deliveryLedger['b6-old-job-2']).toMatchObject({
      state: DELIVERY_STATES.DEFERRED,
      attempts: 2,
    });
  });

  it('resets the alert-level defer state after an accepted delivery', async () => {
    const sourceAlert = alert('b6-reset-after-accepted', 'Acme', {
      deliveryDeferredAttempts: DEFERRED_MAX_ATTEMPTS,
      deliveryDeferredState: DELIVERY_STATES.DEFERRED_EXHAUSTED,
    });
    const sourceJob = job('b6-reset-after-accepted-job', 'Acme', 'acme');
    const db = serializedDb({
      [sourceAlert.ref.path]: { ...sourceAlert, ref: undefined },
    });

    expect(await finalizeRecipientDelivery(
      db,
      [{ ref: sourceAlert.ref, sentJobs: [sourceJob] }],
      'accepted',
      NOW,
    )).toBe(1);
    expect(db.docs.get(sourceAlert.ref.path)).toMatchObject({
      deliveryDeferredAttempts: 0,
      deliveryDeferredState: null,
    });
  });

  it('terminates a deferred job after bounded attempts and never requeues it', () => {
    const sourceAlert = alert('b6-exhausted', 'Acme');
    const sourceJob = job('b6-exhausted-job', 'Acme', 'acme');
    let ledger = {};
    let persistedAlert = sourceAlert;

    for (let attempt = 1; attempt <= DEFERRED_MAX_ATTEMPTS; attempt += 1) {
      const [write] = planDeferredDeliveryWrites([{
        alert: persistedAlert,
        jobs: [sourceJob],
      }], NOW + attempt, 'consent-lookup-failed');
      ledger = write.deliveryLedger;
      persistedAlert = {
        ...persistedAlert,
        deliveryLedger: ledger,
        deliveryDeferredAttempts: write.deliveryDeferredAttempts,
        deliveryDeferredState: write.deliveryDeferredState,
      };
      expect(ledger[sourceJob.id].attempts).toBe(attempt);
    }

    expect(ledger[sourceJob.id]).toMatchObject({
      state: DELIVERY_STATES.DEFERRED_EXHAUSTED,
      attempts: DEFERRED_MAX_ATTEMPTS,
    });
    expect(ledger[sourceJob.id].state).not.toBe('accepted');
    expect(ledger[sourceJob.id].state).not.toBe(DELIVERY_STATES.FAILED);
    expect(hasDeferredCompanyAlertWork([{ ...sourceAlert, deliveryLedger: ledger }])).toBe(false);
    expect(filterUnsentJobs(
      [sourceJob],
      {},
      NOW,
      DEDUP_WINDOW_MS,
      ledger,
    )).toEqual([]);
    expect(buildRecipientSections(
      [{ ...sourceAlert, deliveryLedger: ledger }],
      [],
      NOW,
      DEDUP_WINDOW_MS,
      [sourceJob],
    )).toEqual([]);
  });
});
