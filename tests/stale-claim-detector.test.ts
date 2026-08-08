/**
 * stale-claim-detector: quali lock `agent:in-progress` sono appesi, e — la metà
 * che conta di più — quali NON vanno toccati.
 *
 * `agent:in-progress` non è uno stato, è un **lock di mutua esclusione**:
 * `claim-issue-in-flight.mjs` lo mette come primo pre-flight di `issue-fix.yml`
 * e il fixer salta tutto se lo trova. Il rilascio simmetrico vive dentro il run,
 * quindi un run morto in modo non grazioso — o una sessione interattiva finita
 * male — lo lascia appeso, e su una issue APERTA quel lock la esclude dal fixer
 * per sempre e in silenzio. Osservato sulla #4248 (`priority:high`).
 *
 * L'errore opposto è però peggiore, ed è il motivo per cui non basta l'età:
 * finché una PR è in volo il claim è CORRETTO, e rilasciarlo fa partire un
 * secondo fixer in parallelo — cioè ricrea la collisione #4788/#4793 che il lock
 * esiste per impedire, causandola noi. L'estrazione dei riferimenti è quindi
 * generosa di proposito: ogni match in più è un claim che NON rilasciamo.
 *
 * `nowMs` è iniettato: una soglia temporale testata contro l'orologio reale è un
 * test che cambia risposta a seconda di quando gira.
 */
import { describe, it, expect } from 'vitest';
import {
  selectStaleClaims,
  referencedIssueNumbers,
  DEFAULT_STALE_CLAIM_HOURS,
} from '../scripts/ci/stale-claim-detector.mjs';

const NOW = Date.parse('2026-08-08T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();
const CLAIM = [{ name: 'agent:in-progress' }];
const nums = (xs: { number: number }[]) => xs.map((x) => x.number);

describe('selectStaleClaims', () => {
  it('un claim vecchio senza PR aperta è stale', () => {
    const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(30) }];
    expect(nums(selectStaleClaims(issues, new Set(), NOW))).toEqual([4248]);
  });

  it('un claim vecchio CON una PR aperta NON è stale — è la trappola del punto 6', () => {
    // Toglierlo qui farebbe partire un secondo fixer in parallelo sulla stessa
    // issue: la collisione #4788/#4793, causata dal detector che la previene.
    const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(500) }];
    expect(nums(selectStaleClaims(issues, new Set([4248]), NOW))).toEqual([]);
  });

  it('un claim recente non è stale, per quanto non abbia PR', () => {
    const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(2) }];
    expect(nums(selectStaleClaims(issues, new Set(), NOW))).toEqual([]);
  });

  it('una issue senza il claim non viene mai toccata', () => {
    const issues = [{ number: 10, labels: [{ name: 'agent:fix' }], updatedAt: hoursAgo(900) }];
    expect(nums(selectStaleClaims(issues, new Set(), NOW))).toEqual([]);
  });

  it('updatedAt assente o illeggibile → NON stale (in dubbio si tace)', () => {
    const issues = [
      { number: 1, labels: CLAIM },
      { number: 2, labels: CLAIM, updatedAt: 'boh' },
      { number: 3, labels: CLAIM, updatedAt: null },
    ];
    expect(nums(selectStaleClaims(issues, new Set(), NOW))).toEqual([]);
  });

  it('entry malformate non fanno esplodere lo scan', () => {
    const issues = [
      null,
      { labels: CLAIM, updatedAt: hoursAgo(30) },
      { number: 'x', labels: CLAIM, updatedAt: hoursAgo(30) },
      { number: 9, labels: CLAIM, updatedAt: hoursAgo(30) },
    ] as unknown as { number: number }[];
    expect(nums(selectStaleClaims(issues, new Set(), NOW))).toEqual([9]);
  });

  it('input non-array o vuoto → []', () => {
    expect(selectStaleClaims(undefined as unknown as [], new Set(), NOW)).toEqual([]);
    expect(selectStaleClaims([], new Set(), NOW)).toEqual([]);
  });

  it('la soglia è configurabile e il default è 12h (2× il timeout di issue-fix)', () => {
    expect(DEFAULT_STALE_CLAIM_HOURS).toBe(12);
    const iss = { number: 7, labels: CLAIM, updatedAt: hoursAgo(8) };
    expect(nums(selectStaleClaims([iss], new Set(), NOW))).toEqual([]); // 8h < 12h
    expect(nums(selectStaleClaims([iss], new Set(), NOW, 6))).toEqual([7]); // con 6h rientra
  });

  it('il confine della soglia non è inclusivo: esattamente 12h non è ancora stale', () => {
    const iss = { number: 7, labels: CLAIM, updatedAt: hoursAgo(12) };
    expect(nums(selectStaleClaims([iss], new Set(), NOW))).toEqual([]);
    const older = { number: 8, labels: CLAIM, updatedAt: hoursAgo(12.1) };
    expect(nums(selectStaleClaims([older], new Set(), NOW))).toEqual([8]);
  });

  it('referenced accetta anche un array, non solo un Set', () => {
    const issues = [{ number: 42, labels: CLAIM, updatedAt: hoursAgo(99) }];
    expect(nums(selectStaleClaims(issues, [42], NOW))).toEqual([]);
  });

  it('sceglie solo gli stale da un elenco misto', () => {
    const issues = [
      { number: 1, labels: CLAIM, updatedAt: hoursAgo(99) },                    // ← stale
      { number: 2, labels: CLAIM, updatedAt: hoursAgo(99) },                    // PR aperta
      { number: 3, labels: CLAIM, updatedAt: hoursAgo(1) },                     // recente
      { number: 4, labels: [{ name: 'agent:fix' }], updatedAt: hoursAgo(99) },  // niente claim
    ];
    expect(nums(selectStaleClaims(issues, new Set([2]), NOW))).toEqual([1]);
  });
});

