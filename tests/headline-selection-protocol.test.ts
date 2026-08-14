// tests/headline-selection-protocol.test.ts — le due liste del prompt di
// selezione non possono tornare a condividere la sintassi, e il parsing non
// può tornare a indovinare.
//
// Meta' SITO di una fix gia' mergiata sul corpus (frontaliere-articles#288,
// issue corpus #188). `scripts/create-article.mjs` di QUESTO repo e' un
// gemello vivo di `generator/scripts/create-article.mjs` del corpus —
// `publish-journalist-article` lo importa e gira ogni 15 minuti — quindi il
// difetto e la fix vanno duplicati qui, non solo la' (nessun mirror copre
// `generator/`).
//
// Due strati, perché un test su una funzione sola non avrebbe visto il
// difetto originale: due liste con semantiche opposte marcate con lo stesso
// `[n]` — le candidate per POSIZIONE, gli articoli già pubblicati per ID — e
// il parsing a valle che risolveva il riferimento ambiguo con un clamp a 0
// invece di rigettarlo.
//
//  · Strato 1 — comportamento: le funzioni pure di
//    `headline-selection-protocol.mjs`, importate davvero (la replica è come
//    si diverge in silenzio).
//  · Strato 2 — cablaggio: che `create-article.mjs` USI quelle funzioni, e che
//    il prompt VERO (estratto dal sorgente e valutato) chieda `selectedId` e
//    non più `selectedIndex`.
//
// `create-article.mjs` non è importabile qui: chiama `main()` al caricamento
// (rete + I/O), quindi le dichiarazioni vengono ESTRATTE dal sorgente con
// `readFileSync` + regex, mai importate — lo stesso pattern di
// tests/create-article-gates.test.ts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CANDIDATE_KEY_PREFIX,
  SELECTION_REJECTION,
  candidateKey,
  formatCandidateList,
  formatPublishedDigest,
  parseHeadlineSelection,
  referenceSyntaxOverlap,
  selectionCorrectionNote,
} from '../scripts/lib/headline-selection-protocol.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');

