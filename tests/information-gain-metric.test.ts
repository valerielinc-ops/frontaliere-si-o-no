/**
 * The Information-Gain metric engine (issue #5002).
 *
 * What is pinned here is the ONE property the metric lives or dies on: that a
 * mail-merge family — identical prose with the place name and the figures
 * swapped — scores zero, while a page carrying a sentence of its own scores
 * above zero. Every earlier attempt at this measurement in this repo's history
 * failed the same way: `audit-content-duplicates.mjs` hashes the whole body and
 * a swapped digit breaks the hash, so 30 near-identical pages come back clean.
 *
 * The fixtures are hand-written HTML, not real dist pages: the assertions are
 * about the masking and cohorting rules, and a real page would make them
 * depend on whatever that page happens to say today.
 */
import { describe, it, expect } from 'vitest';
import {
  fingerprintPage,
  scoreCohorts,
  maskSegment,
  entityTokensFrom,
  commonPathPrefix,
  localeOfPath,
  urlPathOf,
  extractVisibleText,
  segmentsFromText,
  INFORMATION_GAIN_TUNABLES,
} from '@/scripts/lib/informationGain.mjs';
import { factory as createInformationGainAuditor } from '@/scripts/audit-information-gain.mjs';

/** A mail-merge page: same prose, place name and figure substituted. */
const mailMergePage = (name: string, rate: string): string => `<!doctype html>
<html lang="it"><head><title>Tasse frontalieri a ${name}</title></head>
<body>
  <h1>Tasse frontaliere residente a ${name}: vecchio vs nuovo regime</h1>
  <p>A ${name} l'addizionale comunale IRPEF è ${rate}. Con il nuovo regime frontalieri un profilo tipo perde netto rispetto al vecchio regime.</p>
  <h2>Come funziona l'accordo 2024</h2>
  <p>I vecchi frontalieri residenti nella fascia di 20 km, come ${name}, restano a tassazione esclusiva in Svizzera e non versano IRPEF italiana.</p>
  <p>I nuovi frontalieri sono a tassazione concorrente: a ${name} l'addizionale comunale è ${rate} nello scenario tipo di questa pagina.</p>
</body></html>`;

