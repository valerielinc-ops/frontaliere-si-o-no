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
 *
 * ONE deliberate exception, at the bottom of the file (issue #7383): the keys of
 * `KNOWN_LOW_GAIN_COHORTS` are not a rule, they are a claim about the labels the
 * build actually emits — so they are checked against a committed fixture of the
 * slugs really emitted by those three families, not against synthetic pairs. The
 * fixture is URL paths only, so it does not depend on what a page says today.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  fingerprintPage,
  scoreCohorts,
  maskSegment,
  entityTokensFrom,
  commonPathPrefix,
  localeOfPath,
  urlPathOf,
  resolveInventoryEntry,
  isFamilyWideMeasure,
  extractVisibleText,
  segmentsFromText,
  INFORMATION_GAIN_TUNABLES,
} from '@/scripts/lib/informationGain.mjs';
import {
  factory as createInformationGainAuditor,
  INFORMATION_GAIN_GATE,
} from '@/scripts/audit-information-gain.mjs';

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

describe('information-gain: la rotazione del bucket di campionamento non cambia il verdetto (issue #7384)', () => {
  // `audit-all.mjs` ruota il bucket a ogni run (`AUDIT_SAMPLE_SALT` =
  // `$GITHUB_RUN_NUMBER`), quindi due run consecutivi vedono sottoinsiemi
  // DISGIUNTI della stessa famiglia. L'etichetta è il prefisso comune dei path
  // CAMPIONATI: più stretto è il bucket, più lunga l'etichetta. Con un
  // inventario indicizzato per uguaglianza, una forma risolve e l'altra no →
  // `below-floor` → gate rosso a run alterni, a contenuto immutato.

  /** Mail-merge salariale: stessa prosa, professione e cifra sostituite. */
  const salaryPage = (job: string, gross: string): string => `<!doctype html>
<html lang="it"><head><title>Stipendio medio in Svizzera: ${job}</title></head>
<body>
  <h1>Stipendio medio in Svizzera per ${job}</h1>
  <p>Lo stipendio mediano lordo di ${job} in Svizzera è di ${gross} franchi all'anno secondo la rilevazione federale.</p>
  <h2>Come si legge questa cifra</h2>
  <p>La mediana divide la popolazione salariale a metà ed è meno sensibile agli estremi rispetto alla media aritmetica.</p>
  <p>Il valore lordo non tiene conto dei contributi sociali obbligatori né dell'imposta alla fonte del frontaliere.</p>
</body></html>`;

  /** Un bucket di campionamento: 12 pagine consecutive di una sotto-famiglia. */
  const sampleBucket = (slugStem: string) => {
    const auditor = createInformationGainAuditor();
    for (let i = 1; i <= 12; i += 1) {
      auditor.collect(
        `dist/stipendio-medio-svizzera-${slugStem}-${i}/index.html`,
        salaryPage(`${slugStem}-${i}`, String(60000 + i * 1000)),
      );
    }
    const { extra, passed } = auditor.report();
    return { passed, cohort: extra.cohorts[0], gated: extra.cohortsGated };
  };

  const bucketA = sampleBucket('informatico');
  const bucketB = sampleBucket('infermiere');

  it('due bucket disgiunti della stessa famiglia producono etichette DIVERSE', () => {
    expect(bucketA.gated).toBe(1);
    expect(bucketB.gated).toBe(1);
    expect(bucketA.cohort.label).toBe('it:/stipendio-medio-svizzera-informatico-');
    expect(bucketB.cohort.label).toBe('it:/stipendio-medio-svizzera-infermiere-');
    expect(bucketA.cohort.label).not.toBe(bucketB.cohort.label);
  });

  it('entrambi risolvono alla STESSA voce di inventario, quindi nessun offender', () => {
    // È la risoluzione a decidere il colore del gate, non l'uguaglianza delle
    // etichette: entrambe le forme devono cadere sulla riga già inventariata.
    expect(bucketA.cohort.inventoryKey).toBe('it:/stipendio-medio-svizzera-');
    expect(bucketB.cohort.inventoryKey).toBe(bucketA.cohort.inventoryKey);
    expect(bucketA.passed).toBe(true);
    expect(bucketB.passed).toBe(true);
  });

  it('la voce risolta è quella reale di KNOWN_LOW_GAIN_COHORTS', () => {
    const { KNOWN_LOW_GAIN_COHORTS } = INFORMATION_GAIN_GATE;
    const entry = resolveInventoryEntry(KNOWN_LOW_GAIN_COHORTS, bucketA.cohort.label);
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe('it:/stipendio-medio-svizzera-');
    expect(entry!.value).toBe(KNOWN_LOW_GAIN_COHORTS.get('it:/stipendio-medio-svizzera-'));
  });
});

