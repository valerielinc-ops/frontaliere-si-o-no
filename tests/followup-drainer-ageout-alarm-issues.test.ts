/**
 * followup-drainer — l'AGE-OUT non chiude gli allarmi che hanno un chiuditore.
 *
 * Il caso reale, 2026-09-25 (fixture `issue-7918.json`, dalla issue vera):
 * `CI Failure (build): Deploy to GitHub Pages` (#7918), creata il 07/09, è
 * stata RIAPERTA dal leg del deploy alle 23:56:22Z per un build rosso e chiusa
 * da questo drainer alle 00:07:16Z come «nessun evento significativo da ≥7gg».
 * La riapertura e il suo commento 🔁 li scrive un bot, quindi l'ultimo evento
 * significativo era un verdetto FIX_OUTCOME del 16/09, e l'età si misurava dalla
 * creazione: undici minuti dopo l'allarme, il deploy era rosso e nessuna issue
 * aperta lo diceva.
 *
 * Il contratto fissato qui:
 *  - un allarme la cui chiusura spetta a chi lo apre non è mai candidato
 *    all'age-out (il replay di #7918 lo prova, con un follow-up gemello di
 *    controllo che invece resta eleggibile);
 *  - gli allarmi SENZA chiuditore restano candidati, perché per loro l'age-out è
 *    l'unico chiuditore che esiste — altrimenti la fix coniererebbe issue
 *    immortali;
 *  - ogni famiglia esclusa ha davvero un chiuditore nel repo.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAgeOutCandidate,
  isAgeOutEligible,
  isOwnerClosedFailureAlarm,
  lastSignificantActivityAt,
} from '../scripts/ci/followup-drainer.mjs';
import { scopedTitle } from '../scripts/ci/scan-job-timeouts.mjs';
import { TITLE_RE } from '../scripts/ci/close-recovered-failure-issues.mjs';
import { TITLE_PREFIX as DIST_TITLE_PREFIX } from '../scripts/ci/report-validate-dist-failure.mjs';
import { inventory } from '../scripts/ci/failure-issue-inventory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ISSUE_7918 = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/followup-drainer-ageout-alarm/issue-7918.json'), 'utf8',
));

// I default del drainer (AGEOUT_DAYS / AGEOUT_INACTIVE_DAYS).
const AGEOUT_DAYS = 10;
const INACTIVE_DAYS = 7;
const DAY = 86_400_000;

describe('replay #7918 — riaperta alle 23:56, chiusa dal drainer alle 00:07', () => {
  const now = Date.parse(ISSUE_7918.drainerClosedAt);
  const significantAt = lastSignificantActivityAt(ISSUE_7918, ISSUE_7918.comments);
  // Un gemello identico in tutto tranne il titolo: un follow-up normale.
  const twin = { ...ISSUE_7918, title: 'follow-up(#1234): un item deferred' };

  it('la misura del drainer era quella che ha chiuso: la riapertura del bot non conta', () => {
    // L'ultimo evento significativo è il verdetto FIX_OUTCOME del 16/09, non la
    // riapertura di 11 minuti prima: il commento 🔁 è di un bot.
    expect(significantAt).toBe(Date.parse('2026-09-16T16:37:50Z'));
    expect((now - Date.parse(ISSUE_7918.updatedAt)) / 60_000).toBeCloseTo(10.9, 1);
    // Il controllo: con queste date e queste label l'age-out chiude davvero.
    expect(isAgeOutEligible(twin, {
      now, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
    })).toBe(true);
  });

  it('l allarme non è più candidato: la sua chiusura spetta al deploy verde', () => {
    expect(isOwnerClosedFailureAlarm(ISSUE_7918)).toBe(true);
    expect(isAgeOutCandidate(ISSUE_7918, { now, ageOutDays: AGEOUT_DAYS })).toBe(false);
    expect(isAgeOutEligible(ISSUE_7918, {
      now, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
    })).toBe(false);
  });

  it('nemmeno dopo mesi di silenzio: non è l inattività a decidere', () => {
    const later = now + 90 * DAY;
    expect(isAgeOutEligible(ISSUE_7918, {
      now: later, ageOutDays: AGEOUT_DAYS, inactiveDays: INACTIVE_DAYS, significantAt,
    })).toBe(false);
  });
});

describe('quali allarmi hanno un chiuditore, e quali no', () => {
  const old = (title: string) => ({
    title,
    labels: [{ name: 'bug' }, { name: 'agent:triaged' }],
    createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
    updatedAt: new Date(Date.now() - 20 * DAY).toISOString(),
  });
  const candidate = (title: string) => isAgeOutCandidate(old(title), { now: Date.now(), ageOutDays: AGEOUT_DAYS });

  it.each([
    'Workflow Failure: Deploy to GitHub Pages',
    'CI Failure: Publish to GitHub Pages (deploy + validate)',
    'CI Failure (build): Deploy to GitHub Pages',
    'CI Failure (deploy): Publish to GitHub Pages (deploy + validate)',
    'Validation Failure (dist): post-deploy',
    'Validation Failure (live): post-deploy',
  ])('%s → mai age-out', (title) => {
    expect(isOwnerClosedFailureAlarm({ title })).toBe(true);
    expect(candidate(title)).toBe(false);
  });

  it('`CI Failure (<evento>)` di una run fuori da main resta age-out: il reconciler la ignora', () => {
    // È il titolo che `scan-job-timeouts.mjs` conia per un timeout su un branch
    // di PR: fuori dal `TITLE_RE` del reconciler per costruzione, nessuno lo
    // chiude. Il drainer ne ha chiusi così (#6522) ed è giusto che continui.
    const prTitle = scopedTitle({ head_branch: 'fix/issue-1', event: 'pull_request', name: 'tests' });
    expect(prTitle).toBe('CI Failure (pull_request): tests');
    expect(isOwnerClosedFailureAlarm({ title: prTitle })).toBe(false);
    expect(candidate(prTitle)).toBe(true);
    // La stessa run su main ha il titolo del reconciler, quindi un chiuditore.
    const mainTitle = scopedTitle({ head_branch: 'main', event: 'push', name: 'tests' });
    expect(isOwnerClosedFailureAlarm({ title: mainTitle })).toBe(true);
  });

  it('`Campaign goal FAILED` resta age-out: il suo reporter dichiara di non avere un closer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/campaign-goal-check.mjs'), 'utf8');
    expect(src).toContain('Non esiste un closer');
    expect(isOwnerClosedFailureAlarm({ title: 'Campaign goal FAILED: alert_funnel_conversion' })).toBe(false);
    expect(candidate('Campaign goal FAILED: alert_funnel_conversion')).toBe(true);
  });

  it('il verdetto è stabile su valutazioni ripetute (nessuna regex con stato)', () => {
    // Una regex con flag `g` o `y` porta `lastIndex` da una `.test()` all'altra
    // e alterna vero/falso sullo stesso titolo: il drainer valuta centinaia di
    // issue per tick.
    expect(TITLE_RE.global || TITLE_RE.sticky).toBe(false);
    for (const title of ['Workflow Failure: X', 'CI Failure (build): X', 'Validation Failure (live): X']) {
      const verdicts = Array.from({ length: 5 }, () => isOwnerClosedFailureAlarm({ title }));
      expect(verdicts).toEqual([true, true, true, true, true]);
    }
  });

  it('un follow-up normale non è toccato dalla fix', () => {
    expect(isOwnerClosedFailureAlarm({ title: 'follow-up(#1): qualcosa' })).toBe(false);
    expect(candidate('follow-up(#1): qualcosa')).toBe(true);
  });
});

describe('ogni famiglia esclusa ha davvero un chiuditore nel repo', () => {
  // Una famiglia esclusa senza chiuditore sarebbe una issue immortale: è lo
  // stesso difetto che `failure-issue-closers.test.ts` impedisce per gli opener.
  const closers = inventory().flatMap((rec: { file: string; closers: Array<{ title: string }> }) =>
    rec.closers.map((c) => ({ file: rec.file, title: c.title })));
  const closedIn = (title: string) => closers.filter((c: { title: string }) => c.title === title).map((c: { file: string }) => c.file);

  it('`Workflow|CI|Crawler Failure: <nome>` è il TITLE_RE del reconciler centrale', () => {
    for (const title of ['Workflow Failure: X', 'CI Failure: X', 'Crawler Failure: X']) {
      expect(TITLE_RE.test(title)).toBe(true);
      expect(isOwnerClosedFailureAlarm({ title })).toBe(true);
    }
  });

  it('`CI Failure (build)` lo chiude il job aggregato del deploy', () => {
    expect(closedIn('CI Failure (build): Deploy to GitHub Pages')).toEqual(['deploy.yml']);
  });

  it('`CI Failure (deploy)` lo chiude lo step gemello della pubblicazione', () => {
    expect(closedIn('CI Failure (deploy): Publish to GitHub Pages (deploy + validate)')).toEqual(['deploy-publish.yml']);
  });

  it('`Validation Failure (live)` lo chiude lo step gemello del validatore live', () => {
    expect(closedIn('Validation Failure (live): post-deploy')).toEqual(['post-deploy-validate-live.yml']);
  });

  it('`Validation Failure (dist)` lo chiude il `--mode resolve` del suo reporter', () => {
    expect(DIST_TITLE_PREFIX).toBe('Validation Failure (dist): ');
    expect(isOwnerClosedFailureAlarm({ title: `${DIST_TITLE_PREFIX}audit:all` })).toBe(true);
  });
});