/** Ritaglia una dichiarazione top-level fino alla sua chiusura in colonna 0. */
function cutDecl(startAnchor: string, from: string = src): string {
  const a = from.indexOf(startAnchor);
  if (a === -1) throw new Error(`dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = from.slice(a).indexOf('\n}\n');
  if (rel === -1) throw new Error(`chiusura non trovata per: ${startAnchor}`);
  return from.slice(a, a + rel + 3);
}

/**
 * Solo il CODICE, senza le righe di commento.
 *
 * Serve alle asserzioni negative («questa forma vecchia non c'è più»): i
 * commenti di `create-article.mjs` possono citare la forma vecchia per
 * spiegare perché è stata tolta, e un guard che grep-passa sui commenti si
 * accenderebbe sulla propria documentazione. Il pavimento sotto impedisce
 * l'errore opposto — se lo strip mangiasse il file, le asserzioni negative
 * passerebbero a vuoto.
 */
function codeOnly(text: string): string {
  const out = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  expect(out.length, 'strip dei commenti troppo aggressivo: le asserzioni negative passerebbero a vuoto').toBeGreaterThan(text.length * 0.4);
  return out;
}

const selectArticleSrc = cutDecl('async function selectArticle(headlines) {');
expect(selectArticleSrc.length, 'estrazione di selectArticle sospettosamente corta').toBeGreaterThan(1000);
const selectArticleCode = codeOnly(selectArticleSrc);

/** Il prompt VERO, valutato con le sole dipendenze iniettate. */
const makePrompt = new Function(
  '__d',
  `const { IS_FRONTALIERE, JSON_QUOTE_SAFETY_RULE_IT } = __d;\n`
  + `${cutDecl('function HEADLINE_SELECTION_PROMPT(headlineList, recentArticles) {')}\n`
  + 'return HEADLINE_SELECTION_PROMPT;',
) as (deps: Record<string, unknown>) => (headlineList: string, recentArticles: string) => string;

const CANDIDATES = [
  { source: 'laregione.ch', headline: 'Errare humanum est' },
  { source: 'rsi.ch', headline: 'Ristorni, Berna deplora lo stop del Cantone', _frontalieriBoosted: true },
];
const PUBLISHED = [
  {
    title: 'Trasferirsi a Maccagno con Pino e Veddasca da frontaliere: pro e contro',
    excerpt: 'Guida pratica al trasferimento sul lago Maggiore per chi lavora in Ticino.',
  },
  { title: 'Cambio CHF EUR: come ottimizzare la conversione', excerpt: '' },
];

describe('headline-selection-protocol — strato 1: le due liste hanno sintassi DISGIUNTE', () => {
  it('le candidate usano una chiave nominata H<n>, 1-based, senza parentesi quadre', () => {
    const list = formatCandidateList(CANDIDATES);
    expect(list).toMatch(/^H1 » \(laregione\.ch\) Errare humanum est$/m);
    expect(list).toMatch(/^H2 » \(rsi\.ch ⭐FRONTALIERI\) Ristorni/m);
    expect(candidateKey(0)).toBe('H1');
    expect(/\[[^\]\n]*\]/.test(list), `la lista candidate è tornata alle parentesi quadre:\n${list}`).toBe(false);
  });

  it('il digest del corpus non porta più né id né parentesi quadre', () => {
    const digest = formatPublishedDigest(PUBLISHED);
    expect(digest).toMatch(/^• Trasferirsi a Maccagno con Pino e Veddasca da frontaliere: pro e contro — Guida pratica/m);
    expect(digest).toMatch(/^• Cambio CHF EUR: come ottimizzare la conversione$/m);
    expect(
      /\[[^\]\n]*\]/.test(digest),
      `il digest del corpus è tornato a marcare gli id fra quadre — è metà del difetto di #188:\n${digest}`,
    ).toBe(false);
    expect(
      new RegExp(`(^|\\s)${CANDIDATE_KEY_PREFIX}\\d+(\\s|$)`, 'm').test(digest),
      'il digest del corpus usa la chiave delle candidate',
    ).toBe(false);
  });

  it('referenceSyntaxOverlap: nessun marcatore in comune fra le due liste', () => {
    const overlap = referenceSyntaxOverlap(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
    expect(overlap.problems).toEqual([]);
    expect(overlap.ok).toBe(true);
  });

  it('referenceSyntaxOverlap RILEVA il formato storico (la regressione che deve tornare rossa)', () => {
    const oldCandidates = CANDIDATES.map((h, i) => `[${i}] (${h.source}) ${h.headline}`).join('\n');
    const oldDigest = PUBLISHED.map((p, i) => `• [articolo-id-${i}] ${p.title}`).join('\n');
    const overlap = referenceSyntaxOverlap(oldCandidates, oldDigest);
    expect(overlap.ok).toBe(false);
    expect(overlap.problems.length, `atteso overlap su entrambe le liste, visto: ${JSON.stringify(overlap.problems)}`).toBeGreaterThanOrEqual(2);
  });
});

