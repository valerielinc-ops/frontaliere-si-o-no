import { describe, it, expect, vi } from 'vitest';
import {
  extractNonImplementedItems,
  isCandidateItem,
} from '../scripts/ci/followup-has-candidates.mjs';
import {
  bulletState,
  bulletsWithoutState,
  checkPrBodySections,
} from '../scripts/lib/pr-body-sections-check.mjs';

/**
 * Le sei classi di stato, e QUALI riaprono un follow-up.
 *
 * ## Il difetto, misurato
 *
 * `hasMeaningfulContent()` verificava solo che un bullet non fosse il
 * placeholder vuoto `- `; ne' quel modulo ne' il gate CI
 * (`.github/workflows/pr-body-contract.yml`) guardavano se il bullet dichiara
 * uno stato letterale. Misurato su 13 coppie issue←PR: 7 PR non dichiaravano lo
 * stato su nessun bullet, e in 0 casi lo stato c'era nella PR e si perdeva a
 * valle — quindi il buco e' nel gate, non nel raccoglitore.
 *
 * A valle, `followup-has-candidates.mjs` raccoglieva OGNI bullet: anche
 * «— in questa PR» (gia' nel diff) e «— per scelta» (un no motivato) tornavano
 * come issue di follow-up. E' il meccanismo che rialimenta il backlog con
 * lavoro gia' chiuso.
 *
 * ## Cosa fissa questo test
 *
 * L'INSIEME ESATTO, non il conteggio: dato un body con un bullet per ciascuna
 * delle sei classi piu' uno senza stato, quali sopravvivono al filtro. Un test
 * sul solo numero resterebbe verde se il filtro scartasse la classe sbagliata.
 *
 * ## Il bullet SENZA stato resta candidato, ed e' la parte fail-safe
 *
 * Oggi 604 bullet su 830 (73%, ultime 60 PR mergiate) non dichiarano stato:
 * filtrarli aprirebbe una finestra cieca sulla classe piu' numerosa. Restano attivi finche' l'advisory
 * `bullet-without-state` non li fa sparire alla fonte. Se questa asserzione
 * diventa rossa perche' qualcuno ha «migliorato» il filtro, la finestra cieca
 * e' tornata.
 *
 * ## Mutazioni (2026-08-14)
 *  - filtro rimosso (`CLOSING_STATES` svuotato): ROSSO;
 *  - 10 righe di commento innocue nei due moduli: VERDE.
 */

const BODY = `## Implementato

- Roba fatta.

## Non implementato (ancora)

- Rinomina del modulo — in questa PR
- Estrazione del parser condiviso — PR concatenata #4242
- Nessun retry sul path offline — per scelta
- Il gate non copre \`data/\` — by construction
- Promozione a gate duro — blocked: decisione del proprietario
- Copia sul corpus — blocked: nessun trasporto automatico sotto scripts/**
- Ripulire il naming dei campi legacy
`;

// Il testo del bullet basta a identificarlo, e resta leggibile nel diff.
const IN_THIS_PR = 'Rinomina del modulo — in questa PR';
const CHAINED = 'Estrazione del parser condiviso — PR concatenata #4242';
const BY_CHOICE = 'Nessun retry sul path offline — per scelta';
const BY_CONSTRUCTION = 'Il gate non copre `data/` — by construction';
const BLOCKED_OWNER = 'Promozione a gate duro — blocked: decisione del proprietario';
const BLOCKED_TECH = 'Copia sul corpus — blocked: nessun trasporto automatico sotto scripts/**';
const NO_STATE = 'Ripulire il naming dei campi legacy';

describe('stato letterale dei bullet: classificazione', () => {
  it('ogni classe e\' riconosciuta, e nessuna collide con un\'altra', () => {
    expect(bulletState(IN_THIS_PR)).toBe('in-this-pr');
    expect(bulletState(CHAINED)).toBe('chained-pr');
    expect(bulletState(BY_CHOICE)).toBe('by-choice');
    expect(bulletState(BY_CONSTRUCTION)).toBe('by-construction');
    // La trappola: `blocked: decisione del proprietario` matcha ANCHE la regex
    // generica `blocked:`. L'ordine di prova e' l'invariante.
    expect(bulletState(BLOCKED_OWNER)).toBe('blocked-owner');
    expect(bulletState(BLOCKED_TECH)).toBe('blocked-technical');
    expect(bulletState(NO_STATE)).toBe(null);
  });

  it('`PR concatenata` senza numero non conta come stato', () => {
    // Senza #N non e' tracciabile: sarebbe una scappatoia travestita da stato.
    expect(bulletState('Roba — PR concatenata (in arrivo)')).toBe(null);
    expect(bulletState('Roba — PR concatenata #12')).toBe('chained-pr');
  });

  it('`blocked:` senza causa non conta come stato', () => {
    expect(bulletState('Roba — blocked:')).toBe(null);
    expect(bulletState('Roba — blocked: quota LLM esaurita')).toBe('blocked-technical');
  });

  it('vince lo stato che compare per PRIMO, non il primo che si prova', () => {
    // Trovato provando la funzione sul body di questa PR: un bullet il cui
    // stato e' `blocked:` conteneva piu' avanti «in questa PR» come prosa, e
    // veniva archiviato come gia' fatto. Lo stato e' una dichiarazione e sta
    // in testa; il resto e' prosa.
    expect(bulletState(
      'Promozione a gate duro — blocked: 604 bullet su 830 non dichiarano stato. '
      + 'Si sblocca dopo che i generatori corretti in questa PR avranno girato.',
    )).toBe('blocked-technical');
    // E simmetricamente: se lo stato dichiarato e' `in questa PR`, una
    // menzione successiva di `blocked:` non lo scavalca.
    expect(bulletState(
      'Rinomina — in questa PR. Il gemello resta blocked: manca il trasporto.',
    )).toBe('in-this-pr');
  });

  it('a parita\' di posizione vince il piu\' specifico (owner > tecnica)', () => {
    expect(bulletState('Roba — blocked: decisione del proprietario, chiuso')).toBe('blocked-owner');
  });
});

