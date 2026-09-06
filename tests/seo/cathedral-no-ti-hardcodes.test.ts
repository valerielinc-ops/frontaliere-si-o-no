import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  "'cerca-lavoro-ticino'",
  '"cerca-lavoro-ticino"',
  "'find-jobs-ticino'",
  "'jobs-im-tessin'",
  "'trouver-emploi-tessin'",
];

// ── Forme derivate del literal TI (#7674) ───────────────────────────────────
// FORBIDDEN sopra e' una lista di stringhe fisse **con gli apici gia' dentro**,
// passate a `grep -F`: intercetta `'cerca-lavoro-ticino'` e `"..."` e nient'altro.
// Ma la tabella che il codice copia a mano non e' solo SECTION_LEGACY_TI: e'
// anche SECTION_LEGACY_TI_PATH, che emette `/cerca-lavoro-ticino/` — con gli
// slash. Una copia scritta in quella forma non produceva nessun match e restava
// invisibile al guardiano, che quindi non poteva sostenere la claim «una
// venticinquesima copia non puo' comparire in silenzio».
//
// Qui il segmento e' matchato indipendentemente dalla delimitazione e da cio'
// che lo SEGUE, dentro un literal di CODICE: stringa (`'x'`, `"x"`, `'/x'`,
// `'x/'`, `'/x/'`) o regex (`/\/x\//`), incluse le forme con sub-path
// (`'/x/aziende/'`, `'/x/ultimi-3-giorni/'`) — href di nav, tabelle per-locale
// e mappe di redirect, cioe' proprio la classe funnel-critical che il gate
// esiste per fermare. Restano fuori per scelta le citazioni in PROSA — docblock con
// backtick, commenti, copy editoriale — dove il literal e' la URL pubblica
// citata, non una ri-dichiarazione della tabella: includerle porterebbe ~20
// offender di sola documentazione e trasformerebbe il gate in rumore.
const TI_SECTION_SLUGS = [
  'cerca-lavoro-ticino',
  'find-jobs-ticino',
  'jobs-im-tessin',
  'trouver-emploi-tessin',
];

/**
 * ERE (valida sia per `grep -E` sia per `new RegExp`) che riconosce lo slug come
 * segmento intero dentro un literal di codice, con o senza slash delimitanti.
 *
 * L'alternativa 1 chiude su quote **o** slash: chiudere sulla sola quote
 * (`/?${slug}/?['"]`) vedeva il segmento solo quando era l'INTERO literal e
 * lasciava passare in silenzio ogni literal con sub-path. Lo slash finale non
 * apre la prosa: la quote iniziale resta obbligatoria.
 */
export function tiSegmentPattern(slug: string): string {
  return `['"]/?${slug}(['"]|/)|\\\\/${slug}\\\\/`;
}