describe('information-gain: una famiglia mail-merge vale zero', () => {
  const pages = [
    ['dist/tasse-frontalieri-comune/tradate/index.html', mailMergePage('Tradate', '0,7%')],
    ['dist/tasse-frontalieri-comune/bregnano/index.html', mailMergePage('Bregnano', '0,55%')],
    ['dist/tasse-frontalieri-comune/colverde/index.html', mailMergePage('Colverde', '0,55%')],
    ['dist/tasse-frontalieri-comune/inverigo/index.html', mailMergePage('Inverigo', '0,55%')],
  ] as const;

  const fingerprints = pages.map(([path, html]) => fingerprintPage(path.replace(/^dist\//, ''), html));

  it('mette le pagine dello stesso template nella stessa coorte', () => {
    const { cohorts } = scoreCohorts(fingerprints, { minCohortPages: 2 });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].pages).toBe(4);
    expect(cohorts[0].label).toBe('it:/tasse-frontalieri-comune/');
  });

  it('assegna gain zero: nessuna pagina dice qualcosa che le sorelle non dicano', () => {
    const { cohorts } = scoreCohorts(fingerprints, { minCohortPages: 2 });
    expect(cohorts[0].medianIgs).toBe(0);
    expect(cohorts[0].zeroGainPages).toBe(4);
  });

  it('la cifra sostituita NON conta come prosa nuova', () => {
    // Il punto dell'intera misura: 0,7% e 0,55% rompono un hash SHA-256 del
    // corpo — ed è per questo che audit-content-duplicates è verde su queste
    // pagine — ma la frase che le contiene è la stessa frase.
    const a = maskSegment("A Tradate l'addizionale comunale IRPEF è 0,7%.", entityTokensFrom({ h1: 'Tradate' }));
    const b = maskSegment("A Bregnano l'addizionale comunale IRPEF è 0,55%.", entityTokensFrom({ h1: 'Bregnano' }));
    expect(a).toBe(b);
  });
});

describe('information-gain: una pagina con contenuto proprio sale sopra zero', () => {
  const withOwnBlock = (name: string, rate: string, neighbours: string): string =>
    mailMergePage(name, rate).replace(
      '</body>',
      `<section data-nearest-comparison="1">
         <h2>Confronto con i comuni più vicini</h2>
         <p>Entro 5,7 km da ${name} ci sono 6 comuni con una pagina su questo sito: ${neighbours}.</p>
       </section></body>`,
    );

  const fingerprints = [
    ['tasse-frontalieri-comune/tradate/index.html', withOwnBlock('Tradate', '0,7%', 'Lonate Ceppino, Venegono Inferiore e Cairate')],
    ['tasse-frontalieri-comune/bregnano/index.html', withOwnBlock('Bregnano', '0,55%', 'Lomazzo, Cermenate e Rovellasca')],
    ['tasse-frontalieri-comune/colverde/index.html', withOwnBlock('Colverde', '0,55%', 'Parè, Villa Guardia e Montano Lucino')],
    ['tasse-frontalieri-comune/inverigo/index.html', withOwnBlock('Inverigo', '0,55%', 'Arosio, Lurago d’Erba e Verano Brianza')],
  ].map(([path, html]) => fingerprintPage(path, html));

  it('nessuna pagina resta a gain zero', () => {
    const { cohorts } = scoreCohorts(fingerprints, { minCohortPages: 2 });
    expect(cohorts[0].zeroGainPages).toBe(0);
    expect(cohorts[0].medianIgs).toBeGreaterThan(0);
  });

  it('i nomi dei VICINI sopravvivono al mascheramento, il nome PROPRIO no', () => {
    // Il mascheramento è per-pagina, non sull'unione dei nomi della coorte:
    // mascherare anche i vicini cancellerebbe l'unica cosa che differenzia le
    // pagine, e il blocco appena aggiunto tornerebbe a valere zero.
    const tokens = entityTokensFrom({ h1: 'Tasse a Tradate', slugPath: '/tasse-frontalieri-comune/tradate/' });
    const masked = maskSegment('Entro 5,7 km da Tradate ci sono 6 comuni: Cairate e Mozzate.', tokens);
    expect(masked).not.toContain('tradate');
    expect(masked).toContain('cairate');
    expect(masked).toContain('mozzate');
  });
});

describe('information-gain: coorti e soglie', () => {
  it('una pagina sola non è una coorte — senza sorelle non c’è ridondanza', () => {
    const only = [fingerprintPage('pagina-unica/index.html', mailMergePage('Unica', '0,5%'))];
    const { cohorts, pagesUncohorted } = scoreCohorts(only, { minCohortPages: 2 });
    expect(cohorts).toHaveLength(0);
    expect(pagesUncohorted).toBe(1);
  });

  it('sotto minCohortPages la coorte è riportata ma non gated', () => {
    // Nomi di almeno tre caratteri: `entityTokensFrom` scarta i token più
    // corti (mascherare "di"/"da" collasserebbe prosa che non è identità di
    // pagina), quindi un fixture con nomi di una lettera non verrebbe
    // mascherato e finirebbe in tre coorti da uno.
    const three = ['alfa', 'beta', 'gamma'].map((slug) =>
      fingerprintPage(`fam/${slug}/index.html`, mailMergePage(slug[0].toUpperCase() + slug.slice(1), '0,5%')),
    );
    const { cohorts } = scoreCohorts(three, { minCohortPages: 12 });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].gated).toBe(false);
  });

  it('locali diversi non si confrontano tra loro', () => {
    const fingerprints = [
      fingerprintPage('tasse-frontalieri-comune/tradate/index.html', mailMergePage('Tradate', '0,7%')),
      fingerprintPage('en/tasse-frontalieri-comune/tradate/index.html', mailMergePage('Tradate', '0,7%')),
    ];
    const { cohorts, pagesUncohorted } = scoreCohorts(fingerprints, { minCohortPages: 2 });
    expect(cohorts).toHaveLength(0);
    expect(pagesUncohorted).toBe(2);
  });
});

