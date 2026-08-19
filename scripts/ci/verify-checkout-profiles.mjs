#!/usr/bin/env node
/**
 * Verifica che lo sparse-checkout scritto nei workflow sia ancora coerente col
 * codice che quei workflow eseguono.
 *
 * E' il guard che rende sostenibile l'operazione. Il rischio di uno sparse
 * checkout non e' il giorno in cui lo scrivi — e' il mese dopo, quando qualcuno
 * fa leggere `data/jobs/` a uno script che prima non lo leggeva e il job muore
 * in produzione con ENOENT. Qui quel cambiamento diventa una CI rossa.
 *
 * Controlla tre cose:
 *   1. nessun file di CODICE che il job carica finisce fra gli esclusi;
 *   2. i pattern sono ben formati (`/*` per primo, poi solo negazioni);
 *   3. le esclusioni scritte non sono piu' larghe di quelle che l'analizzatore
 *      calcola oggi — cioe' il workflow non sta escludendo qualcosa che il suo
 *      codice ha cominciato a usare.
 *
 * Il verso del confronto conta: escludere MENO del calcolato e' legittimo (una
 * scelta prudente a mano), escludere DI PIU' no.
 *
 *   node scripts/ci/verify-checkout-profiles.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { analyzeWorkflow, ROOT, BUCKETS, OVERRIDES } from './checkout-profile-analyzer.mjs';

const WF_DIR = path.join(ROOT, '.github/workflows');

/**
 * Percorsi tracciati, letti UNA volta dall'albero di HEAD.
 *
 * Serve a distinguere un percorso vero da una URL o da un esempio in un
 * commento: `${CDN}/data/blog-index.json` somiglia a un file locale e non lo e'.
 * Si legge da HEAD e non da `origin/main` perche' in CI il remote-tracking ref
 * puo' non esserci (checkout a profondita' 1).
 */
let TRACKED = null;
function trackedPaths() {
  if (TRACKED) return TRACKED;
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
    TRACKED = new Set(out.split('\n').filter(Boolean));
  } catch { TRACKED = new Set(); }
  return TRACKED;
}

/**
 * Controllo INDIPENDENTE dall'analizzatore: estrae i percorsi letterali dal
 * codice che il job carica e verifica che nessuno di quelli realmente tracciati
 * finisca fra gli esclusi.
 *
 * Vale la duplicazione proprio perche' il metodo e' diverso. Ha trovato due
 * casi che l'analisi aveva mancato — `guard-data-integrity.mjs` e
 * `validate-third-party-secrets.mjs`, entrambi con i percorsi dentro un array
 * letterale — dovuti a un difetto nella normalizzazione delle forme spezzate.
 * Un secondo controllo che riusasse la stessa logica non li avrebbe visti.
 */
const LITERAL_PATH = /['"`]((?:\.\.\/|\.\/)*(?:data|public|docs|packages)\/[A-Za-z0-9._/-]+)['"`]/g;

export function literalPathsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(LITERAL_PATH)) out.add(m[1].replace(/^(\.\.\/|\.\/)+/, ''));
  return out;
}

/** Un percorso e' fuori dal checkout, dati i pattern di negazione? */
export function isExcludedBy(excluded, p) {
  return excluded.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
}