describe('headline-selection-protocol — strato 1: il parsing RIFIUTA invece di indovinare', () => {
  it('accetta una chiave valida e la risolve a una posizione 0-based', () => {
    const r = parseHeadlineSelection('{"selectedId": "H2", "reason": "rilevante"}', 2);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.index).toBe(1);
    expect(r.key).toBe('H2');
    expect(r.reason).toBe('rilevante');
  });

  it('tollera code fence e spazi nella chiave', () => {
    for (const raw of [
      '```json\n{"selectedId":"H1","reason":"x"}\n```',
      '{"selectedId":" H 1 ","reason":"x"}',
    ]) {
      const r = parseHeadlineSelection(raw, 2);
      expect(r.ok, `atteso ok per ${raw}`).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.index).toBe(0);
    }
  });

  it('RIGETTA una chiave minuscola — il prompt di correzione mostra solo maiuscolo (#5849 item 4)', () => {
    const r = parseHeadlineSelection('{"selectedId":"h1","reason":"x"}', 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.rejection).toBe(SELECTION_REJECTION.UNKNOWN_KEY);
  });

  it('un NUMERO NUDO è ambiguo e viene rigettato — è il difetto di #188', () => {
    // Il caso misurato sul corpus: pool di 2 headline, risposta `3`. Con la
    // lista del corpus marcata `[id]` quel numero poteva nominare l'una o
    // l'altra lista.
    for (const raw of [
      '{"selectedIndex": 3, "reason": "…"}',
      '{"selectedIndex": 0, "reason": "…"}',
      '{"selectedId": 1, "reason": "…"}',
      '{"selectedId": "1", "reason": "…"}',
    ]) {
      const r = parseHeadlineSelection(raw, 2);
      expect(r.ok, `un riferimento numerico nudo non deve essere accettato: ${raw}`).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.rejection, `su ${raw}`).toBe(SELECTION_REJECTION.AMBIGUOUS_REFERENCE);
    }
  });

  it('una chiave fuori range viene RIGETTATA, non clampata a 0', () => {
    const r = parseHeadlineSelection('{"selectedId": "H3", "reason": "…"}', 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.rejection).toBe(SELECTION_REJECTION.OUT_OF_RANGE);
    expect((r as any).index, 'il rigetto non deve portare una posizione: sarebbe il clamp con un altro nome').toBeUndefined();
    const zero = parseHeadlineSelection('{"selectedId": "H0", "reason": "…"}', 2);
    expect(zero.ok).toBe(false);
    if (zero.ok) throw new Error('unreachable');
    expect(zero.rejection).toBe(SELECTION_REJECTION.OUT_OF_RANGE);
  });

  it('lo slug di un articolo del corpus non è una chiave selezionabile', () => {
    const r = parseHeadlineSelection(
      '{"selectedId": "trasferirsi-a-maccagno-con-pino-e-veddasca-da-frontaliere-pro-e-contro", "reason": "…"}',
      2,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.rejection).toBe(SELECTION_REJECTION.UNKNOWN_KEY);
  });

  it('risposta senza riferimento, vuota o non parsabile: rigetto, mai posizione 0', () => {
    const noRef = parseHeadlineSelection('{"reason": "…"}', 2);
    expect(!noRef.ok && noRef.rejection).toBe(SELECTION_REJECTION.MISSING_REFERENCE);
    const empty = parseHeadlineSelection('', 2);
    expect(!empty.ok && empty.rejection).toBe(SELECTION_REJECTION.UNPARSEABLE);
    const prose = parseHeadlineSelection('mi dispiace, non posso scegliere', 2);
    expect(!prose.ok && prose.rejection).toBe(SELECTION_REJECTION.UNPARSEABLE);
    const zeroCount = parseHeadlineSelection('{"selectedId": "H1"}', 0);
    expect(!zeroCount.ok && zeroCount.rejection).toBe(SELECTION_REJECTION.OUT_OF_RANGE);
  });

  it('JSON troncato: si recupera solo la CHIAVE NOMINATA, mai un indice nudo', () => {
    const ok = parseHeadlineSelection('{"selectedId": "H2", "reason": "motivo tronc', 3);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.index).toBe(1);
    // Il vecchio recupero leggeva `"selectedIndex": (\d+)` da una risposta
    // troncata e lo trattava come scelta valida: era la porta secondaria da
    // cui rientrava lo stesso difetto.
    const bad = parseHeadlineSelection('{"selectedIndex": 2, "reason": "motivo tronc', 3);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.rejection).toBe(SELECTION_REJECTION.AMBIGUOUS_REFERENCE);
  });

  it('il promemoria di correzione nomina la forma attesa e l’intervallo', () => {
    const note = selectionCorrectionNote(SELECTION_REJECTION.AMBIGUOUS_REFERENCE, 7);
    expect(note).toMatch(/NUMERO NUDO/);
    expect(note).toMatch(/"H<n>"/);
    expect(note).toMatch(/fra 1 e 7/);
  });
});