describe('information-gain: utility di percorso', () => {
  it('etichetta la coorte con il prefisso comune', () => {
    expect(commonPathPrefix(['/a/b/x/', '/a/b/y/'])).toBe('/a/b/');
  });

  it('per gli slug piatti cade sul prefisso di caratteri', () => {
    // `/lavoro-ticino-infermiere/` e `/lavoro-ticino-muratore/` non
    // condividono un segmento intero: senza questo fallback l'etichetta
    // sarebbe `/` per ogni famiglia flat, e l'inventario del gate non
    // potrebbe nominarne una.
    expect(commonPathPrefix(['/lavoro-ticino-infermiere/', '/lavoro-ticino-muratore/'])).toBe('/lavoro-ticino-');
  });

  it('cade sul prefisso di caratteri anche DOPO un segmento comune (issue #6975)', () => {
    // Stessa famiglia flat-slug, due locali. In `it` gli slug stanno alla
    // radice e il fallback scattava; in `de`/`en`/`fr` il segmento di locale è
    // comune a tutte le pagine, quindi il fallback non scattava mai e l'intera
    // famiglia si riduceva a `/en/` — un'etichetta che collide con ogni altra
    // famiglia flat della stessa lingua e che, essendo la chiave di
    // `KNOWN_LOW_GAIN_COHORTS`, non può nominarne una sola.
    expect(commonPathPrefix(['/en/jobs-bern-fitter/', '/en/jobs-aargau-cook/'])).toBe('/en/jobs-');
    expect(commonPathPrefix(['/de/arbeit-bern-architekt/', '/de/arbeit-freiburg-maurer/'])).toBe('/de/arbeit-');
  });

  it('si ferma al confine di token: una lettera condivisa non è un template condiviso', () => {
    // Il passo di caratteri viene troncato all'ultimo `-`, altrimenti
    // l'etichetta dipenderebbe da QUALI pagine il run ha campionato:
    // `tradate|torino` condividono una `t` e darebbero
    // `/tasse-frontalieri-comune/t`, `tradate|bregnano` no. Con il confine di
    // token l'etichetta è la stessa nei due casi — è questo che tiene valide
    // le voci già in `KNOWN_LOW_GAIN_COHORTS` e la tabella di calibrazione,
    // scritte prima del fix.
    expect(commonPathPrefix(['/tasse-frontalieri-comune/tradate/', '/tasse-frontalieri-comune/bregnano/'])).toBe(
      '/tasse-frontalieri-comune/',
    );
    expect(commonPathPrefix(['/tasse-frontalieri-comune/tradate/', '/tasse-frontalieri-comune/torino/'])).toBe(
      '/tasse-frontalieri-comune/',
    );
    expect(commonPathPrefix(['/lavoro-ticino-infermiere/', '/lavoro-ticino-idraulico/'])).toBe('/lavoro-ticino-');
    expect(
      commonPathPrefix([
        '/vivere-in-austria-lavorare-in-svizzera/gaissau/',
        '/vivere-in-austria-lavorare-in-svizzera/hohenems/',
      ]),
    ).toBe('/vivere-in-austria-lavorare-in-svizzera/');
    expect(commonPathPrefix(['/a/b/x/', '/a/b/'])).toBe('/a/b/');
  });

  it('due famiglie flat-slug DISTINTE che collidono sul prefisso di caratteri non finiscono con la stessa etichetta', () => {
    // `commonPathPrefix` calcola l'etichetta di ogni coorte in isolamento, senza
    // vedere le coorti sorelle: due template realmente diversi (skeletonHash
    // diverso) possono ridursi allo stesso prefisso di caratteri se i loro slug
    // condividono un tratto iniziale abbastanza lungo. La collisione non è
    // cosmetica: `audit-information-gain.mjs` indicizza `KNOWN_LOW_GAIN_COHORTS`
    // per etichetta, quindi due coorti con la stessa etichetta condividerebbero
    // silenziosamente una baseline registrata per la famiglia sbagliata.
    const professionPage = (job: string): string => `<!doctype html>
<html lang="it"><head><title>Lavoro Ticino ${job}</title></head>
<body>
  <h1>Offerte di lavoro come ${job} in Ticino</h1>
  <p>Cerchi lavoro come ${job} in Ticino? Consulta le offerte aperte oggi.</p>
</body></html>`;
    const comparisonPage = (thing: string): string => `<!doctype html>
<html lang="it"><head><title>Confronto Ticino ${thing}</title></head>
<body>
  <h1>Confronto ${thing} tra i comuni del Ticino</h1>
  <p>Ecco come cambia ${thing} da un comune all'altro del cantone.</p>
</body></html>`;

    const professionFingerprints = [
      ['lavoro-ticino-infermiere/index.html', professionPage('infermiere')],
      ['lavoro-ticino-muratore/index.html', professionPage('muratore')],
    ].map(([path, html]) => fingerprintPage(path, html));
    const comparisonFingerprints = [
      ['lavoro-ticino-affitti/index.html', comparisonPage('gli affitti')],
      ['lavoro-ticino-stipendi/index.html', comparisonPage('gli stipendi')],
    ].map(([path, html]) => fingerprintPage(path, html));

    const { cohorts } = scoreCohorts([...professionFingerprints, ...comparisonFingerprints], { minCohortPages: 2 });

    expect(cohorts).toHaveLength(2);
    const [labelA, labelB] = cohorts.map((c) => c.label);
    expect(labelA).not.toBe(labelB);
    // Entrambe restano riconoscibili come la famiglia flat-slug che erano:
    // il disambiguatore è un suffisso, non una sostituzione dell'etichetta.
    expect(labelA.startsWith('it:/lavoro-ticino-')).toBe(true);
    expect(labelB.startsWith('it:/lavoro-ticino-')).toBe(true);
  });

  it('riconosce il locale dal prefisso, con it come default non prefissato', () => {
    expect(localeOfPath('de/leben-im-tessin/x/index.html')).toBe('de');
    expect(localeOfPath('vivere-in-ticino/x/index.html')).toBe('it');
  });

  it('normalizza il percorso dist nella URL servita', () => {
    expect(urlPathOf('index.html')).toBe('/');
    expect(urlPathOf('a/b/index.html')).toBe('/a/b/');
    expect(urlPathOf('a/b.html')).toBe('/a/b/');
  });
});

