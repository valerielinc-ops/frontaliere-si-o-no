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
- Nessun retry sul path offline — per scelta. **Motivo:** il provider offline non è supportato. **Prossimo passo:** rivalutare dopo il prossimo rilascio del provider.
- Il gate non copre \`data/\` — by construction. **Motivo:** il dato è generato fuori dal codice. **Prossimo passo:** verificare il contratto al prossimo cambio di pipeline.
- Promozione a gate duro — blocked: decisione del proprietario. **Motivo:** serve una scelta di prodotto. **Prossimo passo:** rivalutare dopo la decisione del proprietario.
- Copia sul corpus — blocked: nessun trasporto automatico sotto scripts/**
- Ripulire il naming dei campi legacy
`;

// Il testo del bullet basta a identificarlo, e resta leggibile nel diff.
const IN_THIS_PR = 'Rinomina del modulo — in questa PR';
const CHAINED = 'Estrazione del parser condiviso — PR concatenata #4242';
const BY_CHOICE = 'Nessun retry sul path offline — per scelta. **Motivo:** il provider offline non è supportato. **Prossimo passo:** rivalutare dopo il prossimo rilascio del provider.';
const BY_CONSTRUCTION = 'Il gate non copre `data/` — by construction. **Motivo:** il dato è generato fuori dal codice. **Prossimo passo:** verificare il contratto al prossimo cambio di pipeline.';
const BLOCKED_OWNER = 'Promozione a gate duro — blocked: decisione del proprietario. **Motivo:** serve una scelta di prodotto. **Prossimo passo:** rivalutare dopo la decisione del proprietario.';
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

  it('`falso positivo` e\' un sinonimo accettato di `per scelta` (stesso stato by-choice)', () => {
    expect(bulletState('falso positivo — check: motivo')).toBe('by-choice');
  });

  it('una decisione vaga resta candidata finché non porta Motivo e Prossimo passo concreti', () => {
    expect(isCandidateItem('scope non coperto — per scelta')).toBe(true);
    expect(isCandidateItem('scope non coperto — by construction')).toBe(true);
    expect(isCandidateItem('scope non coperto — falso positivo')).toBe(true);
    expect(isCandidateItem('scope non coperto — blocked: decisione del proprietario')).toBe(true);
    expect(isCandidateItem(
      'scope non coperto — falso positivo. **Motivo:** le due regole hanno semantica diversa. '
      + '**Prossimo passo:** chiudere dopo la verifica del fixture condiviso.',
    )).toBe(false);
  });

  it('`non e\' un falso positivo` dichiara l\'opposto: resta lavoro dovuto, non by-choice (#3367)', () => {
    // Stessa frase gia' testata come rifiuto esplicito in
    // tests/sibling-check-gate.test.ts — la naive substring-match leggeva la
    // negazione come un'affermazione. Vedi scripts/ci/lib/false-positive-declaration.mjs.
    expect(bulletState(
      'scripts/foo-parser.mjs — non è un falso positivo, va sistemato in follow-up',
    )).toBe(null);
  });

  it('`not a false positive` dichiara l\'opposto anche in inglese: resta lavoro dovuto', () => {
    // Il sinonimo inglese `false positive` e' stato accettato in `byChoice` da
    // #9137, ma solo la forma NEGATA italiana era pinnata (test sopra, #3367).
    // Senza questo caso nessun test prova che il `NEGATION_LOOKBEHIND` copre
    // anche `not a …`: un bullet che dichiara «questo NON e' un falso positivo,
    // va sistemato» verrebbe classificato `by-choice` e chiuderebbe una voce
    // che invece deve restare lavoro dovuto, sopprimendo il follow-up.
    expect(bulletState(
      'scripts/foo-parser.mjs — not a false positive, it needs a follow-up',
    )).toBe(null);
    // Anche senza l'articolo: il lookbehind ha `(?:a\s+)?` opzionale.
    expect(bulletState('scripts/foo-parser.mjs — not false positive, must be fixed')).toBe(null);
    // Controprova: la forma NON negata resta il sinonimo accettato di by-choice.
    expect(bulletState('scripts/foo-parser.mjs — false positive: shares the token only')).toBe('by-choice');
  });

  it('la negazione contratta inglese e l\'italiano senza accento non chiudono la voce', () => {
    // Misurato su #9134: prima di questo fix quattro negazioni passavano come
    // `by-choice`, chiudendo un bullet il cui autore diceva l'OPPOSTO. Il caso
    // portante sono le contrazioni: `isn't` non contiene la parola `not`,
    // quindi `\bnot\s+` non puo' vederla. L'ultimo caso e' l'italiano ASCII:
    // l'arm richiedeva la `è` accentata, cosi' `non e un falso positivo`
    // — stessa frase, tastiera diversa — veniva letto come dichiarazione.
    for (const bullet of [
      "scripts/foo.mjs — isn't a false positive, must be fixed",
      "scripts/foo.mjs — aren't false positive, must be fixed",
      "scripts/foo.mjs — wasn't a false positive, must be fixed",
      "scripts/foo.mjs — weren't a false positive, must be fixed",
      'scripts/foo.mjs — never a false positive, must be fixed',
      'scripts/foo.mjs — non e un falso positivo, va sistemato',
      'scripts/foo.mjs — non sono un falso positivo, va sistemato',
    ]) {
      expect(bulletState(bullet), bullet).toBe(null);
    }
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