// ── Inventario congelato (ratchet, NON un esonero) ──────────────────────────
// Le forme con slash non erano vigilate: al momento in cui lo diventano il
// codice ne contiene 102 in 42 file, dai piu' innocui (un href al hub IT dentro
// copy italiano) alle vere ri-dichiarazioni della tabella per-locale
// (`services/analyticsPageContext.ts`, `scripts/lib/seo-ctr-curve.mjs`,
// `infra/cloudflare-worker/locale-router.js`) e alle forme con sub-path
// (`build-plugins/shared/relatedLinks.ts`, `build-plugins/legacyRedirectsPlugin.ts`).
// Ripararle tutte non sta in una PR chirurgica; lasciarle non vigilate era il
// difetto.
//
// Questo NON e' l'ALLOWLIST (che esonera per sempre) ne' il marker inline
// (che esonera una riga con una ragione). E' un conteggio per file che puo'
// solo SCENDERE: il test fallisce sia se un file supera il suo numero (un
// hardcode NUOVO), sia se sta sotto (inventario stantio → si abbassa il
// numero). Cosi' l'inventario converge a zero invece di marcire.
const SEGMENT_BASELINE: Record<string, number> = {
  'build-plugins/blogContextualLinksData.ts': 4,
  'build-plugins/careerLandingsPlugin.ts': 2,
  'build-plugins/cityJobsHub.ts': 1,
  'build-plugins/editorialContent.ts': 2,
  'build-plugins/exchangeRatePagesPlugin.ts': 1,
  'build-plugins/frontalierePillarCopy.ts': 2,
  'build-plugins/jobSectorLanding.ts': 1,
  'build-plugins/jobsSeoPagesPlugin.ts': 4,
  'build-plugins/legacyRedirectsPlugin.ts': 7,
  'build-plugins/nursingLandingsPlugin.ts': 1,
  'build-plugins/pdfWhitepapersPlugin.ts': 1,
  'build-plugins/professionLandingsPlugin.ts': 1,
  'build-plugins/publisherAdPagesPlugin.ts': 1,
  'build-plugins/searchConsoleCompat.ts': 4,
  'build-plugins/selfCertificationFormsPlugin.ts': 1,
  'build-plugins/seoHubsData.ts': 3,
  'build-plugins/seoHubsPlugin.ts': 1,
  'build-plugins/shared/relatedLinks.ts': 2,
  'build-plugins/staticPagesPlugin.ts': 14,
  'components/shared/RelatedTools.tsx': 1,
  'components/tabs/CalcolatoreTabContent.tsx': 2,
  'functions/src/lib/newsletterUrlPaths.js': 2,
  'infra/cloudflare-worker/locale-router.js': 1,
  'scripts/adsense-format-ab-report.mjs': 1,
  'scripts/analytics-report.mjs': 2,
  'scripts/audit-cls-live.mjs': 2,
  'scripts/audit-cls-stripping.mjs': 1,
  'scripts/build-legacy-aliases.mjs': 1,
  'scripts/cwv-monitor-check.mjs': 1,
  'scripts/lib/fixture-data-filter.mjs': 1,
  'scripts/lib/seo-ctr-curve.mjs': 4,
  'scripts/monitor-cls-posthog.mjs': 4,
  'scripts/monitor-sector-coverage.mjs': 1,
  'scripts/newsletter-template.mjs': 3,
  'scripts/reconcile-job-slugs.mjs': 1,
  'scripts/refresh-noslash-keep.mjs': 1,
  'scripts/seo-audit-employer-slugs.mjs': 6,
  'scripts/validate-spa-render.mjs': 4,
  'scripts/verify-post-deploy-seo.mjs': 4,
  'services/analyticsPageContext.ts': 4,
  'services/seo/seo-pages.ts': 1,
  'services/seoService.ts': 1,
};