export function verifyCheckoutProfiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const problems = [];
  let jobs = 0, withSparse = 0;

  // Le deroghe sono l'unico punto in cui una persona scavalca l'analisi. Devono
  // costare qualcosa: senza una motivazione che riporti la prova, diventano la
  // scorciatoia con cui si spegne il guard invece di capire il caso.
  const tracked = trackedPaths();
  for (const [key, ov] of Object.entries(OVERRIDES)) {
    if (!/^[\w.-]+\.ya?ml:[\w-]+$/.test(key)) problems.push(`deroga «${key}»: la chiave deve essere «<workflow>.yml:<job>»`);
    if (!Array.isArray(ov?.alsoExclude) || ov.alsoExclude.length === 0) problems.push(`deroga «${key}»: manca alsoExclude`);
    if (typeof ov?.why !== 'string' || ov.why.trim().length < 80) {
      problems.push(`deroga «${key}»: serve un campo «why» che riporti la prova, non una riga generica`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ov?.verified ?? '')) problems.push(`deroga «${key}»: serve «verified» con la data del controllo`);
    for (const p of ov?.alsoExclude ?? []) {
      const probe = p.replace(/\/$/, '');
      const exists = tracked.has(probe) || [...tracked].some((t) => t.startsWith(probe + '/'));
      if (!exists) problems.push(`deroga «${key}»: «${p}» non esiste nell'albero`);
    }
  }

  for (const f of fs.readdirSync(WF_DIR).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const full = path.join(WF_DIR, f);
    const raw = fs.readFileSync(full, 'utf8');
    let doc;
    try { doc = YAML.parse(raw, { logLevel: 'silent' }); } catch (e) { problems.push(`${f}: YAML illeggibile — ${e.message}`); continue; }
    const analysis = analyzeWorkflow(full, pkg.scripts);

    for (const job of analysis.jobs) {
      jobs++;
      const step = (doc?.jobs?.[job.jobId]?.steps ?? [])
        .find((s) => typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout@'));
      const sparse = step?.with?.['sparse-checkout'];
      if (sparse === undefined) continue;
      withSparse++;
      const where = `${f}:${job.jobId}`;

      const lines = String(sparse).split('\n').map((l) => l.trim()).filter(Boolean);
      // Gli sparse scritti a mano possono usare una allow-list (un solo file):
      // si riconoscono perche' non cominciano con `/*`, e non li si giudica qui.
      if (lines[0] !== '/*') continue;
      for (const l of lines.slice(1)) {
        if (!/^!\/[\w./-]+$/.test(l)) problems.push(`${where}: pattern malformato «${l}»`);
      }
      if (step.with['sparse-checkout-cone-mode'] !== false) {
        problems.push(`${where}: i pattern con negazione richiedono sparse-checkout-cone-mode: false`);
      }

      const excluded = lines.slice(1).map((l) => l.slice(2));
      const isPathOutsideCheckout = (p) => isExcludedBy(excluded, p);

      // 1. il codice che il job carica deve sopravvivere
      for (const rel of (job.closure ?? [])) {
        if (isPathOutsideCheckout(rel)) problems.push(`${where}: escluderebbe il codice ${rel}`);
      }

      // 2. nessun percorso letterale letto da quel codice deve finire fuori
      const tracked = trackedPaths();
      for (const rel of (job.closure ?? [])) {
        let src;
        try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
        for (const lit of literalPathsIn(src)) {
          if (!tracked.has(lit)) continue;              // URL o esempio, non un file
          if (isPathOutsideCheckout(lit)) {
            problems.push(`${where}: ${rel} legge «${lit}», che i pattern escludono. ` +
              `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
          }
        }
      }

      // 3. non escludere piu' di quanto l'analisi consenta oggi
      // Un'esclusione e' legittima se:
      //   a) e' esattamente un bucket che l'analisi dichiara non necessario;
      //   b) e' CONTENUTA in uno di quei bucket (`public/images/events` dentro
      //      `public/images/`) — togliere meno di quanto concesso e' sempre ok;
      //   c) CONTIENE solo bucket concessi (`public/` sopra `public/images/` e
      //      `public/data/`): il residuo e' materiale di baseline, ed e' una
      //      scelta esplicita di chi ha scritto il profilo a mano.
      const allowed = new Set(job.exclude);
      for (const e of excluded) {
        const inside = [...allowed].some((b) => e.startsWith(b));
        const covering = BUCKETS.some((b) => b.id.startsWith(e)) &&
          BUCKETS.filter((b) => b.id.startsWith(e)).every((b) => allowed.has(b.id));
        if (allowed.has(e) || inside || covering) continue;
        problems.push(`${where}: esclude «${e}», ma il codice del job lo usa ora. ` +
          `Rigenera con: node scripts/ci/apply-checkout-profiles.mjs`);
      }
    }
  }
  return { problems, jobs, withSparse };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, jobs, withSparse } = verifyCheckoutProfiles();
  console.log(`job esaminati: ${jobs} | con sparse-checkout: ${withSparse}`);
  if (problems.length) {
    console.error(`\n❌ ${problems.length} problemi:`);
    for (const p of problems) console.error('   ' + p);
    process.exit(1);
  }
  console.log('✅ profili di checkout coerenti col codice');
}
