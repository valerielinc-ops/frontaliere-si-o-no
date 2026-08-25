/**
 * followup-drainer — `detectWideScopeAggregate` / `countAggregateItems`.
 *
 * Lo stadio di decomposizione esiste dal 2026-08-21, ma ci si arrivava solo
 * REATTIVAMENTE: dopo che il fixer aveva bruciato il turn-budget senza produrre
 * una PR. Su una follow-up aggregata la larghezza è però DICHIARATA
 * all'apertura — «N items deferred» nel titolo, N sezioni nel body — quindi la
 * diagnosi post-mortem si pagava a run pieni per un dato già scritto.
 *
 * SOGLIA 4, misurata: sul tasso di `fu-parked` per numero di item (481
 * follow-up del sito che portano il conteggio nel titolo) il salto è fra N≤2
 * (36%) e N≥3 (46%); da 3 in su i tassi sono indistinguibili (47/44/50% su
 * campioni 89/18/12). A decidere fra 3 e 4 è il volume che lo stadio assorbe —
 * promuove UNA issue per tick: N≥4 = 34/481 = 7% della popolazione, N≥3 =
 * 123/481 = 26%. 4 è anche il primo valore sopra le due soglie già in uso per
 * la stessa famiglia (N≥2 = circuit-breaker one-item di `issue-fix.yml`,
 * `BACKLOG_MIN_ITEMS`=3 per gli handoff di sessione).
 *
 * Fixture verbatim da sito#6421 (aperta il 2026-08-25).
 */
import { describe, it, expect } from 'vitest';
import {
  detectWideScopeAggregate,
  countAggregateItems,
  WIDE_SCOPE_MIN_ITEMS,
  AGGREGATE_ITEMS_RE,
  detectMalformedBody,
} from '../scripts/ci/followup-drainer.mjs';

/** Verbatim: titolo di sito#6421. */
const T_6421 = 'follow-up(#6330): 4 item deferred — interviste reali, confronto SERP top-10, collisione commonPathPrefix, troncamento a 400 segmenti';
/** Verbatim: gli heading di sito#6421 (forma `### N.` del template FOLLOWUP.md). */
const B_6421 = [
  '## Origine',
  'PR #6330.',
  '',
  '### 1. Interviste a frontalieri, testimonianze, commenti di commercialisti/avvocati',
  'Testo.',
  '### 2. Confronto con i top 10 della SERP richiesto dalla issue originale (#5002)',
  'Testo.',
  '### 3. Rischio di collisione tra famiglie distinte nel fallback `commonPathPrefix`',
  'Testo.',
  '### 4. Troncamento a `MAX_SEGMENTS_PER_PAGE=400` per ordine di documento',
  'Testo.',
].join('\n');

describe('countAggregateItems — le forme che il filer produce davvero', () => {
  it('conta le sezioni `### N.` del template FOLLOWUP.md', () => {
    expect(countAggregateItems(B_6421)).toBe(4);
  });

  it('conta anche `### Item N —`, `## N.` e le task-list', () => {
    expect(countAggregateItems('### Item 1 — a\n### Item 2 — b')).toBe(2);
    expect(countAggregateItems('## 1. a\n## 2. b\n## 3. c')).toBe(3);
    expect(countAggregateItems('- [ ] a\n- [x] b')).toBe(2);
  });

  it('non conta gli heading senza numero (`## Origine`, `## Item`)', () => {
    expect(countAggregateItems('## Origine\n## Item\n## Note')).toBe(0);
  });

  it('non conta un heading-data: `### 2026-08-25 …` non è una voce di lavoro', () => {
    expect(countAggregateItems('### 2026-08-25 sessione\n### 2026-08-24 sessione')).toBe(0);
  });

  it('body vuoto/assente → 0', () => {
    expect(countAggregateItems('')).toBe(0);
    expect(countAggregateItems(undefined as unknown as string)).toBe(0);
  });
});

describe('detectWideScopeAggregate — instrada allo scorporo ciò che nasce già largo', () => {
  it('la soglia di default è 4', () => {
    expect(WIDE_SCOPE_MIN_ITEMS).toBe(4);
  });

  it('sito#6421 (titolo 4 ∧ body 4) → wide-scope', () => {
    const w = detectWideScopeAggregate(T_6421, B_6421);
    expect(w).not.toBeNull();
    expect(w).toEqual({ items: 4, titleItems: 4, bodyItems: 4 });
  });

  it('3 item restano sotto soglia: li lavora il circuit-breaker one-item di issue-fix', () => {
    expect(detectWideScopeAggregate(
      'follow-up(#1): 3 items deferred — a, b, c',
      '### 1. a\n### 2. b\n### 3. c',
    )).toBeNull();
  });
});

describe('detectWideScopeAggregate — congiunzione titolo ∧ body, vale il MINIMO', () => {
  it('titolo gonfiato (6) su body con 2 sezioni → nessuno scorporo', () => {
    expect(detectWideScopeAggregate(
      'follow-up(#1): 6 items deferred — …',
      '### 1. a\n### 2. b',
    )).toBeNull();
  });

  it('body gonfiato da una checklist di test-plan su titolo da 1 item → nessuno scorporo', () => {
    expect(detectWideScopeAggregate(
      'follow-up(#1): 1 item deferred — …',
      '### 1. a\n- [ ] t1\n- [ ] t2\n- [ ] t3\n- [ ] t4',
    )).toBeNull();
  });

  it('senza «N items deferred» nel titolo non è un\'aggregata → mai wide-scope', () => {
    expect(detectWideScopeAggregate(
      'Backlog: il residuo della sessione',
      '### 1. a\n### 2. b\n### 3. c\n### 4. d\n### 5. e',
    )).toBeNull();
  });

  it('la soglia è iniettabile (kill-switch/taratura senza toccare il codice)', () => {
    expect(detectWideScopeAggregate(T_6421, B_6421, { min: 5 })).toBeNull();
    expect(detectWideScopeAggregate(T_6421, B_6421, { min: 3 })).not.toBeNull();
  });
});

describe('AGGREGATE_ITEMS_RE — una sola definizione, due letture', () => {
  it('è la stessa forma che issue-fix.yml legge per il circuit-breaker one-item', () => {
    expect(AGGREGATE_ITEMS_RE.exec('follow-up(#1): 1 item deferred — x')?.[1]).toBe('1');
    expect(AGGREGATE_ITEMS_RE.exec('follow-up(#1): 12 items deferred — x')?.[1]).toBe('12');
    expect(AGGREGATE_ITEMS_RE.exec('follow-up(#1): niente da rimandare')).toBeNull();
  });

  it('nessun flag `g`: `detectMalformedBody` la usa con `.test()` e non deve avere stato', () => {
    expect(AGGREGATE_ITEMS_RE.flags).not.toContain('g');
    const title = 'follow-up(#1): 2 items deferred — x';
    const body = 'a'.repeat(60); // >50 char ma senza struttura FOLLOWUP.md
    expect(detectMalformedBody(title, body)).toBe(true);
    expect(detectMalformedBody(title, body)).toBe(true); // idempotente call-to-call
  });
});