// Allowlist — any line that legitimately references a TI legacy section
// literal. Every TI hardcode below has been audited as either (a) a
// fallback default in a per-plugin SECTION_SLUG table, or (b) a TI-only
// data structure (router slugs, section→label maps, hub-chrome) where
// the literal IS the canonical name for TI.
//
// IMPORTANT: never add a NEW entry here without first confirming the
// hardcode is correct legacy preservation. New canton-aware code should
// import resolveCantonSection() from build-plugins/shared/cantonSection.
const ALLOWLIST = [
  // Issue #7491: le voci pinnate `path:riga` erano ~45 e sono state cancellate
  // tutte. Dopo il collasso su `SECTION_LEGACY_TI` ogni occorrenza rimasta
  // dentro SCAN_DIRS porta un marker ` // cathedral-allow: <ragione>` inline, e
  // le righe pinnate non contenevano piu' il literal: era una lista morta i cui
  // commenti di riancoraggio storico («Lines shifted +1 …») descrivevano righe
  // che non esistono piu'. Il meccanismo inline e' l'unico, come il messaggio
  // d'errore di questo file dichiara da sempre.
  //
  // NON reintrodurre voci pinnate per numero di riga: si sfasano al primo
  // refactor e allora allowlistano la riga sbagliata.
  // L'unica voce per FILE che resta: il solo posto dove il marker inline non
  // e' materialmente esprimibile.
  //
  // section-shard-slugs.json: JSON non ammette commenti, quindi un marker
  // inline non e' esprimibile. Qui il literal E' il dato canonico del
  // meccanismo di shard per sezione, non un hardcode che scappa.
  'scripts/lib/section-shard-slugs.json',
  // I test citano i literal per verificarli.
  'tests/',
];
// Issue #7675: una voce SENZA `/` finale e' un FILE e vale per quel path
// esatto. Prima era un `startsWith` indiscriminato, che esonerava (a) l'intero
// file — un hardcode nuovo aggiunto li' fuori dai docblock passava muto — e
// (b) qualunque path che cominciasse con quella stringa, quindi anche
// `cantonSection.ts.bak`, `.orig`, `.new`. La voce per cartella (con `/`
// finale, es. `tests/`) resta invece un prefisso, che e' cio' che significa.
// `build-plugins/shared/cantonSection.ts` e' uscito da qui: i suoi due
// docblock che citano i literal portano ora il marker inline.

// ── Scan surface ────────────────────────────────────────────────────────────
// Issue #7491: this guard used to grep only build-plugins/, services/ and
// scripts/lib/. That was the whole defect. The TI section table had been
// re-declared in 53 source files (78 declarations) and the guard could see
// barely half of them, because the other half sat in scripts/ proper, in
// components/, in App.tsx, in the Cloud Functions tree and in the Worker —
// all outside those three directories. Every copy that grew, grew here.
//
// Adding a directory to this list is how the guard keeps up with the repo.
// packages/articles/content/ is deliberately absent: it is generated article
// prose that legitimately quotes TI job-board URLs by the hundred, and
// dist/ + node_modules/ are build output.
const SCAN_DIRS = [
  'App.tsx',
  'build-plugins/',
  'components/',
  'functions/src/',
  'hooks/',
  'infra/',
  'scripts/',
  'server/',
  'services/',
];

// P1-E fix: parse grep output into (path, line, content) tuples and
// match against allowlist with EXACT boundary, not startsWith — otherwise
// `:772` matches `:7720`, `:7721`, …
function parseGrepLine(line: string): { path: string; lineNo: number; content: string } | null {
  const m = line.match(/^([^:]+):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], lineNo: parseInt(m[2], 10), content: m[3] };
}

// Inline-annotation marker (2026-05-18, definitive fix). Any line whose
// content carries this marker is auto-skipped by the audit — the marker
// travels WITH the code as it shifts, so the test never breaks on a
// harmless line-number drift in an unrelated PR.
//
// Usage in source: append ` // cathedral-allow: <one-line reason>` to the
// line. The marker is checked CASE-SENSITIVELY and must appear in the
// content (after the `path:line:` prefix grep emits).
//
// The ALLOWLIST array above is preserved as a transitional safety net for
// lines that have not yet been migrated to inline annotations. New
// hardcodes MUST use the inline marker — do NOT add new entries to
// ALLOWLIST.
const INLINE_ALLOW_MARKER = /\bcathedral-allow\b/;

function hasInlineAllow(content: string): boolean {
  return INLINE_ALLOW_MARKER.test(content);
}

export function isAllowlisted(entry: { path: string; lineNo: number; content: string }): boolean {
  // 1) Inline annotation — travels with the line, never drifts.
  if (hasInlineAllow(entry.content)) return true;
  // 2) Legacy line-pinned allowlist — kept as transitional safety net.
  for (const allow of ALLOWLIST) {
    // "path:line" form — exact match
    if (allow.includes(':')) {
      const [allowPath, allowLine] = allow.split(':');
      if (entry.path === allowPath && entry.lineNo === parseInt(allowLine, 10)) return true;
    }
    // "path/" form — DIRECTORY, prefix match on path only (e.g. "tests/")
    else if (allow.endsWith('/')) {
      if (entry.path.startsWith(allow)) return true;
    }
    // "path" form — FILE, exact match. Mai `startsWith`: esonererebbe anche
    // `<path>.bak`, `<path>.orig`, `<path>.new` (issue #7675).
    else if (entry.path === allow) return true;
  }
  return false;
}