describe('referencedIssueNumbers — i tre canali con cui una PR dice "sto su #N"', () => {
  it('il branch deterministico fix/issue-N è riconosciuto', () => {
    expect([...referencedIssueNumbers([{ headRefName: 'fix/issue-4248' }])]).toEqual([4248]);
  });

  it('(#N) nel titolo è riconosciuto', () => {
    expect([...referencedIssueNumbers([{ title: 'Qualcosa di utile (#1234)' }])]).toEqual([1234]);
  });

  it('Closes/Fixes/Resolves #N nel body sono riconosciuti, in ogni forma e caso', () => {
    const prs = [{ body: 'Closes #1\nfixes #2\nRESOLVED: #3\nFixed #4' }];
    expect([...referencedIssueNumbers(prs)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('un branch che somiglia ma non combacia NON conta', () => {
    // `fix/issue-4248-bis` non è il nome deterministico di issue-fix. Non
    // riconoscerlo è il verso sbagliato dell'errore, quindi vale la pena
    // saperlo: titolo o body lo recuperano se la PR è davvero legata alla issue.
    expect([...referencedIssueNumbers([{ headRefName: 'fix/issue-4248-bis' }])]).toEqual([]);
  });

  it('una PR che non nomina nessuna issue non ne protegge nessuna', () => {
    const prs = [{ headRefName: 'chore/pulizia', title: 'Pulizia', body: 'Vedi #99 per contesto' }];
    // `#99` senza keyword di chiusura è un cross-ref, non un "sto lavorando qui".
    expect([...referencedIssueNumbers(prs)]).toEqual([]);
  });

  it('più canali sulla stessa PR convergono senza duplicare', () => {
    const prs = [{ headRefName: 'fix/issue-5', title: 'Roba (#5)', body: 'Closes #5' }];
    expect([...referencedIssueNumbers(prs)]).toEqual([5]);
  });

  it('input non-array o entry nulle → Set vuoto, niente eccezioni', () => {
    expect(referencedIssueNumbers(undefined as unknown as []).size).toBe(0);
    expect(referencedIssueNumbers([null, undefined] as unknown as []).size).toBe(0);
  });
});
