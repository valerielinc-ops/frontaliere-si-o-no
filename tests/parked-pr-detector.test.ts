/**
 * parked-pr-detector: quali draft sono "parcheggiate", cioè fuori da OGNI
 * strato del ciclo contemporaneamente.
 *
 * Il difetto che copre non sta in una riga di codice, sta nella SOMMA di sei
 * skip ognuno dei quali è corretto da solo:
 *
 *   - `pr-review-loop`      → «PR #N è draft → skip review».
 *   - `auto-merge-eval`     → «PR #N è draft — skip».
 *   - `auto-merge-sweep`    → `selectSweepCandidates` filtra `isDraft`.
 *   - `pr-autorebase`       → `filter((p) => !p.isDraft)`.
 *   - `stale-pr-rescuer`    → «Le draft NON vanno toccate», necessario alla sua classe C.
 *   - `recycle-stale-prs`   → agisce solo su `stale-review`, che una draft non
 *                             riceve MAI proprio perché il rescuer la salta.
 *
 * Una draft aperta non viene quindi revisionata, mergiata, rebasata, etichettata
 * stale né riciclata: resta aperta finché un umano non ci inciampa, e nessuno
 * gli dice di farlo. È rimasta così nanakokyobashi-rgb/frontaliere-articles#33,
 * uno snapshot di sessione morta aperto come draft «⛔️ NON MERGIARE» per
 * rimandare una decisione.
 *
 * `nowMs` è iniettato e non letto da `Date.now()`: una soglia temporale testata
 * contro l'orologio reale è un test che cambia risposta a seconda di quando gira.
 */
import { describe, it, expect } from 'vitest';
import { selectParkedPrs, DEFAULT_PARKED_HOURS } from '../scripts/ci/parked-pr-detector.mjs';

const NOW = Date.parse('2026-08-08T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();
const nums = (prs: { number: number }[]) => prs.map((p) => p.number);

describe('selectParkedPrs', () => {
  it('una draft ferma oltre la soglia è parcheggiata', () => {
    const prs = [{ number: 33, isDraft: true, updatedAt: hoursAgo(72), labels: [] }];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([33]);
  });

  it('una draft recente non lo è (il WIP di ieri sera non va etichettato)', () => {
    const prs = [{ number: 33, isDraft: true, updatedAt: hoursAgo(3), labels: [] }];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([]);
  });

  it('una PR non-draft non lo è mai, per quanto vecchia', () => {
    // Coperta da stale-pr-rescuer → stale-review → recycle-stale-prs. Segnalarla
    // anche qui produrrebbe due segnali per lo stesso stallo.
    const prs = [{ number: 10, isDraft: false, updatedAt: hoursAgo(1000), labels: [] }];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([]);
  });

  it('idempotenza: chi ha già needs-human non viene ri-selezionato', () => {
    const prs = [{
      number: 33, isDraft: true, updatedAt: hoursAgo(72),
      labels: [{ name: 'needs-human' }],
    }];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([]);
  });

  it('altre label non immunizzano', () => {
    const prs = [{
      number: 33, isDraft: true, updatedAt: hoursAgo(72),
      labels: [{ name: 'collision-risk' }, { name: 'automation' }],
    }];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([33]);
  });

  it('updatedAt assente o illeggibile → NON parcheggiata (in dubbio si tace)', () => {
    // Il costo di un falso positivo è una label sbagliata su una PR viva.
    const prs = [
      { number: 1, isDraft: true, labels: [] },
      { number: 2, isDraft: true, updatedAt: 'boh', labels: [] },
      { number: 3, isDraft: true, updatedAt: null, labels: [] },
    ];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([]);
  });

  it('entry malformate non fanno esplodere lo scan', () => {
    const prs = [
      null,
      { isDraft: true, updatedAt: hoursAgo(72), labels: [] },
      { number: 'x', isDraft: true, updatedAt: hoursAgo(72), labels: [] },
      { number: 9, isDraft: true, updatedAt: hoursAgo(72) },
    ] as unknown as { number: number }[];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([9]);
  });

  it('input non-array o vuoto → []', () => {
    expect(selectParkedPrs(undefined as unknown as [], NOW)).toEqual([]);
    expect(selectParkedPrs([], NOW)).toEqual([]);
  });

  it('la soglia è configurabile e il default è 48h', () => {
    // 48 e non 24: sotto le 24 una draft aperta ieri sera è ancora WIP.
    expect(DEFAULT_PARKED_HOURS).toBe(48);
    const pr = { number: 33, isDraft: true, updatedAt: hoursAgo(30), labels: [] };
    expect(nums(selectParkedPrs([pr], NOW))).toEqual([]); // 30h < 48h di default
    expect(nums(selectParkedPrs([pr], NOW, 24))).toEqual([33]); // con soglia 24h rientra
  });

  it('il confine della soglia non è inclusivo: esattamente 48h non è ancora parcheggiata', () => {
    const pr = { number: 33, isDraft: true, updatedAt: hoursAgo(48), labels: [] };
    expect(nums(selectParkedPrs([pr], NOW))).toEqual([]);
    const older = { number: 34, isDraft: true, updatedAt: hoursAgo(48.1), labels: [] };
    expect(nums(selectParkedPrs([older], NOW))).toEqual([34]);
  });

  it('sceglie solo le parcheggiate da un elenco misto', () => {
    const prs = [
      { number: 30, isDraft: false, updatedAt: hoursAgo(500), labels: [] },                    // non-draft
      { number: 31, isDraft: true, updatedAt: hoursAgo(2), labels: [] },                       // recente
      { number: 32, isDraft: true, updatedAt: hoursAgo(96), labels: [{ name: 'needs-human' }] }, // già etichettata
      { number: 33, isDraft: true, updatedAt: hoursAgo(96), labels: [] },                      // ← questa
    ];
    expect(nums(selectParkedPrs(prs, NOW))).toEqual([33]);
  });
});
