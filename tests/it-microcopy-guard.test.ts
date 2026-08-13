/**
 * Guardia deterministica su titolo ed excerpt (porting di
 * `nanakokyobashi-rgb/frontaliere-articles#122`).
 *
 * Titolo ed excerpt finiscono in `<title>`, meta description, card dell'hub,
 * RSS e SERP. Non li rilegge nessuno prima della pubblicazione, e il 2026-08-09
 * su `packages/articles/content/` erano vivi cosi':
 *
 *   · «Frontaliere gruista ticino: stipendio e requisiti»
 *   · «Sostanzialmente le novità per i frontaliere gruisti in Ticino»
 *   · «I requisiti e il stipendio medio per i piastrellisti in Ticino…»
 *   · «Quanto guadagna un psicologo frontaliere in Ticino?»
 *
 * Le stringhe usate nelle unit sono QUELLE, non casi inventati.
 *
 * Tre strati, perche' ognuno fallisce in un modo che gli altri due non vedono:
 *   1. unit      — le regole fanno cio' che dicono;
 *   2. wiring    — il generatore le CHIAMA davvero (il difetto precedente era
 *                  esattamente questo: `normalizeTitleCasing` esisteva completa
 *                  e non era cablata nel percorso AI);
 *   3. scan      — nessun campo pubblicato peggiora.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fixMicrocopy,
  findMicrocopyDefects,
  startsWithImpureCluster,
  TOPONYMS_UNAMBIGUOUS,
  TOPONYMS_EXCLUDED_HOMOGRAPHS,
} from '../scripts/lib/it-microcopy-guard.mjs';
import { normalizeTitleCasing } from '../scripts/create-article.mjs';
import { unescapeTsString } from '../scripts/lib/unescape-ts-string.mjs';

const ROOT = resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// 1. LA CAUSA — dimostrata, non raccontata
// ─────────────────────────────────────────────────────────────────────────────

describe('la causa: normalizeTitleCasing esce prima di raggiungere la sua tabella', () => {
  it('NON corregge «Frontaliere gruista ticino», pur conoscendo il toponimo', () => {
    // `TITLE_CASING_PROPER_NOUNS` contiene 'ticino' da sempre. Il titolo non
    // arriva mai fin li' perche' `if (!looksTitleCase && !isShouting) return s;`
    // pretende che ≥60% delle parole cominci per maiuscola, e qui e' 1 su 6.
    // Questa asserzione e' la PROVA che la tabella non e' il problema: se un
    // giorno passasse, vorrebbe dire che qualcuno ha toccato quel ramo e che il
    // razionale di questa guardia va riletto.
    const defective = 'Frontaliere gruista ticino: stipendio e requisiti';
    expect(normalizeTitleCasing(defective)).toBe(defective);
  });

  it('la guardia, che non ha rami di uscita anticipata, lo corregge', () => {
    expect(fixMicrocopy('Frontaliere gruista ticino: stipendio e requisiti', { locale: 'it', field: 'title' }).value)
      .toBe('Frontaliere gruista Ticino: stipendio e requisiti');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LE QUATTRO REGOLE
// ─────────────────────────────────────────────────────────────────────────────

describe('R1 — articolo davanti a s impura / z / ps / gn', () => {
  it.each([
    ['I requisiti e il stipendio medio per i piastrellisti in Ticino', 'I requisiti e lo stipendio medio per i piastrellisti in Ticino'],
    ['Quanto guadagna un psicologo frontaliere in Ticino?', 'Quanto guadagna uno psicologo frontaliere in Ticino?'],
    ['si è preparato per il spareggio', 'si è preparato per lo spareggio'],
    ['ha diritto a un stipendio medio', 'ha diritto a uno stipendio medio'],
  ])('corregge «%s»', (input, expected) => {
    expect(fixMicrocopy(input, { locale: 'it', field: 'excerpt' }).value).toBe(expected);
  });

  it('corregge anche il plurale, conservando la maiuscola iniziale', () => {
    expect(fixMicrocopy('I studenti universitari pendolari', { locale: 'it' }).value)
      .toBe('Gli studenti universitari pendolari');
  });

  it('NON tocca sigle e nomi propri — la condizione e\' il sostantivo minuscolo', () => {
    // «il PS», «dal PNRR», «il Swiss Market Index» sono corretti cosi'.
    for (const s of ['il PS ha votato', 'dal PNRR italiano', 'il Swiss Market Index', 'del Säntis']) {
      expect(findMicrocopyDefects(s, { locale: 'it' }), s).toEqual([]);
    }
  });

  it('NON tocca s + vocale, ne\' «pneumatico» (ambiguo per costruzione)', () => {
    for (const s of ['il sole di Lugano', 'il sereno di settembre', 'il pneumatico invernale']) {
      expect(findMicrocopyDefects(s, { locale: 'it' }), s).toEqual([]);
    }
    expect(startsWithImpureCluster('sole')).toBe(false);
    expect(startsWithImpureCluster('stipendio')).toBe(true);
    expect(startsWithImpureCluster('psicologo')).toBe(true);
  });
});

describe('R2 — toponimo minuscolo', () => {
  it('corregge in ogni locale: il toponimo non si traduce', () => {
    // La cascata free-MT si trascina il minuscolo dall'italiano: misurato vivo
    // su tre titoli FR.
    expect(fixMicrocopy('Frontalier grutier ticino : salaire et exigences', { locale: 'fr', field: 'title' }).value)
      .toBe('Frontalier grutier Ticino : salaire et exigences');
    expect(fixMicrocopy('Grenzgänger Kranführer ticino Lohn', { locale: 'de', field: 'title' }).value)
      .toBe('Grenzgänger Kranführer Ticino Lohn');
  });

  it('NON tocca «svizzera» — 138 hit su 141 sono l\'aggettivo, corretto minuscolo', () => {
    for (const s of ['economia svizzera in crescita', 'la busta paga svizzera', 'assicurazione vita privata svizzera']) {
      expect(findMicrocopyDefects(s, { locale: 'it' }), s).toEqual([]);
    }
    expect(TOPONYMS_UNAMBIGUOUS.has('svizzera')).toBe(false);
    expect(TOPONYMS_EXCLUDED_HOMOGRAPHS).toHaveProperty('svizzera');
  });

  it('ogni omografo escluso porta la sua ragione scritta', () => {
    // Pinnato: togliere un\'esclusione senza motivarla e' come si riapre la
    // classe di falsi positivi che ha reso la regola applicabile.
    for (const [name, reason] of Object.entries(TOPONYMS_EXCLUDED_HOMOGRAPHS)) {
      expect(TOPONYMS_UNAMBIGUOUS.has(name), `${name} non puo' stare in entrambe le liste`).toBe(false);
      expect(String(reason).length, `${name} senza ragione`).toBeGreaterThan(15);
    }
  });

  it('NON tocca un toponimo dentro uno slug o un riferimento nav:', () => {
    // Le minuscole li' sono SINTASSI: riscriverle rompe il link.
    for (const s of ['vedi nav:chiasso-border-crossing per i valichi', 'la pagina lugano-sicurezza-2025 spiega', 'scrivi a info@ticino.ch']) {
      expect(findMicrocopyDefects(s, { locale: 'it' }), s).toEqual([]);
    }
  });
});

describe('R3 — articolo plurale + sostantivo singolare', () => {
  it.each([
    ['Impatti della mobilità sulla vita dei frontaliere ticinesi', 'Impatti della mobilità sulla vita dei frontalieri ticinesi'],
    ['L\'assicurazione vita privata svizzera conviene ai frontaliere?', 'L\'assicurazione vita privata svizzera conviene ai frontalieri?'],
    ['limiti e conseguenze per i frontaliere', 'limiti e conseguenze per i frontalieri'],
  ])('corregge «%s»', (input, expected) => {
    expect(fixMicrocopy(input, { locale: 'it', field: 'title' }).value).toBe(expected);
  });

  it('NON tocca «le frontaliere», plurale femminile legittimo', () => {
    // Solo articoli MASCHILI: «le frontaliere» e' il plurale di «frontaliera».
    expect(findMicrocopyDefects('le frontaliere che lavorano in Ticino', { locale: 'it' })).toEqual([]);
  });

  it('l\'ordine delle regole e\' vincolante: R3 produce un plurale che R1 riarticola', () => {
    // «i stipendio» → R3 → «i stipendi» → R1 → «gli stipendi».
    expect(fixMicrocopy('i stipendio dei frontalieri', { locale: 'it' }).value).toBe('gli stipendi dei frontalieri');
  });
});

describe('R4 — attacco riempitivo (solo excerpt)', () => {
  it('rimuove l\'attacco e rimaiuscola', () => {
    expect(fixMicrocopy('Sostanzialmente le novità per i frontalieri gruisti in Ticino e in altri cantoni svizzeri', { locale: 'it', field: 'excerpt' }).value)
      .toBe('Le novità per i frontalieri gruisti in Ticino e in altri cantoni svizzeri');
  });

  it('NON si applica al titolo', () => {
    const t = 'Sostanzialmente le novità per i frontalieri gruisti in Ticino e altrove';
    expect(fixMicrocopy(t, { locale: 'it', field: 'title' }).value).toBe(t);
  });

  it('NON tocca un\'apertura che significa qualcosa', () => {
    for (const s of ['In questo articolo vediamo come calcolare il netto del frontaliere in Ticino', 'Tutto quello che devi sapere prima del primo giorno di lavoro in Svizzera']) {
      expect(findMicrocopyDefects(s, { locale: 'it', field: 'excerpt' }), s).toEqual([]);
    }
  });

  it('lascia stare l\'attacco se togliendolo resta un moncone', () => {
    const t = 'Sostanzialmente un riassunto.';
    expect(fixMicrocopy(t, { locale: 'it', field: 'excerpt' }).value).toBe(t);
  });
});

describe('proprieta\' generali', () => {
  it('e\' idempotente: rieseguirla non produce altre modifiche', () => {
    for (const s of [
      'I requisiti e il stipendio medio per i frontaliere in ticino',
      'Sostanzialmente le novità per i frontaliere gruisti in ticino e dintorni',
      'Quanto guadagna un psicologo frontaliere in Ticino?',
    ]) {
      const once = fixMicrocopy(s, { locale: 'it', field: 'excerpt' }).value;
      const twice = fixMicrocopy(once, { locale: 'it', field: 'excerpt' });
      expect(twice.fixes, `non idempotente su "${s}"`).toEqual([]);
      expect(twice.value).toBe(once);
    }
  });

  it('la grammatica italiana NON si applica a en/de/fr', () => {
    // Solo R2 gira fuori dall'italiano. «il stipendio» dentro un testo inglese
    // non e' italiano sbagliato, e' un caso che non ci riguarda.
    expect(findMicrocopyDefects('the il stipendio thing', { locale: 'en' })).toEqual([]);
  });

  it('regge input vuoti/non stringa senza esplodere', () => {
    for (const v of ['', '   ', null, undefined, 42]) {
      expect(() => findMicrocopyDefects(v as never, { locale: 'it' })).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WIRING — la guardia esiste E viene chiamata
// ─────────────────────────────────────────────────────────────────────────────

describe('wiring: i percorsi di pubblicazione chiamano davvero la guardia', () => {
  // L'incidente precedente non fu una funzione mancante: `normalizeTitleCasing`
  // esisteva completa ed era cablata SOLO in publish-journalist-article.mjs.
  // Una guardia non chiamata e' indistinguibile da una guardia assente, e la
  // CI non vede la differenza se nessuno la asserisce.
  const generator = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');
  const journalist = readFileSync(resolve(ROOT, 'scripts/publish-journalist-article.mjs'), 'utf8');

  it('create-article.mjs importa la guardia dal modulo condiviso', () => {
    expect(generator).toMatch(/import\s*\{[^}]*fixMicrocopy[^}]*\}\s*from\s*'\.\/lib\/it-microcopy-guard\.mjs'/);
  });

  it('create-article.mjs la applica al contenuto IT', () => {
    expect(generator).toMatch(/applyMicrocopyGuard\(itContent,\s*'it'\)/);
  });

  it('create-article.mjs la applica a OGNI locale tradotto', () => {
    // Il toponimo minuscolo arriva in FR attraverso la cascata free-MT: coprire
    // solo l'italiano lascia scoperti tre quarti dei campi pubblicati.
    expect(generator).toMatch(/applyMicrocopyGuard\(localeContent,\s*locale\)/);
  });

  it('publish-journalist-article.mjs la applica dopo generateExcerpt', () => {
    // E' il percorso VIVO: cron */15 in publish-journalist-articles.yml.
    expect(journalist).toMatch(/applyMicrocopyGuard\(data\.content\.it,\s*'it'\)/);
    const excerptAt = journalist.indexOf('await generateExcerpt(');
    const guardAt = journalist.indexOf('applyMicrocopyGuard(data.content.it');
    expect(excerptAt, 'generateExcerpt non trovato').toBeGreaterThan(-1);
    expect(guardAt, 'la guardia deve girare DOPO che l\'excerpt esiste').toBeGreaterThan(excerptAt);
  });

  it('la guardia e\' esportata da create-article.mjs (il journalist la importa)', () => {
    expect(generator).toMatch(/export\s*\{[^}]*applyMicrocopyGuard/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SCAN sui campi pubblicati
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I campi gia' pubblicati che la guardia riscriverebbe, al 2026-08-09.
 *
 * ── Perche' una baseline e non «zero offender» ────────────────────────────
 *
 * `packages/articles/content/` NON e' scritto qui: e' un mirror discendente di
 * `nanakokyobashi-rgb/frontaliere-articles`, sincronizzato da
 * `scripts/pull-articles-corpus.mjs` (che fa `mirrorTree`, cioe' sovrascrive)
 * su ogni `articles-published` piu' il cron 5:23/17:23 di
 * `sync-articles-sitemaps.yml`. Ripararli QUI verrebbe cancellato dal sync
 * successivo; la riparazione vera e' `frontaliere-articles#122`, a monte.
 *
 * ── Perche' insiemistica e non uguaglianza esatta ─────────────────────────
 *
 * Il corpus congela i suoi offender con uguaglianza esatta, e li' e' giusto:
 * chi ripara il dato tocca anche la lista, nello stesso repo. Qui no. Queste
 * voci spariranno da sole quando #122 scendera' col mirror, senza che nessuno
 * apra una PR in questo repo: un\'uguaglianza esatta renderebbe `main` rosso —
 * e con esso ogni PR aperta — per una fix atterrata altrove. L\'insieme puo'
 * quindi solo RESTRINGERSI. Un campo nuovo, o un articolo nuovo, fallisce: ed
 * e' quello il punto.
 */
const PUBLISHED_OFFENDERS_2026_08_09 = new Set([
  'blog-meta-ch-it|assicurazione-vita-privata-svizzera-convienne-frontaliere.excerpt',
  'blog-meta-ch-it|frontaliere-assistente-di-cura-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|frontaliere-disegnatore-tecnico-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|frontaliere-lattoniere-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|frontaliere-receptionist-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|frontaliere-risorse-umane-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|saldatore-frontaliere-ticino-stipendio-requisiti.excerpt',
  'blog-meta-ch-it|stipendio-psicologo-frontaliere-ticino.excerpt',
  'blog-meta-ch-it|stipendio-psicologo-frontaliere-ticino.title',
  'blog-meta-fr|frontaliere-gruista-ticino-stipendio-requisiti.title',
  'blog-meta-fr|frontaliere-ingegnere-ticino-stipendio.title',
  'blog-meta-fr|insegnanti-frontalieri-stipendio-requisiti-ticino.title',
  'blog-meta-fr|lugano-sicurezza-2025.excerpt',
  'blog-meta-it|assicurazione-vita-privata-svizzera-convienne-frontalieri.title',
  'blog-meta-it|franchigia-doganale-acquisti-svizzera.title',
  'blog-meta-it|frontaliere-documenti-primo-giorno-lavoro-ticino-2026-famiglia-con-figli.excerpt',
  'blog-meta-it|frontaliere-gruista-ticino-stipendio-requisiti.excerpt',
  'blog-meta-it|frontaliere-gruista-ticino-stipendio-requisiti.title',
  'blog-meta-it|frontaliere-ingegnere-ticino-stipendio.title',
  'blog-meta-it|frontaliere-operaio-ticino-stipendio-requisiti.excerpt',
  'blog-meta-it|frontaliere-ostetrica-ticino-stipendio-requisiti.excerpt',
  'blog-meta-it|frontaliere-piastrellista-ticino-stipendio-requisiti.excerpt',
  'blog-meta-it|frontaliere-pittore-ticino-stipendio-requisiti.excerpt',
  'blog-meta-it|frontaliere-ticino-mobilita.title',
  'blog-meta-it|hockey-nl-psicodramma-davos-2025-2026-friborgogotteron.excerpt',
  'blog-meta-it|infortunio-in-iter-confine-assicurazione-frontaliere.excerpt',
  'blog-meta-it|insegnanti-frontalieri-stipendio-requisiti-ticino.title',
  'blog-meta-it|leggi-frontalieri-2026.excerpt',
  'blog-meta-it|stipendio-contabile-frontaliere-ticino.excerpt',
  'blog-meta-it|studente-universitario-pendolare-ticino-usi-supsi.excerpt',
  'blog-meta-it|trasferirsi-a-bizzarone-da-frontaliere-pro-e-contro.excerpt',
  'blog-meta-it|trasferirsi-a-maccagno-con-pino-e-veddasca-da-frontaliere-pro-e-contro.excerpt',
  'blog-meta-it|vivere-a-trasquera-e-lavorare-in-ticino-da-frontaliere.excerpt',
  'blog-meta-it|vivere-bizzarone-lavorare-ticino.excerpt',
]);

const META_FILES = [
  'blog-meta-it', 'blog-meta-en', 'blog-meta-de', 'blog-meta-fr',
  'blog-meta-ch-it', 'blog-meta-ch-en', 'blog-meta-ch-de', 'blog-meta-ch-fr',
] as const;

function scanPublishedMeta() {
  const offenders: Array<{ key: string; value: string; rules: string[] }> = [];
  let scanned = 0;
  let filesRead = 0;
  for (const name of META_FILES) {
    const path = resolve(ROOT, 'packages/articles/content', `${name}.ts`);
    let src: string;
    try {
      src = readFileSync(path, 'utf8');
    } catch {
      continue; // conteggiato dal fail-closed sotto
    }
    filesRead += 1;
    const locale = name.endsWith('-it') ? 'it' : name.endsWith('-en') ? 'en' : name.endsWith('-de') ? 'de' : 'fr';
    for (const m of src.matchAll(/'blog\.article\.([^']+)\.(title|excerpt)':\s*'((?:[^'\\]|\\.)*)'/g)) {
      const [, id, field, raw] = m;
      const value = unescapeTsString(raw, { "'": "'", '\\': '\\' });
      scanned += 1;
      const fixes = findMicrocopyDefects(value, { locale, field: field as 'title' | 'excerpt' });
      if (fixes.length) offenders.push({ key: `${name}|${id}.${field}`, value, rules: fixes.map((f) => f.rule) });
    }
  }
  return { offenders, scanned, filesRead };
}

describe('scan dei campi pubblicati', () => {
  const { offenders, scanned, filesRead } = scanPublishedMeta();

  it('legge davvero tutti e otto i file meta (fail-closed)', () => {
    // Senza questa soglia uno sparse checkout, o una regex che smette di
    // matchare, farebbe passare lo scan a vuoto: zero campi letti, zero
    // offender, verde. E' l'errore diagnostico piu' facile da fare qui.
    expect(filesRead, 'file meta letti').toBe(META_FILES.length);
    expect(scanned, 'campi title+excerpt scansionati').toBeGreaterThan(20_000);
  });

  it('nessun campo difettoso oltre a quelli gia\' pubblicati il 2026-08-09', () => {
    const fresh = offenders.filter((o) => !PUBLISHED_OFFENDERS_2026_08_09.has(o.key)).sort((a, b) => a.key.localeCompare(b.key));
    expect(
      fresh.map((o) => `${o.key} [${o.rules.join(',')}] "${o.value.slice(0, 120)}"`),
      'un campo pubblicato ha un difetto di microcopy che la baseline del 2026-08-09 non conosce. ' +
        'Se arriva dal corpus, la fix va la\' (nanakokyobashi-rgb/frontaliere-articles): ' +
        'packages/articles/content/ e\' un mirror discendente e riscriverlo qui viene sovrascritto ' +
        'dal prossimo pull-articles-corpus.mjs. NON allargare la baseline per farlo passare.',
    ).toEqual([]);
  });

  it('la baseline puo\' solo restringersi', () => {
    // Nessuna asserzione di uguaglianza: le voci spariranno quando #122
    // scendera' col mirror. Qui si verifica solo che non cresca.
    expect(offenders.length).toBeLessThanOrEqual(PUBLISHED_OFFENDERS_2026_08_09.size);
  });
});
