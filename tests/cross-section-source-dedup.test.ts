// tests/cross-section-source-dedup.test.ts — lo stesso materiale non può
// generare due articoli nelle due sezioni (frontaliere / svizzera).
//
// Meta' SITO di una fix gia' mergiata sul corpus (frontaliere-articles#288,
// issue corpus #251, residuo di #246). `scripts/create-article.mjs` di
// QUESTO repo e' un gemello vivo di `generator/scripts/create-article.mjs`
// del corpus — `publish-journalist-article` lo importa e gira ogni 15 minuti
// — quindi il difetto e la fix vanno duplicati qui.
//
// Il ledger URL→id esisteva già in ENTRAMBI i repo ma era letto per sezione:
// `loadSourceUrls()` apre `SECTION.sourceUrlsFile`, cioè un file per sezione
// (`data/article-source-urls.json` per frontaliere,
// `data/swiss-article-source-urls.json` per svizzera — confermati presenti
// qui con lo stesso nome). Il ramo esatto di `isSourceUrlAlreadyUsed` non
// poteva quindi vedere la sezione gemella.
//
// Due strati:
//  · Comportamento — `findCrossSectionSourceDuplicate` con ledger finti: dice
//    cosa viene bloccato e, soprattutto, cosa NON viene bloccato (il caso
//    legittimo di due tagli sullo stesso tema da due fonti diverse).
//  · Cablaggio — che `isSourceUrlAlreadyUsed` in `create-article.mjs` legga
//    davvero tutti i ledger dichiarati in `ARTICLE_SECTION_CONFIGS`.
//
// Il terzo strato del corpus (ratchet sul registro PUBBLICATO, quanti
// duplicati esistono OGGI nei due ledger reali) non è portato qui: legge
// `data/article-source-urls.json` e `data/swiss-article-source-urls.json` dal
// filesystem, che in un worktree sparso non sono materializzati (1,7 GB), e
// il sito non ha un equivalente del preflight `publish-api.yml` del corpus
// che lo motivava a girare fuori da `tests.yml`.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SIGNAL_CROSS_SECTION,
  SIGNAL_SAME_SECTION,
  findCrossSectionSourceDuplicate,
  listCrossSectionDuplicates,
} from '../scripts/lib/cross-section-dedup.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');

