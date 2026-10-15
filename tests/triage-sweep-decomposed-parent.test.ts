/**
 * Sweep di triage: un padre decomposto è stato rimesso in `agent:fix-queued`.
 *
 * Il secondo passaggio di `triage-sweep.mjs` («triaged ma senza routing»)
 * riaccodava ogni 4 ore i padri `decomposed:1` a cui il drainer aveva appena
 * tolto la label di coda (PARENT-DEQUEUE): il drainer li ritoglieva con un
 * commento, e così via (73 commenti di dequeue sulla issue 7447; sulla 9443
 * quattro riaccodamenti su tredici erano di questo sweep).
 *
 * Seconda forma della stessa classe: un bucket giornaliero senza alcun item
 * `open` non ha lavoro per il fixer e non va riaccodato.
 */

import { describe, it, expect } from 'vitest';
import {
  DECOMPOSE_STAGE_LABELS,
  ROUTING_LABELS,
  isTriagedButNotRouted,
  queueVeto,
} from '../scripts/ci/triage-sweep.mjs';
import { dailyBucketTitle } from '../scripts/ci/followup-resolution-match.mjs';
import { isDecomposedParent } from '../scripts/ci/followup-drainer.mjs';

const DAY = '2026-09-21';
const REPO = 'owner/repo';

const labels = (...names: string[]) => names.map((name) => ({ name }));

function item(id: string, state: string) {
  return [
    `### ${id} — Proteggi il comportamento`,
    `- State: ${state}`,
    '- Sources: PR #8101; reviewer',
    '- Target file: `scripts/example.mjs`',
    '- Suggested action: aggiungi `firstGuard()` in `scripts/example.mjs`',
    '- Acceptance token: `firstGuard()`',
  ].join('\n');
}

function bucketBody(...states: string[]) {
  return [
    '## Batch',
    `- Daily key: ${DAY} (Europe/Zurich)`,
    '- State: sealed',
    `- Target repository: ${REPO}`,
    '',
    '## Item',
    ...states.flatMap((state, index) => [
      '',
      item(`FU-${DAY}-${String(index + 1).padStart(3, '0')}`, state),
    ]),
    '',
  ].join('\n');
}

const legacyParent = { title: 'follow-up(#7430): 6 item deferred', body: '' };

describe('triage-sweep: padri decomposti e stadio decompose', () => {
  it('una issue triagiata senza label di routing resta da instradare (controllo)', () => {
    const iss = { ...legacyParent, labels: labels('follow-up', 'agent:triaged') };
    expect(queueVeto(iss)).toBeNull();
    expect(isTriagedButNotRouted(iss)).toBe(true);
  });

  it('non riaccoda un padre decomposed:1 a cui il drainer ha tolto la coda', () => {
    // Forma di 7447 e 9443 subito dopo il PARENT-DEQUEUE.
    const iss = {
      ...legacyParent,
      labels: labels('follow-up', 'agent:triaged', 'fu-prio:high', 'decomposed:1'),
    };
    expect(queueVeto(iss)).toBe('decompose-stage');
    expect(isTriagedButNotRouted(iss)).toBe(false);
    expect(isTriagedButNotRouted({
      ...legacyParent,
      labels: ['follow-up', 'agent:triaged', 'decomposed:1'],
    })).toBe(false);
  });

  it.each(['agent:decompose-queued', 'agent:decompose'])(
    'non riaccoda una issue nello stadio %s',
    (stage) => {
      const iss = { ...legacyParent, labels: labels('follow-up', 'agent:triaged', stage) };
      expect(queueVeto(iss)).toBe('decompose-stage');
      expect(isTriagedButNotRouted(iss)).toBe(false);
    },
  );

  it('ogni DECOMPOSE_STAGE_LABELS veta, e la label del padre è quella del drainer', () => {
    for (const stage of DECOMPOSE_STAGE_LABELS) {
      expect(isTriagedButNotRouted({
        ...legacyParent,
        labels: labels('agent:triaged', stage),
      })).toBe(false);
    }
    // Se il drainer cambia la label del padre decomposto, questo sweep deve
    // seguirlo: altrimenti il ciclo riaccoda/dequeue riparte in silenzio.
    const parents = DECOMPOSE_STAGE_LABELS.filter((stage) => isDecomposedParent({ labels: labels(stage) }));
    expect(parents).toEqual(['decomposed:1']);
  });

  it('non allarga ROUTING_LABELS con le label di decomposizione', () => {
    for (const stage of DECOMPOSE_STAGE_LABELS) {
      expect(ROUTING_LABELS).not.toContain(stage);
    }
  });

  it('maybe-resolved resta fuori dal routing come prima', () => {
    const iss = { ...legacyParent, labels: labels('follow-up', 'agent:triaged', 'maybe-resolved') };
    expect(queueVeto(iss)).toBeNull();
    expect(isTriagedButNotRouted(iss)).toBe(false);
  });
});

describe('triage-sweep: bucket giornaliero senza item open', () => {
  const title = dailyBucketTitle(DAY, REPO, 2);
  const triaged = labels('follow-up', 'agent:triaged');

  it('riaccoda il bucket che ha ancora un item open (controllo)', () => {
    const iss = { title, body: bucketBody('done', 'open'), labels: triaged };
    expect(queueVeto(iss)).toBeNull();
    expect(isTriagedButNotRouted(iss)).toBe(true);
  });

  it('non riaccoda il bucket i cui item sono tutti done o blocked', () => {
    const iss = { title, body: bucketBody('done', 'blocked'), labels: triaged };
    expect(queueVeto(iss)).toBe('bucket-no-open-item');
    expect(isTriagedButNotRouted(iss)).toBe(false);
  });

  it('una issue non giornaliera con lo stesso corpo si comporta come prima', () => {
    const iss = { ...legacyParent, body: bucketBody('done', 'blocked'), labels: triaged };
    expect(queueVeto(iss)).toBeNull();
    expect(isTriagedButNotRouted(iss)).toBe(true);
  });

  it('corpo assente o illeggibile: nessun veto (comportamento di prima)', () => {
    // Riga letta senza il campo body.
    expect(isTriagedButNotRouted({ title, labels: triaged })).toBe(true);
    // Nessun item con id stabile: il parse non dimostra nulla.
    expect(isTriagedButNotRouted({ title, body: '', labels: triaged })).toBe(true);
    // Fence non terminata: gli item dopo la fence sono invisibili al parser.
    const unterminated = `${bucketBody('done')}\n\`\`\`md\n${item(`FU-${DAY}-002`, 'open')}\n`;
    expect(queueVeto({ title, body: unterminated, labels: triaged })).toBeNull();
  });
});