describe('cathedral — no TI URL hardcodes outside allowlist (P1-E boundary-safe)', () => {
  for (const literal of FORBIDDEN) {
    // Explicit timeout (vs the 15000ms project default, vitest.config.ts) —
    // this shells out to `grep -rn` synchronously over SCAN_DIRS; under CI's
    // parallel test-worker contention that occasionally exceeds 15s even
    // though the command itself runs in well under 1s in isolation (run
    // 29904198494/job 88871620100 timed out here with no real hardcode
    // offender — a CI-load timeout, not a genuine failure).
    it(`literal ${literal} appears only in allowlisted locations`, () => {
      const cmd = `grep -rn -F ${JSON.stringify(literal)} ${SCAN_DIRS.join(' ')} || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      const offenders = out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)
        .filter((entry) => !isAllowlisted(entry))
        .map((e) => `${e.path}:${e.lineNo}: ${e.content}`);
      expect(offenders, `Unallowlisted hardcodes for ${literal}:\n${offenders.join('\n')}\n\nTo allowlist a NEW hardcode, append \` // cathedral-allow: <reason>\` to the offending line — do not add new line-pinned entries to ALLOWLIST.`).toEqual([]);
    }, 30000);
  }
});

// Issue #7675 — semantica delle voci di ALLOWLIST. Una voce-FILE vale per il
// path esatto; solo una voce-CARTELLA (con `/` finale) esonera per prefisso.
describe('isAllowlisted — voce-file esatta vs voce-cartella per prefisso', () => {
  const at = (path: string) => ({ path, lineNo: 1, content: "  it: 'cerca-lavoro-ticino'," });

  it('esonera il path esatto di una voce-file', () => {
    expect(isAllowlisted(at('scripts/lib/section-shard-slugs.json'))).toBe(true);
  });

  it('NON esonera un path che ha la voce-file come semplice prefisso', () => {
    expect(isAllowlisted(at('scripts/lib/section-shard-slugs.json.bak'))).toBe(false);
    expect(isAllowlisted(at('build-plugins/shared/cantonSection.ts.bak'))).toBe(false);
  });

  it('NON esonera piu\' cantonSection.ts, migrato al marker inline', () => {
    expect(isAllowlisted(at('build-plugins/shared/cantonSection.ts'))).toBe(false);
  });

  it('la voce-cartella resta un prefisso', () => {
    expect(isAllowlisted(at('tests/seo/foo.test.ts'))).toBe(true);
  });

  it('il marker inline resta prioritario su qualunque path', () => {
    expect(isAllowlisted({
      path: 'build-plugins/shared/cantonSection.ts.bak',
      lineNo: 1,
      content: "  it: 'cerca-lavoro-ticino', // cathedral-allow: ragione",
    })).toBe(true);
  });
});