describe('quali classi generano un follow-up: insieme esatto', () => {
  const items = extractNonImplementedItems(BODY);

  it('il body di prova espone tutte e sette le righe', () => {
    expect(items).toEqual([
      IN_THIS_PR, CHAINED, BY_CHOICE, BY_CONSTRUCTION, BLOCKED_OWNER, BLOCKED_TECH, NO_STATE,
    ]);
  });

  it('sopravvivono SOLO `blocked: <causa tecnica>` e il bullet senza stato', () => {
    // Insieme esatto, non conteggio: un filtro che scartasse la classe
    // sbagliata lasciando lo stesso numero di superstiti passerebbe un
    // `toHaveLength(2)`.
    expect(items.filter(isCandidateItem)).toEqual([BLOCKED_TECH, NO_STATE]);
  });

  it('e specularmente: le cinque classi che chiudono la voce sono tutte scartate', () => {
    expect(items.filter((i) => !isCandidateItem(i))).toEqual([
      IN_THIS_PR, CHAINED, BY_CHOICE, BY_CONSTRUCTION, BLOCKED_OWNER,
    ]);
  });

  it('il bullet SENZA stato resta candidato (fail-safe, 604 su 830 oggi)', () => {
    // Se questa diventa rossa, la finestra cieca e' tornata: la classe piu'
    // numerosa smetterebbe di generare follow-up senza che nessuno lo veda.
    expect(isCandidateItem(NO_STATE)).toBe(true);
  });

  it('un body dove OGNI bullet chiude la voce non lascia candidati', () => {
    const allClosed = [
      '## Implementato', '- x', '',
      '## Non implementato (ancora)',
      `- ${IN_THIS_PR}`, `- ${BY_CHOICE}`, `- ${BLOCKED_OWNER}`, '',
    ].join('\n');
    expect(extractNonImplementedItems(allClosed).filter(isCandidateItem)).toEqual([]);
  });
});

describe('il gate sullo stato e\' ADVISORY, non bloccante', () => {
  it('segnala il bullet senza stato in `warnings`, e `ok` resta true', () => {
    const res = checkPrBodySections(BODY);
    // Requisito di progetto: il ciclo autonomo mergia le proprie PR e il suo
    // generatore non emette ancora gli stati. Un gate duro qui fermerebbe la
    // coda di merge del sito (precedente: 2026-08-12, 13 ore).
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(res.warnings.map((w: { type: string }) => w.type)).toEqual(['bullet-without-state']);
    expect(res.warnings[0].message).toContain('1 bullet su 7');
  });

  it('nessun warning quando ogni bullet dichiara lo stato', () => {
    const clean = BODY.split('\n').filter((l) => !l.includes(NO_STATE)).join('\n');
    const res = checkPrBodySections(clean);
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('nessun warning su «Nessuno» (task completo)', () => {
    const res = checkPrBodySections('## Implementato\n\n- x\n\n## Non implementato (ancora)\n\nNessuno\n');
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it('bulletsWithoutState elenca esattamente i bullet senza stato', () => {
    const section = BODY.slice(BODY.indexOf('## Non implementato (ancora)'));
    expect(bulletsWithoutState(section)).toEqual([`- ${NO_STATE}`]);
  });
});

describe('l\'advisory ha un osservatore vero: il hook pre-`gh pr create`', () => {
  it('warnAboutStatelessBullets segnala il bullet senza stato', async () => {
    // Senza questa asserzione l'advisory sarebbe una guardia che non guarda:
    // `pr-body-contract.yml` duplica la logica inline e NON importa il modulo,
    // quindi il hook locale e' l'unico punto che lo esegue davvero.
    const { warnAboutStatelessBullets } = await import('../scripts/ci/pr-body-check-gate.mjs');
    const seen: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      seen.push(String(s)); return true;
    }) as never);
    try {
      expect(warnAboutStatelessBullets(BODY)).toEqual([`- ${NO_STATE}`]);
    } finally {
      spy.mockRestore();
    }
    expect(seen.join('')).toContain('NON blocca');
    expect(seen.join('')).toContain(NO_STATE);
  });

  it('tace quando ogni bullet dichiara lo stato', async () => {
    const { warnAboutStatelessBullets } = await import('../scripts/ci/pr-body-check-gate.mjs');
    const clean = BODY.split('\n').filter((l) => !l.includes(NO_STATE)).join('\n');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    try {
      expect(warnAboutStatelessBullets(clean)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