describe('headline-selection-protocol — strato 2: il cablaggio in create-article.mjs', () => {
  it('il prompt VERO chiede selectedId e non nomina più selectedIndex', () => {
    const HEADLINE_SELECTION_PROMPT = makePrompt({ IS_FRONTALIERE: true, JSON_QUOTE_SAFETY_RULE_IT });
    const HEADLINE_SELECTION_PROMPT_CH = makePrompt({ IS_FRONTALIERE: false, JSON_QUOTE_SAFETY_RULE_IT });
    for (const [label, build] of [['frontaliere', HEADLINE_SELECTION_PROMPT], ['svizzera', HEADLINE_SELECTION_PROMPT_CH]] as const) {
      const prompt = build(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
      expect(prompt, `ramo ${label}: il prompt non chiede selectedId`).toMatch(/"selectedId"/);
      expect(/selectedIndex/.test(prompt), `ramo ${label}: il prompt chiede ancora un indice nudo`).toBe(false);
      expect(prompt, `ramo ${label}: il prompt non spiega che la chiave è l'unica cosa selezionabile`).toMatch(/CHIAVE/);
    }
  });

  it('nel prompt VERO le due liste restano distinguibili riga per riga', () => {
    const build = makePrompt({ IS_FRONTALIERE: true, JSON_QUOTE_SAFETY_RULE_IT });
    const prompt = build(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
    const listed = prompt.split('\n').filter((l) => /^(H\d+ »|• )/.test(l));
    expect(listed.length, 'righe di lista mancanti o rese in altro modo').toBe(CANDIDATES.length + PUBLISHED.length);
    for (const line of listed) {
      const isCandidate = line.startsWith('H');
      const isPublished = line.startsWith('•');
      expect(isCandidate !== isPublished, `riga classificabile in due modi: ${line}`).toBe(true);
      if (isPublished) {
        expect(/\[[^\]\n]*\]/.test(line), `riga del corpus con un riferimento fra quadre: ${line}`).toBe(false);
      }
    }
  });

  it('selectArticle costruisce ENTRAMBE le liste con il protocollo condiviso', () => {
    expect(selectArticleCode, 'la lista candidate non passa più dal protocollo').toMatch(/formatCandidateList\(/);
    expect(selectArticleCode, 'il digest del corpus non passa più dal protocollo').toMatch(/formatPublishedDigest\(/);
    expect(
      /`\[\$\{i\}\]/.test(selectArticleCode),
      'selectArticle è tornato a indicizzare le candidate fra parentesi quadre',
    ).toBe(false);
    expect(
      /\[\$\{m\[1\]\}\]/.test(selectArticleCode),
      'il digest del corpus è tornato a stampare l’id fra parentesi quadre',
    ).toBe(false);
  });

  it('selectArticle non ha più nessun ripiego che sceglie in silenzio', () => {
    expect(/selectedIndex/.test(selectArticleCode), 'selectArticle legge ancora un indice nudo').toBe(false);
    expect(/clamp a 0/.test(selectArticleCode), 'il clamp è tornato').toBe(false);
    expect(/idx = 0;/.test(selectArticleCode), 'ripiego alla posizione 0 rimesso in selectArticle').toBe(false);
    expect(/fallback a indice 0/.test(selectArticleCode), 'ripiego alla posizione 0 rimesso in selectArticle').toBe(false);
    expect(selectArticleCode, 'selectArticle non usa più il parser del protocollo').toMatch(/parseHeadlineSelection|requestHeadlineSelection/);
    expect(selectArticleCode, 'la selezione finale non fallisce più: sta di nuovo indovinando').toMatch(/SELEZIONE RIGETTATA/);
  });

  it('il retry della selezione esiste, è limitato e passa dal parser', () => {
    const retrySrc = cutDecl('async function requestHeadlineSelection(');
    expect(retrySrc).toMatch(/parseHeadlineSelection\(rawText, candidateCount\)/);
    expect(retrySrc).toMatch(/selectionCorrectionNote\(/);
    expect(retrySrc).toMatch(/attempt <= maxAttempts/);
    for (const name of ['HEADLINE_SELECTION_MAX_ATTEMPTS_BATCH', 'HEADLINE_SELECTION_MAX_ATTEMPTS_FINAL']) {
      const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
      expect(m, `costante \`${name}\` assente: il tetto ai tentativi è tornato un letterale sparso`).toBeTruthy();
      const n = Number(m![1]);
      expect(n >= 2 && n <= 4, `${name}=${n} fuori dall'intervallo sensato (2-4): il retry costa quota LLM`).toBe(true);
    }
  });
});
