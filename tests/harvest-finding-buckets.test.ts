/**
 * harvest-finding-buckets — la ricognizione negata NON e' un finding.
 *
 * ## Il difetto che copre (corpus #901)
 *
 * `REVIEW.md` fa della superficie pubblicata la priorita' 1 della review e chiede
 * di promuovere a 🔴 ogni ❓ che la tocchi. Ne segue che quasi ogni review chiude
 * il verdetto con una ricognizione NEGATA — «nessun impatto su `dist/api/`, sulle
 * sitemap o sui feed» — che dice l'opposto di un difetto.
 *
 * Quella frase vive sulla riga del verdetto, che porta il glifo di severita':
 * `detectSeverity` la conta come finding confermato e la taxonomy la butta nel
 * bucket il cui vocabolario compare nell'ELENCO DELLE COSE NON TOCCATE. L'elenco
 * nomina sempre sitemap/canonical, quindi `canonical-sitemap` si gonfia a ogni PR
 * pulita e ri-escala per sempre: 10 hit su 14gg, di cui 4 dei 5 esempi citati
 * (#896, #882, #881, #879) sono esattamente questa ricognizione.
 *
 * Gli snippet qui sotto sono VERBATIM da review reali: un test su prosa inventata
 * avrebbe dimostrato solo che la regex fa quello che ho scritto io, non che chiude
 * il caso misurato.
 *
 * ## Perche' un test e non solo la regex
 *
 * Il rimedio e' cross-bucket per costruzione (la clausola sparisce PRIMA della
 * scelta del bucket), quindi la sua regressione non si vedrebbe su
 * `canonical-sitemap`: si vedrebbe su un bucket qualsiasi, mesi dopo, come
 * un'escalation che nessun fix puo' chiudere — la stessa forma di #2114
 * (`auto-ads`), #2122 (`i18n-naming`) e #4342 (`NEGATED_SEVERITY_RE`).
 *
 * Gemello del corpus: `generator/tests/harvest-finding-buckets.test.mjs` in
 * `nanakokyobashi-rgb/frontaliere-articles` (node:test), stessi casi.
 */
import { describe, it, expect } from 'vitest';
import { bucketFinding, stripNegatedImpactClauses, tallyFindings } from '../scripts/ci/harvest-agent-lessons.mjs';

// Verbatim dalle review claude delle PR citate in #901.
const RICOGNIZIONI_NEGATE: Array<[string, string]> = [
  ['#896', "Comportamento del reset invariato e pinnato esplicitamente (`resolverFlaps.github === 2` dopo un reset `silent`); nessun impatto su `dist/api/`, sulle sitemap o sui feed — `getStats()` cresce di un campo additivo. I due 🟡 non bloccano."],
  ['#882', "🔴 Important: l'allarme mette `process.exitCode = 1` nel primo step del job, e nessun articolo nuovo raggiunge `content/`, la sitemap blog e la superficie `dist/api/`."],
  ['#881', "🟡 Nit: `markedExhausted` e' per-modello, quindi il nuovo `else` non puo' saltare il ban di un id fratello. Nessun impatto su `dist/api/`, slug, sitemap o feed: il delta e' interamente nel ledger della cascata."],
  ['#879', "🔴 Nessuno dei tre viene promosso a 🔴: tutti si manifestano come un rosso rumoroso, nessuno tocca `dist/api/`, gli slug, le sitemap, i canonical o i feed RSS."],
  ['#837', "🔴 Important: una riga di misura chiude la domanda. Non escalato: il ramo tocca l'automazione delle issue di CI, non `dist/api/`, le sitemap, i feed o gli slug."],
  ['#808', "🟡 Nit: il log distingue apertura da promozione. Nulla tocca `dist/api/`, le sitemap, i feed o gli slug. I due 🟡 sono debito locale."],
];