describe('information-gain: estrazione del testo', () => {
  it('non incolla un heading al paragrafo che lo segue', () => {
    // Unendo attraverso i confini di elemento, ogni segmento diventerebbe
    // "heading + paragrafo" e risulterebbe page-specific per costruzione.
    const segments = segmentsFromText(
      extractVisibleText('<body><h2>Un titolo abbastanza lungo da contare</h2><p>Un paragrafo abbastanza lungo da contare.</p></body>'),
    );
    expect(segments).toHaveLength(2);
  });

  it('ignora script, style e commenti', () => {
    const text = extractVisibleText(
      '<body><script>var x = "una stringa lunga dentro uno script";</script><p>Testo visibile abbastanza lungo.</p></body>',
    );
    expect(text).not.toContain('dentro uno script');
    expect(text).toContain('Testo visibile');
  });

  it('sopra il cap, campiona a passo costante invece di tagliare ai primi N', () => {
    // Una pagina più lunga del cap con un template boilerplate ripetuto in
    // testa e un blocco page-specific dopo il cap: il taglio ai primi N
    // (il comportamento vecchio) lo avrebbe perso sempre, sottostimando
    // l'IGS proprio sulle pagine più ricche (rif. reviewer #6330).
    const { MAX_SEGMENTS_PER_PAGE } = INFORMATION_GAIN_TUNABLES;
    const boilerplateCount = MAX_SEGMENTS_PER_PAGE + 50;
    const boilerplate = Array.from(
      { length: boilerplateCount },
      (_, i) => `<p>Frase generica del template numero ${i} ripetuta su ogni pagina della famiglia.</p>`,
    ).join('');
    const html = `<body>${boilerplate}<p>Questo paragrafo finale contiene il MARCATORE unico di questa pagina.</p></body>`;

    const segments = segmentsFromText(extractVisibleText(html));

    expect(segments.length).toBe(MAX_SEGMENTS_PER_PAGE);
    expect(segments.some((s) => s.includes('MARCATORE'))).toBe(true);
  });
});

