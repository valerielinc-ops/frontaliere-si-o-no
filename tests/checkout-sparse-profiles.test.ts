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
import { verifyCheckoutProfiles, literalPathsIn, isExcludedBy } from '../scripts/ci/verify-checkout-profiles.mjs';
import { BUCKETS, BASELINE_MB, TREE_MB, analyzeAll } from '../scripts/ci/checkout-profile-analyzer.mjs';

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

  it('riconosce un percorso escluso — la prova che il guard puo davvero fallire', () => {
    // Il caso reale che ha fatto scattare questo controllo: `public/data/` escluso
    // mentre `scripts/ci/guard-data-integrity.mjs` lo legge.
    const excluded = ['public/images/', 'public/data/', 'data/jobs-stats-history.json'];
    expect(isExcludedBy(excluded, 'public/data/jobs.json')).toBe(true);
    expect(isExcludedBy(excluded, 'data/jobs-stats-history.json')).toBe(true);
    // e non deve sbagliare per prefisso: `data/jobs-ai-cache.json` NON sta in `data/jobs/`
    expect(isExcludedBy(['data/jobs/'], 'data/jobs-ai-cache.json')).toBe(false);
    expect(isExcludedBy(excluded, 'scripts/lib/x.mjs')).toBe(false);
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
});
