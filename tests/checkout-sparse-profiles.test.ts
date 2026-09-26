/**
 * Guard sui profili di sparse-checkout dei workflow.
 *
 * Contesto. Il checkout pieno di questo repo e' ~6'829 MB / 41'707 file, ma il
 * codice e' ~198 MB: il resto e' dato generato. Misurato sulle ultime 100 run
 * prima dell'intervento, il passo Checkout aveva mediana 123s, p90 211s e
 * max 686s. I workflow ora dichiarano, job per job, quali foglie pesanti NON
 * gli servono (`scripts/ci/apply-checkout-profiles.mjs`).
 *
 * Perche' serve un test. Il rischio di uno sparse checkout non e' il giorno in
 * cui lo scrivi: e' il mese dopo, quando qualcuno fa leggere `data/jobs/` a uno
 * script che prima non lo leggeva, e il job muore in produzione con ENOENT
 * mentre la CI resta verde. Questo test trasforma quel caso in un rosso.
 *
 * Il verso del confronto conta: escludere MENO del calcolato e' legittimo (e'
 * una scelta prudente scritta a mano), escludere DI PIU' no.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  verifyCheckoutProfiles,
  literalPathsIn,
  isExcludedBy,
  importedDataOrPublicPathsIn,
  pathsOutsideSparseRules,
  uncoveredAllowListCode,
} from '../scripts/ci/verify-checkout-profiles.mjs';
import {
  BUCKETS,
  BASELINE_MB,
  TREE_MB,
  CROSSOVER_MB,
  analyzeAll,
  inlineModuleEntryPoints,
  transitiveClosure,
} from '../scripts/ci/checkout-profile-analyzer.mjs';
import {
  computeProfiledText,
  GLOBAL_TESTS_REQUIRED_SPARSE_PATHS,
  missingGlobalTestsSparsePaths,
  missingTypecheckSparsePaths,
  TYPECHECK_REQUIRED_SPARSE_PATHS,
} from '../scripts/ci/apply-checkout-profiles.mjs';

const WF_DIR = path.join(process.cwd(), '.github/workflows');
const workflowFiles = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

/**
 * L'analisi attraversa 204 workflow e segue la chiusura transitiva degli import:
 * ~6s a freddo. Il default di vitest (5s) lo farebbe fallire come se fosse un
 * difetto invece che per lentezza — lo stesso inganno gia' visto con
 * `packages-articles-confinement.test.ts`.
 */
const TIMEOUT = 60_000;