describe('bucketFinding — la ricognizione negata non fa punteggio', () => {
  for (const [pr, line] of RICOGNIZIONI_NEGATE) {
    it(`ricognizione negata di ${pr}: la superficie NON toccata non fa punteggio su canonical-sitemap`, () => {
      expect(bucketFinding(line)).not.toBe('canonical-sitemap');
    });
  }

  it('il difetto VERO su canonical/sitemap resta contato (#878)', () => {
    const line = "`generator/scripts/create-article.mjs:L15733`: 🔴 Important: esce `/de/blog/null` in `slugs.json`, nel canonical e nella sitemap — esattamente il difetto #868 item 1.";
    expect(bucketFinding(line)).toBe('canonical-sitemap');
  });

  it('il difetto VERO sul publish delle sitemap resta contato (#766)', () => {
    const line = "🔴 Important: aggiungi a `paths:` di `publish-api.yml` gli input reali del publish (`scripts/lib/build-sitemap.mjs`), oppure il workflow di trasporto non ripubblica la sitemap.";
    expect(bucketFinding(line)).toBe('canonical-sitemap');
  });

  it("la negazione di COMPORTAMENTO non e' una ricognizione: resta un difetto", () => {
    // «non aggiorna / non emette» sono verbi di comportamento: li' la negazione E'
    // il difetto. Solo i verbi di IMPATTO/PORTATA descrivono cio' che la PR non tocca.
    expect(bucketFinding('🔴 Important: il ramo di recupero non aggiorna la sitemap dopo il rename dello slug.')).toBe('canonical-sitemap');
    expect(bucketFinding('🔴 Important: la pagina non emette il canonical quando il locale manca.')).toBe('canonical-sitemap');
  });

  it("il rimedio e' cross-bucket, non una toppa su canonical-sitemap", () => {
    expect(bucketFinding("🟡 Nit: il refactor e' neutro; nessun impatto su structured data o JSON-LD.")).not.toBe('structured-data');
    expect(bucketFinding('🟡 Nit: nulla tocca il router o `parsePath`.')).not.toBe('router-nav');
    // e il difetto vero sugli stessi bucket resta contato
    expect(bucketFinding('🔴 Important: il JSON-LD emette `baseSalary` senza valuta.')).toBe('structured-data');
  });

  it('lo strip si ferma al confine di frase: il resto della riga resta scansionabile', () => {
    const line = "🔴 Important: nessun impatto su `dist/api/` o sulle sitemap. Il JSON-LD pero' emette `baseSalary` senza valuta.";
    expect(stripNegatedImpactClauses(line)).toMatch(/baseSalary/);
    expect(bucketFinding(line)).toBe('structured-data');
  });

  it("la coda contrastiva toglie solo se stessa, non cio' che la precede", () => {
    const line = '🔴 Important: il fix tocca il canonical del locale `de`, non `dist/api/`, le sitemap o i feed.';
    const stripped = stripNegatedImpactClauses(line);
    expect(stripped).toMatch(/tocca il canonical/);
    expect(stripped).not.toMatch(/le sitemap o i feed/);
    expect(bucketFinding(line)).toBe('canonical-sitemap');
  });

  it("stripNegatedImpactClauses e' pura e tollera null/undefined", () => {
    expect(stripNegatedImpactClauses(null)).toBe('');
    expect(stripNegatedImpactClauses(undefined)).toBe('');
    const line = 'nessun impatto su `dist/api/` o sulle sitemap.';
    expect(stripNegatedImpactClauses(line)).toBe(stripNegatedImpactClauses(line));
  });

  it('end-to-end: sei PR con la sola ricognizione negata non aprono un bucket canonical-sitemap', () => {
    const prs = RICOGNIZIONI_NEGATE.map(([, line], i) => ({
      number: 900 + i,
      mergedAt: '2026-09-01T00:00:00Z',
      reviews: [{ author: { login: 'claude' }, body: `## Findings\n${line}\n` }],
    }));
    const { counts } = tallyFindings(prs);
    expect(counts['canonical-sitemap'] ?? 0).toBe(0);
  });
});