describe('information-gain: la relazione di prefisso non allarga l\'inventario (issue #7384)', () => {
  const inventory = new Map([
    ['it:/stipendio-medio-svizzera-', 0],
    ['it:/vivere-in-austria-lavorare-in-svizzera/', 4.2],
  ]);

  it('un\'etichetta che ESTENDE una chiave risolve a quella chiave', () => {
    expect(resolveInventoryEntry(inventory, 'it:/stipendio-medio-svizzera-zurigo-')).toEqual({
      key: 'it:/stipendio-medio-svizzera-',
      value: 0,
    });
  });

  it('un\'etichetta che TRONCA una chiave non risolve: è una famiglia più larga', () => {
    // Un campione non può accorciare il prefisso comune di una famiglia, quindi
    // un'etichetta più corta della chiave è un'altra coorte — darle la baseline
    // registrata la esenterebbe dal floor senza averla mai misurata.
    expect(resolveInventoryEntry(inventory, 'it:/stipendio-medio-')).toBeNull();
    expect(resolveInventoryEntry(inventory, 'it:/')).toBeNull();
  });

  it('il locale fa parte della chiave: `de:` non pesca la riga `it:`', () => {
    expect(resolveInventoryEntry(inventory, 'de:/de/stipendio-medio-svizzera-')).toBeNull();
  });

  it('il suffisso `~` anti-collisione non eredita la baseline della chiave nuda', () => {
    // Il suffisso esiste perché DUE template distinti si sono ridotti a
    // un'etichetta sola: farli risolvere entrambi alla stessa riga è esattamente
    // la condivisione di baseline che il suffisso impedisce.
    expect(resolveInventoryEntry(inventory, 'it:/stipendio-medio-svizzera-~896cea')).toBeNull();
  });

  it('vince la chiave PIÙ SPECIFICA fra quelle che l\'etichetta estende', () => {
    const nested = new Map([
      ['it:/lavoro-', 1],
      ['it:/lavoro-ticino-', 2],
    ]);
    expect(resolveInventoryEntry(nested, 'it:/lavoro-ticino-autista-')).toEqual({
      key: 'it:/lavoro-ticino-',
      value: 2,
    });
  });
});

describe("information-gain: ogni chiave d'inventario coincide con l'etichetta emessa dalla sua famiglia (issue #7383)", () => {
  // Le assertion qui sotto sono le uniche del file costruite su slug REALI: la
  // fixture è l'estrazione delle sitemap di produzione (comando e data dentro
  // il JSON). Serve perché `KNOWN_LOW_GAIN_COHORTS` è indicizzata PER ETICHETTA
  // e l'etichetta la calcola `commonPathPrefix()` sui path davvero emessi — una
  // chiave scritta a mano che non coincide non risolve (una label che TRONCA la
  // chiave non risolve, #7384), la coorte risulta non inventariata e il gate
  // fallisce duro il giorno in cui la famiglia supera `MIN_COHORT_PAGES`. Fino a
  // qui la calibrazione era verificata solo su coppie sintetiche
  // (`tradate|torino`, `gaissau|hohenems`), che non sono gli slug emessi.
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/information-gain-emitted-slugs.json', import.meta.url), 'utf8'),
  ) as {
    families: Array<{ inventoryKey: string; sitemap: string; urlPaths: string[] }>;
    templates: Array<{
      inventoryKey: string;
      sitemap: string;
      observedMedianIgsPct: number;
      observedLabels: Array<{ run: string; label: string }>;
    }>;
  };
  const inventoryKeys = [...INFORMATION_GAIN_GATE.KNOWN_LOW_GAIN_COHORTS.keys()];
  const TEMPLATE_KEY_RE = /^[a-z]{2}:~[0-9a-f]{6}$/;

  it('la fixture copre esattamente le chiavi inventariate', () => {
    // Aggiungere una riga a `KNOWN_LOW_GAIN_COHORTS` senza gli slug emessi che
    // la giustificano rompe qui: è l'unico modo per impedire che la prossima
    // chiave torni a essere non verificata, che è esattamente il difetto di
    // questa issue.
    // Le due liste sono disgiunte per costruzione: `families` sono tronchi di
    // path, `templates` identità di template `<locale>:~<hash>` — una chiave
    // non può essere entrambe, ed è la sua forma a dirlo.
    const covered = [
      ...fixture.families.map((f) => f.inventoryKey),
      ...fixture.templates.map((t) => t.inventoryKey),
    ];
    expect(covered.sort()).toEqual([...inventoryKeys].sort());
    expect(fixture.families.every((f) => !f.inventoryKey.includes('~'))).toBe(true);
    expect(fixture.templates.every((t) => TEMPLATE_KEY_RE.test(t.inventoryKey))).toBe(true);
  });

  for (const family of fixture.families) {
    const [locale, keyPath] = [
      family.inventoryKey.slice(0, family.inventoryKey.indexOf(':')),
      family.inventoryKey.slice(family.inventoryKey.indexOf(':') + 1),
    ];

    describe(family.inventoryKey, () => {
      it('gli slug della fixture stanno tutti nel locale della chiave', () => {
        for (const urlPath of family.urlPaths) {
          expect(localeOfPath(`${urlPath.replace(/^\//, '')}index.html`)).toBe(locale);
        }
      });

      it("l'insieme pieno produce l'etichetta inventariata", () => {
        expect(family.urlPaths.length).toBeGreaterThanOrEqual(2);
        expect(commonPathPrefix(family.urlPaths)).toBe(keyPath);
      });

      it("nessun sottoinsieme campionabile sposta l'etichetta", () => {
        // `AUDIT_SAMPLE_RATE` e il campionamento a 12 pagine del live-scan fanno
        // sì che un run veda un SOTTOINSIEME della famiglia. Se l'etichetta
        // dipendesse da quale, la chiave risolverebbe a run alterni — il
        // flapping che #7384 ha tolto sul lato inventario e che qui viene
        // verificato sui path veri, coppia per coppia e leave-one-out.
        for (let i = 0; i < family.urlPaths.length; i += 1) {
          for (let j = i + 1; j < family.urlPaths.length; j += 1) {
            expect(commonPathPrefix([family.urlPaths[i], family.urlPaths[j]])).toBe(keyPath);
          }
          const leaveOneOut = family.urlPaths.filter((_, idx) => idx !== i);
          expect(commonPathPrefix(leaveOneOut)).toBe(keyPath);
        }
      });

      it("l'etichetta emessa risolve alla riga d'inventario", () => {
        const resolved = resolveInventoryEntry(
          INFORMATION_GAIN_GATE.KNOWN_LOW_GAIN_COHORTS,
          `${locale}:${commonPathPrefix(family.urlPaths)}`,
        );
        expect(resolved?.key).toBe(family.inventoryKey);
      });
    });
  }
});