describe('cathedral — forme derivate del literal TI (slash-delimited, #7674)', () => {
  // OSSERVATORE: il matcher e' verificato in memoria sulle forme che deve
  // riconoscere, cosi' una futura restrizione del pattern rompe QUESTO test
  // invece di rendere il gate cieco in silenzio (che e' esattamente com'e'
  // nato il difetto: FORBIDDEN restava verde perche' non matchava nulla).
  it('riconosce ogni delimitazione del segmento, non solo il nudo fra apici', () => {
    const rx = new RegExp(tiSegmentPattern('cerca-lavoro-ticino'));
    const recognised = [
      `const s = 'cerca-lavoro-ticino';`,
      `const s = "cerca-lavoro-ticino";`,
      `const s = '/cerca-lavoro-ticino';`,
      `const s = 'cerca-lavoro-ticino/';`,
      `const s = '/cerca-lavoro-ticino/';`,
      `const s = "/cerca-lavoro-ticino/";`,
      `const re = /\\/cerca-lavoro-ticino\\/([^/]+)$/;`,
      // Sub-path: href di nav, tabelle per-locale, mappe di redirect.
      `{ href: '/cerca-lavoro-ticino/aziende/', label: 'Aziende Ticino' },`,
      `  it: '/cerca-lavoro-ticino/ultimi-3-giorni/',`,
      `  '/cerca-lavoro-ticino/logistiker-in-efz-coop-grigioni/': '/cerca-lavoro-ticino/operatore-logistico-in-afc-coop-grigioni/',`,
    ];
    expect(recognised.filter((line) => !rx.test(line))).toEqual([]);

    // La forma con slash e' proprio quella che il vecchio FORBIDDEN (stringhe
    // fisse con gli apici dentro, grep -F) NON vedeva: se questa asserzione
    // cade, il difetto #7674 e' stato riparato altrove e questo blocco puo'
    // essere semplificato.
    const slashForm = `const s = '/cerca-lavoro-ticino/';`;
    expect(FORBIDDEN.filter((literal) => slashForm.includes(literal))).toEqual([]);

    // Fuori per scelta: la citazione in prosa/docblock della URL pubblica.
    expect(rx.test(' * canonical → section landing (`/cerca-lavoro-ticino/`)')).toBe(false);
    // E niente match parziale su uno slug piu' lungo che contiene il segmento.
    expect(rx.test(`const s = '/cerca-lavoro-ticino-nord/';`)).toBe(false);
  });

  it('nessun hardcode con slash oltre l\'inventario congelato', () => {
    const counts: Record<string, number> = {};
    const samples: Record<string, string[]> = {};
    for (const slug of TI_SECTION_SLUGS) {
      const cmd = `grep -rnE ${JSON.stringify(tiSegmentPattern(slug))} ${SCAN_DIRS.join(' ')} || true`;
      const out = execSync(cmd, { encoding: 'utf8' });
      for (const entry of out.split('\n').filter(Boolean)
        .map(parseGrepLine).filter((e): e is NonNullable<typeof e> => e !== null)) {
        if (isAllowlisted(entry)) continue;
        counts[entry.path] = (counts[entry.path] ?? 0) + 1;
        (samples[entry.path] ??= []).push(`${entry.path}:${entry.lineNo}: ${entry.content.trim().slice(0, 120)}`);
      }
    }

    const grown = Object.keys(counts)
      .filter((path) => counts[path] > (SEGMENT_BASELINE[path] ?? 0))
      .map((path) => `${path}: ${counts[path]} > ${SEGMENT_BASELINE[path] ?? 0}\n${samples[path].join('\n')}`);
    expect(grown, `Nuovi hardcode TI in forma con slash. Usa SECTION_LEGACY_TI_PATH da build-plugins/shared/cantonSection (o resolveCantonSection per codice canton-aware); se la riga e' legittima, appendi \` // cathedral-allow: <ragione>\`. NON alzare i numeri di SEGMENT_BASELINE:\n${grown.join('\n')}`).toEqual([]);

    const stale = Object.keys(SEGMENT_BASELINE)
      .filter((path) => (counts[path] ?? 0) < SEGMENT_BASELINE[path])
      .map((path) => `${path}: ${counts[path] ?? 0} < ${SEGMENT_BASELINE[path]}`);
    expect(stale, `Inventario stantio: questi file hanno meno hardcode del baseline. Abbassa i numeri in SEGMENT_BASELINE (o togli la voce a 0) — il ratchet esiste per convergere a zero:\n${stale.join('\n')}`).toEqual([]);
  }, 30000);
});