describe('profili di sparse-checkout', () => {
  it('sono coerenti col codice che i job eseguono', () => {
    const { problems } = verifyCheckoutProfiles();
    expect(problems).toEqual([]);
  }, TIMEOUT);

  it('usano la modalita non-cone: i pattern di negazione la richiedono', () => {
    const offenders: string[] = [];
    for (const f of workflowFiles) {
      const doc = YAML.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8'), { logLevel: 'silent' });
      for (const [jobId, job] of Object.entries<any>(doc?.jobs ?? {})) {
        const step = (job?.steps ?? []).find(
          (s: any) => typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout@'),
        );
        const sparse = step?.with?.['sparse-checkout'];
        if (sparse === undefined) continue;
        if (!String(sparse).includes('!/')) continue; // allow-list: la modalita' cone va bene
        if (step.with['sparse-checkout-cone-mode'] !== false) offenders.push(`${f}:${jobId}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('non escludono mai un file che il job carica come codice', () => {
    // Coperto da verifyCheckoutProfiles, ma esplicitato: e' l'invariante che, se saltasse,
    // produrrebbe un ENOENT su un import — il guasto piu' immediato.
    const { problems } = verifyCheckoutProfiles();
    expect(problems.filter((p) => p.includes('escluderebbe il codice'))).toEqual([]);
  }, TIMEOUT);

  it('estrae solo import veri verso data/public, non stringhe letterali generiche (issue #6149)', () => {
    // `tsc` risolve gli specificatori di import sul disco, non le stringhe
    // passate a `fs.readFileSync` a runtime: quelle le legge il codice quando
    // gira, non il compilatore. Falso positivo reale misurato su
    // build-plugins/*.ts prima di questo restringimento.
    expect([...importedDataOrPublicPathsIn("import x from '../../data/foo.json';")]).toEqual(['data/foo.json']);
    expect([...importedDataOrPublicPathsIn("const p = 'data/foo.json';")]).toEqual([]);
    // import multi-riga (named import lunghi)
    const multiline = "import {\n  a,\n  b,\n} from '../public/data/x.json';";
    expect([...importedDataOrPublicPathsIn(multiline)]).toEqual(['public/data/x.json']);
    // «from» isolato in prosa inglese dentro un commento non e' un import —
    // falso positivo reale osservato in build-plugins/jobsSeoPagesPlugin.ts.
    expect([...importedDataOrPublicPathsIn('// Local placeholder served from `public/images/x.svg`.')]).toEqual([]);
  });

  it('lascia sempre presente la coda leggera: i bucket sono solo foglie pesanti', () => {
    // La sicurezza dell'operazione poggia su questo: cio' che e' escludibile e'
    // un elenco chiuso di percorsi grandi e nominati. Un file piccolo che
    // l'analisi non ha visto resta nel checkout comunque.
    const table = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts/ci/checkout-buckets.json'), 'utf8'));
    expect(table.minMb).toBeGreaterThanOrEqual(10);
    for (const b of BUCKETS) expect(b.mb).toBeGreaterThanOrEqual(table.minMb);
    expect(BASELINE_MB).toBeGreaterThan(0);
    expect(BASELINE_MB).toBeLessThan(TREE_MB * 0.1);
  });

  it('il checkout sparse del typecheck porta il symlink e il target del corpus', () => {
    const source = fs.readFileSync(path.join(WF_DIR, 'tests.yml'), 'utf8');
    expect(missingTypecheckSparsePaths(source, 'tests.yml')).toEqual([]);
    expect(TYPECHECK_REQUIRED_SPARSE_PATHS).toEqual([
      '/data/blog-articles-data.ts',
      '/packages/articles/content/blog-articles-data.ts',
    ]);
  });

  it('il profilo globale materializza tutti gli input runtime del build', () => {
    const source = fs.readFileSync(path.join(WF_DIR, 'tests.yml'), 'utf8');
    expect(missingGlobalTestsSparsePaths(source, 'tests.yml')).toEqual([]);
    expect(GLOBAL_TESTS_REQUIRED_SPARSE_PATHS).toContain('/public/data/fuel-prices.json');
    expect(GLOBAL_TESTS_REQUIRED_SPARSE_PATHS).toContain('/data/swiss-articles-data.ts');
    expect(GLOBAL_TESTS_REQUIRED_SPARSE_PATHS).toContain('/packages/articles/content/seo/seo-blog-7.ts');
  });

  it('se il profilo globale perde un artefatto, il verifier lo segnala', () => {
    const source = `jobs:\n  vitest:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          sparse-checkout: |\n            /scripts/\n            /data/\n            /packages/articles/content/blog-articles-data.ts\n            /packages/articles/content/swiss-articles-data.ts\n            /packages/articles/content/blogArticleIds.ts\n            /packages/articles/content/routerBlogData.ts\n            /packages/articles/content/routerSwissData.ts\n            /packages/articles/content/blogImageCdnMirror.ts\n            /packages/articles/content/blog-meta-*.ts\n            /packages/articles/content/seo/seo-blog*.ts\n            /packages/articles/content/seo/seoMetadataType.ts\n          sparse-checkout-cone-mode: false\n`;
    const missing = missingGlobalTestsSparsePaths(source, 'synthetic.yml');
    expect(missing).toContain('synthetic.yml:vitest:/public/data/fuel-prices.json');
  });

  it('se un profilo typecheck esclude il target, --check lo segnala esplicitamente', () => {
    const source = `jobs:\n  typecheck:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          sparse-checkout: |\n            /scripts/\n            !/data/\n            !/packages/articles/content/\n      - run: npm run typecheck:gate\n`;
    expect(missingTypecheckSparsePaths(source, 'synthetic.yml')).toEqual([
      'synthetic.yml:typecheck:/data/blog-articles-data.ts',
      'synthetic.yml:typecheck:/packages/articles/content/blog-articles-data.ts',
    ]);
  });

  it('ignora un checkout secondario in una sottodirectory: tsc non gira li', () => {
    const source = `jobs:\n  typecheck:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          sparse-checkout: |\n            /data/\n            /packages/articles/content/blog-articles-data.ts\n      - run: npm run typecheck:gate\n      - uses: actions/checkout@v5\n        with:\n          path: trusted-main\n          sparse-checkout: |\n            /scripts/ci/x.mjs\n`;
    expect(missingTypecheckSparsePaths(source, 'synthetic.yml')).toEqual([]);
  });

  it('riconosce un percorso escluso — la prova che il guard puo davvero fallire', () => {
    // Il caso reale che ha fatto scattare questo controllo: `public/data/` escluso
    // mentre `scripts/ci/guard-data-integrity.mjs` lo legge.
    const excluded = ['public/images/', 'public/data/', 'data/jobs-stats-history.json'];
    expect(isExcludedBy(excluded, 'public/data/jobs.json')).toBe(true);
    expect(isExcludedBy(excluded, 'data/jobs-stats-history.json')).toBe(true);
    // e non deve sbagliare per prefisso: un file direttamente sotto data/ NON
    // sta in `data/jobs/`.
    expect(isExcludedBy(['data/jobs/'], 'data/legacy-cache.json')).toBe(false);
    expect(isExcludedBy(excluded, 'scripts/lib/x.mjs')).toBe(false);
  });

  it('rispetta una reinclusione sparse dopo una negazione', () => {
    const patterns = ['!/data/', '/data/loop-fleet/'];
    expect(isExcludedBy(patterns, 'data/other.json')).toBe(true);
    expect(isExcludedBy(patterns, 'data/loop-fleet/loop-registry.json')).toBe(false);
  });

  it('estrae i percorsi letterali anche dentro un array', () => {
    // La forma che l'analizzatore aveva mancato: due percorsi in un array
    // letterale, dove la normalizzazione delle forme spezzate li fondeva.
    const found = literalPathsIn("const DATA_PREFIXES = ['data/x.json', 'public/data/y.json'];");
    expect([...found].sort()).toEqual(['data/x.json', 'public/data/y.json']);
    expect([...literalPathsIn("readFileSync('../data/z.json')")]).toEqual(['data/z.json']);
    // una URL non e' un percorso locale: il chiamante la scarta col set dei file tracciati
    expect([...literalPathsIn('`${CDN}/data/blog-index.json`')]).toEqual([]);
  });

  it('nessun job resta sparse sopra la soglia di convenienza', () => {
    // Misurato: sopra ~1,5 GB di checkout residuo lo sparse e' piu' LENTO del
    // fetch unico, perche' `filter:blob:none` sposta i blob su una seconda
    // richiesta pigra. Un profilo li' sopra e' un difetto, non un'ottimizzazione.
    const bad: string[] = [];
    for (const wf of analyzeAll()) {
      for (const job of wf.jobs) {
        if (job.exclude.length && job.checkoutMb > CROSSOVER_MB) bad.push(`${wf.file}:${job.jobId}`);
      }
    }
    expect(bad).toEqual([]);
  }, TIMEOUT);

  it('un job opaco (build/test) non esclude nulla', () => {
    // Un job che builda o testa il sito raggiunge l'albero per vie che nessuna
    // analisi di import vede (glob dei plugin Vite, fixture). Deve restare pieno.
    const bad: string[] = [];
    for (const wf of analyzeAll()) {
      for (const job of wf.jobs) {
        if (job.opaqueBy.length && job.exclude.length) bad.push(`${wf.file}:${job.jobId}`);
      }
    }
    expect(bad).toEqual([]);
  }, TIMEOUT);

  it('il job snapshot di articles-performance-snapshot.yml include packages/articles/content/ (issue #6319 — symlink invisibile)', () => {
    // `services/seo/seo-blog-2.ts` (e i suoi fratelli) sono symlink verso
    // `packages/articles/content/seo/...`: un job che li legge non nomina mai
    // la stringa del bucket reale, quindi senza risoluzione degli alias
    // l'analyzer lo escludeva -> ENOENT a runtime sotto sparse-checkout.
    const wf = analyzeAll().find((w) => w.file === 'articles-performance-snapshot.yml');
    const job = wf?.jobs.find((j) => j.jobId === 'snapshot');
    expect(job?.needs).toContain('packages/articles/content/');
  }, TIMEOUT);

  it('nessun workflow e in ritardo su cio che l analizzatore calcolerebbe oggi (issue #6249)', () => {
    // `verifyCheckoutProfiles()` sopra vieta solo di escludere PIU' del calcolato.
    // Non basta: un workflow appena aggiunto (o una libreria che ha smesso di
    // usare una catena `npm run` indiretta) puo' restare a checkout pieno senza
    // che nulla lo segnali, perche' "pieno" e' sempre un sovrainsieme sicuro —
    // solo lento. Osservato reale su questo repo: 4 workflow del loop
    // "prospector" (#6245/#6252/#6267) non erano mai stati passati da
    // `apply-checkout-profiles.mjs` e sono rimasti senza sparse-checkout.
    // Questo test rigira il generatore su ogni workflow e pretende che il
    // risultato sia gia' quello committato: se differisce, qualcuno ha
    // aggiunto/cambiato un workflow senza rigenerare i profili, oppure
    // l'analizzatore ha imparato a vedere una catena che prima gli sfuggiva —
    // in entrambi i casi va rigenerato con
    // `node scripts/ci/apply-checkout-profiles.mjs` prima di mergiare.
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const stale: string[] = [];
    for (const f of workflowFiles) {
      const { text, before } = computeProfiledText(path.join(WF_DIR, f), pkg.scripts);
      if (text !== before) stale.push(f);
    }
    expect(
      stale,
      'profili sparse in ritardo — rigenerali con `node scripts/ci/apply-checkout-profiles.mjs` e rileggi il diff',
    ).toEqual([]);
  }, TIMEOUT);
});

/**
 * Allow-list sparse (issue di #9835). Fino al 2026-09-25 `verifyCheckoutProfiles`
 * saltava ogni sparse che non comincia con `/*` («non li si giudica qui»), e
 * l'analizzatore seguiva i symlink solo se il bersaglio era materializzato,
 * risolvendone gli import dalla cartella del LINK. #9835 e' cosi' arrivata su
 * main con un watchdog che importava `build-plugins/shared/articleSectionCore.mjs`
 * — symlink verso `packages/articles/engine/shared/` — senza il bersaglio nella
 * sua allow-list: ERR_MODULE_NOT_FOUND alla prima run (36128534394) con la CI
 * verde. Questi casi falliscono senza il fix.
 */
describe('allow-list sparse: il codice caricato deve essere materializzato', () => {
  const OLD_WATCHDOG_LIST = [
    'scripts/runtime-reliability-watch.mjs',
    'scripts/',
    'scripts/load-rc-env.mjs',
    'scripts/lib/**',
    'infra/cloudflare-worker/**',
    'build-plugins/shared/cantonResolvers.mjs',
    'build-plugins/shared/articleSectionCore.mjs',
  ];
  const WATCHDOG_ENTRIES = ['scripts/runtime-reliability-watch.mjs', 'scripts/load-rc-env.mjs', 'scripts/lib/github-issue-creator.mjs'];

  it('la chiusura contiene il symlink E il suo bersaglio', () => {
    // La verita' del link e' git, non il filesystem: il caso vale anche dove il
    // bersaglio non e' materializzato.
    const closure = transitiveClosure(['scripts/ci/cdn-chunk-graph.mjs'], { staticOnly: true }).map((r) => r.rel);
    expect(closure).toContain('build-plugins/shared/articleSectionCore.mjs');
    expect(closure).toContain('packages/articles/engine/shared/articleSectionCore.mjs');
  });

  it('boccia la allow-list del watchdog arrivata su main con #9835, e accetta quella corretta', () => {
    expect(uncoveredAllowListCode(OLD_WATCHDOG_LIST, WATCHDOG_ENTRIES, { cone: false }))
      .toEqual(['packages/articles/engine/shared/articleSectionCore.mjs']);
    const doc = YAML.parse(fs.readFileSync(path.join(WF_DIR, 'runtime-reliability-watch.yml'), 'utf8'));
    const checkout = doc.jobs.watch.steps.find((st: any) => String(st?.uses).startsWith('actions/checkout@'));
    const lines = String(checkout.with['sparse-checkout']).split('\n').map((l: string) => l.trim()).filter(Boolean);
    expect(uncoveredAllowListCode(lines, WATCHDOG_ENTRIES, { cone: false })).toEqual([]);
  }, TIMEOUT);

  it('verifica davvero le allow-list, non le salta', () => {
    // Pavimento sul numero, non uguaglianza: se lo scanner smette di
    // riconoscerle, l'insieme dei problemi resta vuoto e il guard sopra passa
    // VERDE su un repo rotto — il modo in cui questo controllo era gia' morto.
    const { allowListsVerified } = verifyCheckoutProfiles();
    expect(allowListsVerified).toBeGreaterThanOrEqual(30);
  }, TIMEOUT);

  it('decide la corrispondenza con git, sintassi non-cone e cone', () => {
    const paths = ['scripts/x.mjs', 'scripts/ci/y.mjs', 'nested/scripts/z.mjs', 'build-plugins/a.mjs', 'root.json'];
    // non-cone: `scripts/` vale a ogni profondita', una negazione ancorata toglie.
    expect(pathsOutsideSparseRules(['scripts/', '!/scripts/ci/'], paths, { cone: false }))
      .toEqual(['scripts/ci/y.mjs', 'build-plugins/a.mjs', 'root.json']);
    // cone: directory intere, i file della radice sempre inclusi.
    expect(pathsOutsideSparseRules(['scripts'], paths, { cone: true }))
      .toEqual(['nested/scripts/z.mjs', 'build-plugins/a.mjs']);
  });

  it('segue gli import statici di heredoc e `node -e`, non quelli dinamici', () => {
    const text = [
      "node --input-type=module <<'NODE'",
      "import { probeRuntime } from './scripts/runtime-reliability-watch.mjs';",
      'NODE',
      'node -e "import(\'./scripts/lazy-only.mjs\')"',
    ].join('\n');
    expect(inlineModuleEntryPoints(text)).toEqual(['scripts/runtime-reliability-watch.mjs']);
  });
});