describe("information-gain: le chiavi di identità-template risolvono ogni etichetta osservata (issue #7382)", () => {
  // Le 37 coorti di #6975 non sono inventariabili per tronco di path: la loro
  // etichetta porta il suffisso `~`, `resolveInventoryEntry` rifiuta di
  // proposito la relazione di prefisso su quelle, e la parte prima del `~` è il
  // prefisso comune dei path CAMPIONATI, che cambia col bucket. La fixture
  // registra le etichette realmente osservate in due run diverse della stessa
  // famiglia immutata — è la prova che il tronco non basta e che lo
  // skeletonHash sì.
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/information-gain-emitted-slugs.json', import.meta.url), 'utf8'),
  ) as {
    templates: Array<{
      inventoryKey: string;
      observedMedianIgsPct: number;
      observedLabels: Array<{ run: string; label: string }>;
    }>;
  };
  const inventory = INFORMATION_GAIN_GATE.KNOWN_LOW_GAIN_COHORTS;

  it('le 37 coorti della run 33460354951 sono tutte inventariate', () => {
    expect(fixture.templates).toHaveLength(37);
  });

  for (const template of fixture.templates) {
    const hash = template.inventoryKey.slice(template.inventoryKey.indexOf('~') + 1);

    describe(template.inventoryKey, () => {
      it('registra la mediana misurata, non un valore stimato', () => {
        // Il floor non si tocca (AGENTS.md #1): la riga registra ciò che la run
        // ha misurato, e resta sotto il floor — se ci arrivasse sopra la riga
        // andrebbe tolta, non alzata.
        expect(inventory.get(template.inventoryKey)).toBe(template.observedMedianIgsPct);
        expect(template.observedMedianIgsPct).toBeLessThan(INFORMATION_GAIN_GATE.MEDIAN_IGS_FLOOR_PCT);
      });

      it('ogni etichetta osservata risolve a questa riga', () => {
        expect(template.observedLabels.length).toBeGreaterThanOrEqual(1);
        for (const { label } of template.observedLabels) {
          expect(resolveInventoryEntry(inventory, label, hash)?.key).toBe(template.inventoryKey);
        }
      });

      it('la riga resta togliibile: una misura della coorte è una misura della riga', () => {
        // L'asimmetria del ratchet (`key === label`) esiste per non togliere la
        // riga di una FAMIGLIA sulla base di una sotto-famiglia. Una chiave di
        // identità-template non è una famiglia, è una coorte: se restasse
        // soggetta a quella condizione nessuna di queste 37 righe potrebbe mai
        // uscire dall'inventario, e un inventario che può solo crescere è il
        // difetto che l'inventario esiste per non essere.
        for (const { label } of template.observedLabels) {
          expect(isFamilyWideMeasure(template.inventoryKey, label)).toBe(true);
        }
      });

      it('senza lo skeletonHash nessuna etichetta risolve — è il motivo della chiave', () => {
        // Se una di queste risolvesse anche senza lo hash, la chiave di
        // identità-template sarebbe superflua per quella coorte e il tronco
        // basterebbe. Nessuna lo fa: è la misura del difetto che #7382 chiude.
        for (const { label } of template.observedLabels) {
          expect(resolveInventoryEntry(inventory, label)).toBeNull();
        }
      });
    });
  }
});
