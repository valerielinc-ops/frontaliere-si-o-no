/**
 * Letture dopo i gate e piccoli sprechi (perf-plan PR 6).
 *
 * Prima: `newsletter_subscribers/{email}` e `job_alert_subscribers/{email}` letti per
 * ogni destinatario (~14k, ~28k letture) PRIMA della cadenza, benche' solo ~3,8k
 * alert siano in programma oggi. Ora il documento del canale (cadenza, esclusione,
 * ritorno sul sito) si legge per tutti, e quello newsletter solo per chi puo'
 * ricevere oggi. `first_discovery` solo per i profili che possono essere vuoti.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildJobAlertAuxiliaryReadPlan,
  buildJobAlertProfileRefs,
  mayHaveEmptyProfile,
} from '../scripts/lib/job-alert-profile-reads.mjs';
import { buildAlertProfile, mergeAlertSubscriberSignals } from '../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause } from '../scripts/lib/job-alert-zero-match-diagnosis.mjs';
import { isSameIpGeo } from '../scripts/lib/job-alert-ip-geography.mjs';
import { RETRY_QUARANTINE_RETENTION_DAYS, purgeStaleQuarantinedRetryRows } from '../scripts/send-job-alerts.mjs';
import { derivePersonalizationPatch } from '../functions/src/lib/subscriberPersonalization.js';
import {
  isJobAlertDueToday,
  reactivationAfterReturnVisit,
} from '../scripts/lib/jobAlertCadence.mjs';

const source = fs.readFileSync(path.resolve(__dirname, '../scripts/send-job-alerts.mjs'), 'utf8');

function fixtureDb() {
  const node = (segments: string[]): any => ({
    path: segments.join('/'),
    collection: (name: string) => ({ doc: (id: string) => node([...segments, name, id]) }),
  });
  return { collection: (name: string) => ({ doc: (id: string) => node([name, id]) }) } as any;
}

describe('profile read plan', () => {
  it('reads ONE parent document per recipient when asked for just the channel or just the newsletter', () => {
    const db = fixtureDb();
    const emails = ['A@example.test', 'b@example.test', 'a@example.test'];
    expect(buildJobAlertProfileRefs(db, emails, { only: 'job_alert' }).map((r: any) => r.path)).toEqual([
      'job_alert_subscribers/a@example.test', 'job_alert_subscribers/b@example.test',
    ]);
    expect(buildJobAlertProfileRefs(db, emails, { only: 'newsletter' }).map((r: any) => r.path)).toEqual([
      'newsletter_subscribers/a@example.test', 'newsletter_subscribers/b@example.test',
    ]);
    // The historical two-parent read is unchanged for any other caller.
    expect(buildJobAlertProfileRefs(db, emails)).toHaveLength(4);
  });

  it('on a day with 14.000 recipients and 3.800 scheduled alerts it reads ~10.000 fewer documents', () => {
    const db = fixtureDb();
    const everyone = Array.from({ length: 14_000 }, (_, i) => `r${i}@example.test`);
    const scheduled = everyone.slice(0, 3_500);
    const before = buildJobAlertProfileRefs(db, everyone).length;
    const after = buildJobAlertProfileRefs(db, everyone, { only: 'job_alert' }).length
      + buildJobAlertProfileRefs(db, scheduled, { only: 'newsletter' }).length;
    expect(before).toBe(28_000);
    expect(before - after).toBeGreaterThanOrEqual(8_000);
  });

  it('the auxiliary plan reads first_discovery only for the recipients that can have an empty profile, with an explicit layout', () => {
    const db = fixtureDb();
    const plan = buildJobAlertAuxiliaryReadPlan(db, ['a@example.test', 'b@example.test', 'c@example.test'], {
      discoveryEmails: new Set(['b@example.test']),
    });
    expect(plan.entries).toEqual([
      { email: 'a@example.test', kind: 'personalization' },
      { email: 'b@example.test', kind: 'personalization' },
      { email: 'b@example.test', kind: 'first_discovery' },
      { email: 'c@example.test', kind: 'personalization' },
    ]);
    expect(plan.refs.map((r: any) => r.path)).toEqual([
      'newsletter_subscribers/a@example.test/private/personalization',
      'newsletter_subscribers/b@example.test/private/personalization',
      'job_alert_subscribers/b@example.test/delivery_state/first_discovery',
      'newsletter_subscribers/c@example.test/private/personalization',
    ]);
    // No filter = the previous behaviour (both documents for everybody).
    expect(buildJobAlertAuxiliaryReadPlan(db, ['a@example.test']).refs).toHaveLength(2);
  });
});

describe('mayHaveEmptyProfile is a SUPERSET of what the planner sees as empty', () => {
  it('never says "not empty" for a profile the planner (which has more signals) classifies as empty', () => {
    let state = 99;
    const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
    let plannerEmpty = 0;
    let supersetEmpty = 0;
    for (let i = 0; i < 1500; i++) {
      const alert: any = { id: `a${i}`, email: `u${i}@example.test`, locale: 'it' };
      if (rand() < 0.3) alert.keywords = [pick(['infermiere', 'cuoco', 'java'])];
      if (rand() < 0.3) alert.locations = [pick(['Lugano', 'Zurich'])];
      if (rand() < 0.2) alert.cantonFilter = ['TI'];
      if (rand() < 0.15) alert.sectors = ['it'];
      if (rand() < 0.1) alert.sourceJobTitle = 'Software Engineer';
      const newsletter: any = {};
      if (rand() < 0.2) newsletter.job_company = 'Coop Ticino';
      if (rand() < 0.2) newsletter.job_search_query = pick(['infermiere', 'it ab']);
      if (rand() < 0.2) newsletter.location_interest = 'lugano';
      const channel: any = rand() < 0.2 ? { job_category: 'sanità' } : {};
      // The planner also folds in browsing signals the pre-read cannot know.
      const extras = {
        behaviorTokens: rand() < 0.3 ? ['manager'] : [],
        behaviorLocations: rand() < 0.3 ? ['lugano'] : [],
        cvSkills: rand() < 0.1 ? ['python'] : [],
        sourceJobLocations: [],
        strongLocations: [],
        cityToCanton: new Map(),
      };
      const full = buildAlertProfile(alert, mergeAlertSubscriberSignals(newsletter, channel), extras);
      const plannerSaysEmpty = classifyZeroMatchCause(full) === 'empty-profile';
      const preRead = mayHaveEmptyProfile(alert, newsletter, channel);
      if (plannerSaysEmpty) { plannerEmpty += 1; expect(preRead, `alert ${i}`).toBe(true); }
      if (preRead) supersetEmpty += 1;
    }
    expect(plannerEmpty).toBeGreaterThan(20);
    expect(supersetEmpty).toBeGreaterThanOrEqual(plannerEmpty);
  });
});

describe('the cadence gate needs no newsletter document', () => {
  it('isJobAlertDueToday is a function of (alert, channel document, day) alone', () => {
    const alert = { id: 'a', email: 'x@example.test', active: true };
    const out = isJobAlertDueToday({ alert, sub: {}, todayIso: '2026-11-14', nowMs: Date.parse('2026-11-14T05:00:00Z') });
    expect(typeof out.due).toBe('boolean');
    expect(isJobAlertDueToday.length).toBeLessThanOrEqual(1);
  });

  it('a refusal of the reactivation probe (newsletter: null) is final; only a pass needs the newsletter to confirm', () => {
    const decayed = { id: 'a', email: 'x@example.test', active: true, cadence_state: 'decayed', cadence_decayed_at: '2026-10-01T00:00:00Z', userId: 'u1' };
    const probeNoVisit = reactivationAfterReturnVisit({ alert: decayed, sub: {}, newsletter: null, nowIso: '2026-11-14T00:00:00Z' });
    expect(probeNoVisit.reactivate).toBe(false);
    // The same refusal with a newsletter document can only stay a refusal.
    expect(reactivationAfterReturnVisit({ alert: decayed, sub: {}, newsletter: { status: 'active' }, nowIso: '2026-11-14T00:00:00Z' }).reactivate).toBe(false);
  });

  it('the sender evaluates the cadence BEFORE reading the newsletter document', () => {
    const channelRead = source.indexOf("only: 'job_alert'");
    const cadence = source.indexOf('const decision = isJobAlertDueToday({');
    const newsletterRead = source.indexOf("only: 'newsletter'");
    const suppression = source.indexOf('if (suppressedEmails.size > 0) {');
    expect(channelRead).toBeGreaterThan(0);
    expect(channelRead).toBeLessThan(cadence);
    expect(cadence).toBeLessThan(newsletterRead);
    expect(newsletterRead).toBeLessThan(suppression);
    // The newsletter read is over what survived the gate, not over `alertEmails`.
    expect(source).toMatch(/const newsletterEmails = \[\.\.\.new Set\(alerts\.map/);
  });

  it('suppression, consent and cooldown still run before planning for every sendable alert', () => {
    const main = source.slice(source.indexOf('async function main()'));
    const order = ['isCrossChannelStop(data)', 'if (suppressedEmails.size > 0) {', 'evaluateJobAlertConsent({', 'newsletterCooldownSet.has(', 'funnelIn.eligible = alerts.length', 'forEachJobAlertPlanBatch(alerts'];
    let last = -1;
    for (const needle of order) {
      const at = main.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
  });
});

describe('IP geography: no write when the value is unchanged', () => {
  const stored = { ipHash: 'h', source: 'geojs_ip_prefix', capturedAt: 1, attempts: 1, country: 'IT', region: 'Lombardy', city: 'Como', accuracyKm: 5, expiresAt: 9 };
  it('is the same regardless of key order (Firestore returns sorted keys)', () => {
    const reordered = Object.fromEntries(Object.entries(stored).reverse());
    expect(isSameIpGeo(reordered, stored)).toBe(true);
    expect(isSameIpGeo(stored, stored)).toBe(true);
  });
  it('differs when any field changes, and with nothing stored', () => {
    expect(isSameIpGeo({ ...stored, capturedAt: 2 }, stored)).toBe(false);
    expect(isSameIpGeo({ ...stored, city: 'Lecco' }, stored)).toBe(false);
    expect(isSameIpGeo(stored, null)).toBe(false);
    expect(isSameIpGeo(null, stored)).toBe(false);
  });
  it('the sender skips the transaction when the value is unchanged', () => {
    expect(source).toMatch(/if \(isSameIpGeo\(geo, channel\.discovery_ip_geo\)\) \{[\s\S]*?\} else if \(!DRY_RUN && !ALLOWED_EMAILS\) \{/);
  });
});

describe('retry queue: only actionable rows, and old quarantine rows are purged', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function queueDb(rows: Array<{ id: string; state: string; quarantinedAtMs?: number }>, options: { failQuery?: boolean } = {}) {
    const deleted: string[] = [];
    const queries: Array<{ field: string; op: string; value: any; limit?: number }> = [];
    const db: any = {
      collection: () => ({
        where: (field: string, op: string, value: any) => {
          const query = { field, op, value, limit: undefined as number | undefined };
          queries.push(query);
          const chain: any = {
            limit: (n: number) => { query.limit = n; return chain; },
            get: async () => {
              if (options.failQuery) throw new Error('index missing');
              const docs = rows
                .filter((row) => row.quarantinedAtMs !== undefined && row.quarantinedAtMs < value.getTime())
                .slice(0, query.limit ?? rows.length)
                .map((row) => ({ id: row.id, ref: { id: row.id }, data: () => ({ deliveryState: row.state }) }));
              return { docs, size: docs.length, empty: docs.length === 0 };
            },
          };
          return chain;
        },
      }),
      batch: () => {
        const ids: string[] = [];
        return { delete: (ref: any) => ids.push(ref.id), commit: async () => { deleted.push(...ids); } };
      },
    };
    return { db, deleted, queries };
  }

  it('queries only quarantinedAt older than 30 days, bounded, and deletes only quarantined rows', async () => {
    const now = Date.parse('2026-11-14T05:00:00Z');
    const { db, deleted, queries } = queueDb([
      { id: 'old-q', state: 'quarantined', quarantinedAtMs: now - 45 * DAY },
      { id: 'fresh-q', state: 'quarantined', quarantinedAtMs: now - 5 * DAY },
      // Should never match the range, but is still refused if it did.
      { id: 'old-but-actionable', state: 'definite-failure', quarantinedAtMs: now - 60 * DAY },
    ]);
    const removed = await purgeStaleQuarantinedRetryRows(db, { nowMs: now });
    expect(removed).toBe(1);
    expect(deleted).toEqual(['old-q']);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ field: 'quarantinedAt', op: '<', limit: 400 });
    expect(queries[0].value.getTime()).toBe(now - RETRY_QUARANTINE_RETENTION_DAYS * DAY);
  });

  it('a purge failure never stops the retries', async () => {
    const { db } = queueDb([], { failQuery: true });
    await expect(purgeStaleQuarantinedRetryRows(db, { nowMs: Date.now() })).resolves.toBe(0);
  });

  it('processRetryQueue legge la coda per intero: una riga senza deliveryState non e\' selezionabile con una query e va messa in quarantena, mai ignorata', () => {
    const start = source.indexOf('async function processRetryQueue(');
    const body = source.slice(start, start + 6000);
    expect(body).toMatch(/await purgeStaleQuarantinedRetryRows\(db\);\s*const snap = await db\.collection\(RETRY_COLLECTION\)\.get\(\);/);
    expect(body).not.toMatch(/where\('deliveryState'/);
    expect(body).toMatch(/quarantineUnclassifiedRetryItem\(db, doc, data, FieldValue\)/);
  });
});

describe('personalization enrichment writes only when something changes', () => {
  it('derivePersonalizationPatch is null once its own patch has been applied', () => {
    const subscriber: any = { email: 'x@example.test' };
    const alerts = [{ locations: ['Lugano'], sectors: ['it'], keywords: ['java'] }];
    const first = derivePersonalizationPatch({ subscriber, personalization: null, alerts });
    expect(first).not.toBeNull();
    const second = derivePersonalizationPatch({ subscriber: { ...subscriber, ...first }, personalization: null, alerts });
    expect(second).toBeNull();
  });
});