// --- Le tre imprecisioni della regex misurate dalla review di corpus#909 ---
// Tutte e tre riproducibili importando il modulo: il primo confine di frase era un
// punto NUDO, quindi bastava che la ricognizione nominasse un file perche' la
// clausola si troncasse a meta' e il resto tornasse scansionabile. La ricognizione
// nomina quasi sempre un file, quindi era il caso dominante.
describe('bucketFinding — le tre imprecisioni chiuse dalla review di corpus#909', () => {
  it("il punto dentro un code span non e' confine di frase: la ricognizione sparisce intera", () => {
    // Prima: lo strip si fermava su `articles` e lasciava «.json`, sulle sitemap o
    // sui feed» → `canonical-sitemap`. Stessa forma con qualunque estensione.
    for (const file of ['articles.json', 'meta-it.json', 'publish-api.yml', 'build-rss.mjs']) {
      const line = `🟡 Nit: nessun impatto su \`${file}\`, sulle sitemap o sui feed.`;
      expect(stripNegatedImpactClauses(line), `residuo su ${file}`).not.toMatch(/sitemap/);
      expect(bucketFinding(line), `bucket su ${file}`).not.toBe('canonical-sitemap');
    }
  });

  it("il punto SEGUITO da spazio resta confine: la frase dopo la ricognizione e' ancora scansionabile", () => {
    const line = '🔴 Important: nessun impatto su `manifest.json` o sulle sitemap. Il JSON-LD emette `baseSalary` senza valuta.';
    expect(stripNegatedImpactClauses(line)).toMatch(/baseSalary/);
    expect(bucketFinding(line)).toBe('structured-data');
  });

  it('la coda contrastiva sopravvive a un punto nel nome del file negato', () => {
    // Prima: il punto di `.mjs` spezzava il lookbehind e la coda non veniva tolta
    // affatto, quindi `slugs.json`/sitemap/feed restavano a fare punteggio.
    const line = '🟡 Nit: il fix tocca `create-article.mjs`, non `slugs.json`, le sitemap o i feed.';
    const stripped = stripNegatedImpactClauses(line);
    expect(stripped).toMatch(/create-article\.mjs/);
    expect(stripped).not.toMatch(/le sitemap o i feed/);
    expect(bucketFinding(line)).not.toBe('canonical-sitemap');
  });

  it('la negazione inglese `not` conta quanto `no impact on`', () => {
    // `IMPACT_VERB` portava gia' touch/reach/affect, ma l'elenco delle negazioni
    // aveva solo `no`: la forma piu' comune in inglese («does not touch») passava.
    expect(bucketFinding('🟡 Nit: this refactor does not touch `dist/api/`, sitemaps or feeds.')).not.toBe('canonical-sitemap');
    expect(bucketFinding('🟡 Nit: the change does not affect slugs, sitemaps or canonical URLs.')).not.toBe('canonical-sitemap');
    expect(bucketFinding('🟡 Nit: no impact on `dist/api/`, sitemaps or feeds.')).not.toBe('canonical-sitemap');
  });

  it("lo sweep incompleto NON e' una ricognizione: la negazione li' e' il difetto", () => {
    // `non toccat` e' insieme il tell della TAXONOMY `sibling-class-fix` e una
    // negazione + participio di `IMPACT_VERB`: senza il guard lo strip mangiava la
    // forma che REVIEW.md prescrive per un finding di classe. Riga verbatim da #880.
    const verbatim = '`scripts/cf-purge-cache.mjs`:L76: 🟡 Nit: stesso anti-pattern che la PR chiude altrove, non toccato — `Number(process.env.CF_PURGE_SETTLE_MS) || 20_000` copre `NaN`.';
    expect(stripNegatedImpactClauses(verbatim)).toBe(verbatim);
    expect(bucketFinding(verbatim)).toBe('sibling-class-fix');
    // e la forma senza il tell letterale della taxonomy resta almeno nella rete fingerprint
    const equivalente = "🔴 Important: il ramo equivalente in `build-rss.mjs` non e' toccato dalla PR.";
    expect(stripNegatedImpactClauses(equivalente)).toBe(equivalente);
    expect(bucketFinding(equivalente)).toBeTruthy();
  });
});

// La rete fingerprint vede il testo INTERO, quindi una riga che lo strip taglia
// male non puo' sparire dal tally. Lo strip e' un'euristica sul CONFINE della
// clausola negata: quando la negazione porta su un participio o su un verbo di
// impatto usato in senso comportamentale, mangia anche la coda — che e' il
// difetto vero. Se il safety net ricevesse il testo strippato, la riga cadrebbe
// attraverso ENTRAMBI i livelli: nessun bucket, nessun fingerprint, nessuna
// escalation, mai. E' la direzione opposta al falso positivo che questo modulo
// chiude, e la piu' pericolosa perche' invisibile.
describe('bucketFinding — un difetto mal-strippato perde al piu il bucket, mai il tally', () => {
  const MAL_STRIPPATE = [
    '🔴 Important: il redirect non raggiunge `/lavoro/ticino`, il canonical resta rotto e la sitemap perde lo slug.',
    "🔴 Important: la pagina non e' stata toccata dal fix, quindi il JSON-LD emette `baseSalary` senza valuta.",
  ];

  for (const line of MAL_STRIPPATE) {
    it(`resta contata: ${line.slice(15, 60)}…`, () => {
      // lo strip mangia la coda — e' il limite noto, non lo neghiamo
      expect(stripNegatedImpactClauses(line).length).toBeLessThan(line.length);
      // ma la riga NON sparisce: il safety net la prende sul testo intero
      expect(bucketFinding(line)).not.toBeNull();
    });
  }

  it('la ricognizione negata resta comunque fuori dai bucket topic (#901 intatto)', () => {
    // il rimedio non deve rientrare dalla finestra: una ricognizione vera non
    // torna a fare punteggio su canonical-sitemap solo perche' il safety net
    // vede il testo intero.
    for (const [, line] of RICOGNIZIONI_NEGATE) {
      expect(bucketFinding(line)).not.toBe('canonical-sitemap');
    }
    expect(bucketFinding('🟡 Nit: il diff non tocca `dist/api/`, gli slug, le sitemap o i feed.')).not.toBe('canonical-sitemap');
  });
});