describe('information-gain: le pagine noindex sono escluse anche senza apici (issue #6585)', () => {
  // htmlMinify's unquoteSafeAttributes() strips quotes from HTML5-safe
  // attribute values on every emitted page, so a served noindex page reads
  // `<meta name=robots content=noindex,follow>`, not the quoted form. A
  // quote-mandatory regex in collect() would silently score these bridge
  // pages as indexable and drag their family's median down.
  it('non aggiunge una pagina noindex non quotata alle pagine misurate', () => {
    const auditor = createInformationGainAuditor();
    const noindexHtml = '<!doctype html><html><head><meta name=robots content=noindex,follow>'
      + '<title>Bridge</title></head><body><p>Poche parole di raccordo.</p></body></html>';
    const indexableHtml = '<!doctype html><html><head><title>Pagina</title></head>'
      + '<body><p>Un paragrafo di contenuto indicizzabile.</p></body></html>';

    auditor.collect('dist/noindex-bridge/index.html', noindexHtml);
    auditor.collect('dist/pagina-indicizzabile/index.html', indexableHtml);

    const { extra } = auditor.report();
    expect(extra.pagesScored + extra.pagesUncohorted).toBe(1);
  });
});

describe('information-gain: il report nomina l\'identità della coorte, non solo l\'etichetta (issue #6975)', () => {
  // L'etichetta è derivata dai path CAMPIONATI, quindi due run con
  // `AUDIT_SAMPLE_RATE` diverso possono chiamare la stessa famiglia in due
  // modi. `KNOWN_LOW_GAIN_COHORTS` è indicizzato per etichetta: senza lo
  // `skeletonHash` nel report non c'è modo di inventariare una coorte se non
  // indovinando quale nome tornerà al run successivo.
  it('espone lo skeletonHash di ogni coorte gated', () => {
    const auditor = createInformationGainAuditor();
    for (let i = 0; i < 12; i += 1) {
      auditor.collect(
        `dist/premi-cassa-malati/cantone-${i}/index.html`,
        `<!doctype html><html lang="it"><head><title>Premi cassa malati cantone-${i}</title></head>
<body><h1>Premi cassa malati nel cantone-${i}</h1>
<p>Nel cantone-${i} il premio medio mensile per un adulto è di ${200 + i} franchi al mese.</p>
<p>Il premio dipende dalla franchigia scelta e dal modello assicurativo sottoscritto.</p>
</body></html>`,
      );
    }

    const { extra } = auditor.report();
    expect(extra.cohortsGated).toBe(1);
    const [cohort] = extra.cohorts;
    expect(cohort.label).toBe('it:/premi-cassa-malati/cantone-');
    // Stessa larghezza del suffisso `~` anti-collisione, così un'etichetta
    // `en:/en/~896cea` si cerca nel report per uguaglianza e non per prefisso.
    expect(cohort.skeletonHash).toMatch(/^[0-9a-f]{1,6}$/);
  });
});