function cutDecl(startAnchor: string, from: string = src): string {
  const a = from.indexOf(startAnchor);
  if (a === -1) throw new Error(`dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = from.slice(a).indexOf('\n}\n');
  if (rel === -1) throw new Error(`chiusura non trovata per: ${startAnchor}`);
  return from.slice(a, a + rel + 3);
}

const AGGREGATE_STATS_URL = 'https://www.tio.ch/svizzera/economia/1943399/frontalieri-italia-svizzera-dati-ust';
const LEDGERS = {
  frontaliere: {
    'https://www.tio.ch/ticino/attualita/1941660/permesso-g-nuove-regole': 'permesso-g-nuove-regole-2026',
  },
  svizzera: {
    [AGGREGATE_STATS_URL]: 'dati-ust-frontalieri-italiani',
  },
};

describe('cross-section-dedup — strato 1: comportamento', () => {
  it('la fonte già usata dalla sezione NAZIONALE blocca la generazione frontaliere', () => {
    const hit = findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, LEDGERS, 'frontaliere');
    expect(hit.used).toBe(true);
    if (!hit.used) throw new Error('unreachable');
    expect(hit.articleId).toBe('dati-ust-frontalieri-italiani');
    expect(hit.section).toBe('svizzera');
    expect(hit.crossSection).toBe(true);
    expect(hit.signal).toBe(SIGNAL_CROSS_SECTION);
  });

  it('e simmetricamente: la fonte già usata da frontaliere blocca la sezione nazionale', () => {
    const url = 'https://www.tio.ch/ticino/attualita/1941660/permesso-g-nuove-regole';
    const hit = findCrossSectionSourceDuplicate(url, LEDGERS, 'svizzera');
    expect(hit.used).toBe(true);
    if (!hit.used) throw new Error('unreachable');
    expect(hit.section).toBe('frontaliere');
    expect(hit.crossSection).toBe(true);
  });

  it('dentro la sezione attiva il segnale storico non cambia significato', () => {
    const hit = findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, LEDGERS, 'svizzera');
    expect(hit.used).toBe(true);
    if (!hit.used) throw new Error('unreachable');
    expect(hit.section).toBe('svizzera');
    expect(hit.crossSection).toBe(false);
    expect(hit.signal).toBe(SIGNAL_SAME_SECTION);
  });

  it('IL CASO LEGITTIMO: stesso tema da due fonti diverse resta ammesso in entrambe le sezioni', () => {
    // Due URL diversi sulla stessa vicenda: sono due pezzi con tagli diversi,
    // non un duplicato di contenuto. Se questo test diventa rosso, la fix ha
    // smesso di distinguere «stesso materiale» da «stesso argomento».
    const altraFonte = 'https://www.rsi.ch/info/1943401/frontalieri-italia-svizzera-il-commento';
    expect(findCrossSectionSourceDuplicate(altraFonte, LEDGERS, 'frontaliere')).toEqual({ used: false });
    expect(findCrossSectionSourceDuplicate(altraFonte, LEDGERS, 'svizzera')).toEqual({ used: false });
  });

  it('un URL mai visto, un ledger vuoto o assente non bloccano niente', () => {
    expect(findCrossSectionSourceDuplicate('https://example.org/x', LEDGERS, 'frontaliere')).toEqual({ used: false });
    expect(findCrossSectionSourceDuplicate('', LEDGERS, 'frontaliere')).toEqual({ used: false });
    expect(
      findCrossSectionSourceDuplicate(AGGREGATE_STATS_URL, { frontaliere: {}, svizzera: null } as any, 'frontaliere'),
    ).toEqual({ used: false });
  });

  it('le chiavi ereditate da Object.prototype non passano per id di articolo', () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(
        findCrossSectionSourceDuplicate(key, { frontaliere: {}, svizzera: {} }, 'frontaliere'),
        `"${key}" letto come voce del ledger`,
      ).toEqual({ used: false });
    }
  });

  it('listCrossSectionDuplicates conta solo gli URL presenti in PIÙ sezioni', () => {
    const dups = listCrossSectionDuplicates({
      frontaliere: { 'https://a.ch/1': 'id-fr', 'https://b.ch/2': 'solo-fr' },
      svizzera: { 'https://a.ch/1': 'id-ch' },
    });
    expect(dups.length).toBe(1);
    expect(dups[0].url).toBe('https://a.ch/1');
    expect(dups[0].sections.map((s: { section: string }) => s.section).sort()).toEqual(['frontaliere', 'svizzera']);
  });
});

describe('cross-section-dedup — strato 2: cablaggio in create-article.mjs', () => {
  it('isSourceUrlAlreadyUsed interroga TUTTI i ledger, non solo quello della sezione attiva', () => {
    const fn = cutDecl('function isSourceUrlAlreadyUsed(headlineUrl) {');
    expect(fn, 'il ramo esatto non passa dal dedup cross-sezione').toMatch(/findCrossSectionSourceDuplicate\(/);
    expect(fn, 'i ledger non vengono letti tutti').toMatch(/loadAllSectionSourceUrls\(\)/);
    expect(
      /\bloadSourceUrls\(\)/.test(fn),
      'isSourceUrlAlreadyUsed è tornato a leggere il ledger della sola sezione attiva: è esattamente il difetto di #251',
    ).toBe(false);
  });

  it('loadAllSectionSourceUrls itera le SEZIONI dichiarate, non due path scritti a mano', () => {
    const fn = cutDecl('function loadAllSectionSourceUrls() {');
    expect(fn, 'i ledger non si derivano dalle sezioni dichiarate: una terza sezione resterebbe fuori in silenzio').toMatch(/ARTICLE_SECTION_CONFIGS/);
    expect(fn).toMatch(/sourceUrlsFile/);
  });

  it('lo scarto cross-sezione è osservabile nel run report', () => {
    expect(src, 'contatore del run report rimosso: il caso torna invisibile').toMatch(/urlUsedOtherSection: 0/);
    expect(src, 'lo scarto cross-sezione non è più distinguibile nei campioni scartati').toMatch(/url_already_used_cross_section/);
  });

  it('i due ledger di sezione dichiarati nel sito hanno lo stesso nome del corpus', () => {
    // data/article-source-urls.json (frontaliere) e
    // data/swiss-article-source-urls.json (svizzera) — verificato che il sito
    // usa gli stessi path del corpus, non nomi diversi.
    expect(src).toMatch(/sourceUrlsFile:\s*'data\/article-source-urls\.json'/);
    expect(src).toMatch(/sourceUrlsFile:\s*'data\/swiss-article-source-urls\.json'/);
  });
});
