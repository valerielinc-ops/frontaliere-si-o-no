/**
 * Bucket follow-up illeggibili: maybe-resolved residuo con item open e body
 * riscritto a mano fuori formato.
 *
 * Due difetti che il reconciler vedeva (allarme «Bucket follow-up illeggibile
 * dal parser») ma per costruzione non correggeva:
 *   1. `maybe-resolved` su un bucket giornaliero con un item ancora `open`:
 *      nessun processo deterministico la toglieva, quindi il conflitto restava
 *      nell'allarme per sempre (10831, 10283, 9609, 8809, 8334).
 *   2. un corpo riscritto a mano fuori formato (8705): l'allarme chiedeva di
 *      «rigenerare il corpo canonico» senza uno strumento che passasse da
 *      `rebuildDailyBody`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  bucketAlarmBody,
  bucketStructuralVeto,
  decideReconcileAction,
  hasLiveReconcileFlag,
  maybeResolvedReleaseCommentBody,
  planBucketAlarm,
  planMaybeResolvedRelease,
  shouldEnsureVerifyLabel,
} from '../scripts/ci/reconcile-followups.mjs';
import { canonicalDailyBucket } from '../scripts/ci/rebuild-daily-bucket.mjs';
import { bucketLabelEditArgs, releasesVerifyLabel } from '../scripts/ci/route-already-fixed.mjs';
import { MAYBE_RESOLVED_RELEASE_MARKER } from '../scripts/ci/lib/followup-item-evidence.mjs';
import { parseFollowupItems } from '../scripts/ci/followup-resolution-match.mjs';

const fixture = (name: string) => JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), 'tests/fixtures/reconcile-bucket-alarm', name), 'utf8',
));
const bucket8705 = fixture('issue-8705.json');
const bucket11003 = fixture('issue-11003.json');

const DAY = '2026-10-02';
const REPO = 'valerielinc-ops/frontaliere-si-o-no';
const item = (n: number, state: string) => [
  `### FU-${DAY}-${String(n).padStart(3, '0')} — item ${n}`,
  `- State: ${state}`,
  `- Target repository: ${REPO}`,
  '- Target file: `scripts/ci/example.mjs`',
].join('\n');
const dailyIssue = (number: number, labels: string[], states: string[]) => ({
  number,
  title: `follow-up(daily:${DAY}): ${states.length} items — ${REPO}`,
  createdAt: '2026-10-02T06:00:00Z',
  labels: labels.map((name) => ({ name })),
  body: [`- Daily key: ${DAY}`, '- State: sealed', `- Target repository: ${REPO}`, '', ...states.map((state, i) => item(i + 1, state))].join('\n\n'),
});

const bot = { author: { login: 'github-actions' }, authorAssociation: 'NONE' };
const stranger = { author: { login: 'someone-else' }, authorAssociation: 'NONE' };
const flag = { ...bot, body: '<!-- reconcile-bot:flag -->\n🤖 **Reconcile (auto)**' };

describe('Bucket follow-up illeggibili: maybe-resolved residuo con item open e body riscritto a mano fuori formato', () => {
  describe('il reconciler toglie da sé maybe-resolved quando il bucket ha un item open', () => {
    it('pianifica il rilascio solo sui bucket giornalieri con la label e almeno un item open o in-progress', () => {
      const issues = [
        dailyIssue(10831, ['follow-up', 'maybe-resolved', 'fu-parked'], ['open', 'done']),
        dailyIssue(10283, ['follow-up', 'maybe-resolved'], ['blocked', 'in-progress']),
        dailyIssue(1, ['follow-up', 'maybe-resolved'], ['done', 'blocked']),
        dailyIssue(2, ['follow-up'], ['open']),
        { number: 3, title: 'Workflow Failure: x', labels: [{ name: 'maybe-resolved' }], body: '- State: open' },
      ];
      const plan = planMaybeResolvedRelease(issues);
      expect(plan.map((entry: { number: number }) => entry.number)).toEqual([10831, 10283]);
      expect(plan[0].ids).toEqual([`FU-${DAY}-001`]);
      expect(plan[1].ids).toEqual([`FU-${DAY}-002`]);
    });

    it('dopo il rilascio l’allarme non elenca più il conflitto `maybe-resolved` con item open', () => {
      const issue = dailyIssue(10831, ['follow-up', 'maybe-resolved'], ['open', 'done']);
      const before = planBucketAlarm([issue], { now: Date.parse('2026-10-04T06:00:00Z') });
      expect(before.conflicts.map((entry: { number: number }) => entry.number)).toEqual([10831]);
      const released = { ...issue, labels: issue.labels.filter((label) => label.name !== 'maybe-resolved') };
      expect(planBucketAlarm([released], { now: Date.parse('2026-10-04T06:00:00Z') }).conflicts).toEqual([]);
    });

    it('il rilascio del bot non vale come obiezione umana: il ciclo flag → chiusura riparte', () => {
      const release = { ...bot, body: maybeResolvedReleaseCommentBody({ ids: [`FU-${DAY}-001`] }) };
      expect(hasLiveReconcileFlag([flag])).toBe(true);
      expect(hasLiveReconcileFlag([flag, release])).toBe(false);
      expect(hasLiveReconcileFlag([flag, release, flag])).toBe(true);
      expect(hasLiveReconcileFlag(null)).toBeNull();
      // Prima: label assente dopo un flag = obiezione → mai rimessa, mai chiusa.
      expect(shouldEnsureVerifyLabel({ comments: [flag], labelNames: ['follow-up'] })).toBe(false);
      // Dopo il rilascio del bot la richiesta di verifica puo' rimettere la label.
      expect(shouldEnsureVerifyLabel({ comments: [flag, release], labelNames: ['follow-up'] })).toBe(true);
      // E al giro in cui il bucket torna risolto riparte dal primo stadio (flag), non resta zitto.
      const hasPriorFlag = hasLiveReconcileFlag([flag, release]);
      expect(decideReconcileAction({
        resolved: true, hasMaybeResolved: false, hasPriorFlag, isAggregate: false, blocked: false, strongEvidence: true,
      })).toBe('flag');
    });

    it('sibling: anche route-already-fixed, quando toglie maybe-resolved perché restano item open, firma il rilascio', () => {
      const args = bucketLabelEditArgs(['follow-up', 'maybe-resolved'], { openRemaining: true });
      expect(releasesVerifyLabel(args)).toBe(true);
      expect(releasesVerifyLabel(bucketLabelEditArgs(['follow-up'], { openRemaining: true }))).toBe(false);
      expect(releasesVerifyLabel(bucketLabelEditArgs(['follow-up', 'maybe-resolved'], { openRemaining: false }))).toBe(false);
      const routed = { ...bot, body: `${MAYBE_RESOLVED_RELEASE_MARKER}\n<!-- FU_ITEM_BLOCKED: item=FU-${DAY}-001 reason=no-root-cause -->` };
      expect(hasLiveReconcileFlag([flag, routed])).toBe(false);
    });

    it('un marker di rilascio scritto da un autore non fidato non cancella l’obiezione', () => {
      const forged = { ...stranger, body: maybeResolvedReleaseCommentBody({ ids: [`FU-${DAY}-001`] }) };
      expect(hasLiveReconcileFlag([flag, forged])).toBe(true);
      expect(shouldEnsureVerifyLabel({ comments: [flag, forged], labelNames: ['follow-up'] })).toBe(false);
    });
  });

  describe('gli edit dei bucket passano da rebuildDailyBody', () => {
    it('il corpo reale di 8705 diventa canonico: titolo, testa e stati, senza perdere item né stati', () => {
      expect(bucketStructuralVeto(bucket8705)).toBe('mismatched-target-repository');
      const result = canonicalDailyBucket({ title: bucket8705.title, body: bucket8705.body });
      expect(result.ok).toBe(true);
      expect(result.title).toBe('follow-up(daily:2026-09-15): 7 items — valerielinc-ops/frontaliere-si-o-no');
      expect(bucketStructuralVeto({ title: result.title, body: result.body })).toBeNull();
      const signature = (body: string) => parseFollowupItems(body).map((entry: { id: string | null; state: string | null }) => `${entry.id}:${entry.state}`);
      const originalIds = [...bucket8705.body.matchAll(/^#{2,3} (FU-2026-09-15-\d{3})/gmu)].map((match) => match[1]);
      expect(signature(result.body).map((entry) => entry.split(':')[0])).toEqual(originalIds);
      expect(signature(result.body)).toEqual(expect.arrayContaining([
        'FU-2026-09-15-001:done', 'FU-2026-09-15-006:blocked', 'FU-2026-09-15-009:blocked',
      ]));
      // Il testo umano dopo lo stato non si perde: diventa una nota.
      expect(result.body).toContain('il catalogo/successor endpoint ufficiale non espone ancora una risposta utilizzabile');
      expect(result.body).toMatch(/^- State: sealed$/mu);
      // Idempotente: un bucket gia' canonico non cambia piu'.
      const again = canonicalDailyBucket({ title: result.title, body: result.body });
      expect(again).toMatchObject({ ok: true, title: result.title, body: result.body });
    });

    it('un bucket sano (11003) resta leggibile e con gli stessi item', () => {
      const result = canonicalDailyBucket({ title: bucket11003.title, body: bucket11003.body });
      expect(result.ok).toBe(true);
      expect(result.title).toBe(bucket11003.title);
      expect(bucketStructuralVeto({ title: result.title, body: result.body })).toBeNull();
      const ids = (body: string) => parseFollowupItems(body).map((entry: { id: string | null; state: string | null }) => `${entry.id}:${entry.state}`);
      expect(ids(result.body)).toEqual(ids(bucket11003.body));
    });

    it('rifiuta di indovinare uno stato non leggibile o doppio', () => {
      const unknownState = dailyIssue(4, [], ['open']).body.replace('- State: open', '- State: forse fatto');
      expect(canonicalDailyBucket({ title: dailyIssue(4, [], ['open']).title, body: unknownState }))
        .toMatchObject({ ok: false, reason: expect.stringContaining('item-state') });
      const doubleState = dailyIssue(5, [], ['open']).body.replace('- State: open', '- State: open\n- State: done');
      expect(canonicalDailyBucket({ title: dailyIssue(5, [], ['open']).title, body: doubleState }))
        .toMatchObject({ ok: false });
    });

    it('l’allarme indica lo strumento canonico invece di una riscrittura a mano', () => {
      const plan = planBucketAlarm([bucket8705], { now: Date.parse(bucket8705.createdAt) + 72 * 3_600_000 });
      const body = bucketAlarmBody({ ...plan, repository: REPO });
      expect(body).toContain(`node scripts/ci/rebuild-daily-bucket.mjs --issue 8705 --repo ${REPO}`);
      expect(body).toContain('--write');
    });
  });
});
