#!/usr/bin/env node
/**
 * Per ogni JOB di ogni workflow: quali foglie pesanti del checkout tocca davvero.
 *
 * PERCHE' ESISTE
 * Il checkout pieno di questo repo e' 6'829 MB / 41'707 file, ma il codice e'
 * ~198 MB. Il resto e' dato generato (`public/images` 4,4 GB, `data/jobs`
 * 702 MB, ...). Misurato sulle ultime 100 run: il passo Checkout ha mediana
 * 123s, p90 211s, max 686s — su ~200 workflow, quasi tutti dei quali lanciano
 * uno script Node che legge due file.
 *
 * La granularita' e' il JOB, non il workflow, perche' e' li' che vive il passo
 * `actions/checkout`: in `tests.yml` il job `typecheck` non legge un byte di
 * `data/`, mentre `vitest` legge tutto — trattarli insieme buttava via il primo.
 *
 * COME
 *   1. il YAML viene PARSATO (pacchetto `yaml`): i commenti spariscono per
 *      costruzione e restano solo i comandi realmente eseguiti. Serve davvero —
 *      un grep marcava 68 workflow come "usa vitest" quando la parola stava solo
 *      nei commenti, e 19 crawler per un `playwright install`;
 *   2. si seguono le composite action locali (`uses: ./.github/actions/...`);
 *   3. dagli entry point (node / npx tsx / npm run / bash) si segue la chiusura
 *      transitiva degli import locali;
 *   4. su quell'insieme si cercano i riferimenti ai bucket, in forma piena
 *      (`data/jobs/...`) e spezzata (`path.join(ROOT, 'data', 'jobs')`).
 *
 * SICUREZZA — tre proprieta', in ordine di importanza:
 *   a) Nel dubbio si resta PESANTI: un bucket incerto viene incluso. Un falso
 *      positivo costa qualche secondo, un falso negativo e' un job che muore.
 *   b) Solo le foglie sopra 15 MB sono escludibili: la coda (~198 MB) e' SEMPRE
 *      presente, quindi un file piccolo sfuggito all'analisi c'e' lo stesso. E'
 *      questa la proprieta' che rende l'operazione a basso rischio.
 *   c) Chi ENUMERA una cartella (readdir/glob/find) invece di nominare i file si
 *      prende tutti i bucket sotto quella cartella.
 *
 *   node scripts/ci/checkout-profile-analyzer.mjs [--list] [--json] [--job <id>]
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROOT = process.env.CHECKOUT_ANALYZER_ROOT || process.cwd();
const WF_DIR = path.join(ROOT, '.github/workflows');
const TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/checkout-buckets.json'), 'utf8'));
export const BUCKETS = TABLE.buckets;
export const BASELINE_MB = TABLE.baselineMb;
export const TREE_MB = TABLE.treeMb;

/**
 * Comandi che rendono l'analisi statica inaffidabile: costruiscono o testano il
 * sito intero e raggiungono l'albero per vie che nessuna analisi di import vede
 * (glob dei plugin Vite, fixture dei test, asset risolti a runtime).
 *
 * Volutamente NON sono qui:
 *  - `playwright install` — scarica un browser, non legge il repo;
 *  - `git add -A` — in uno sparse checkout i file esclusi hanno SKIP_WORKTREE e
 *    non finiscono in staging come cancellazioni. Verificato su questo repo:
 *    36'355 file esclusi → `git add -A` mette 0 cancellazioni e l'index resta
 *    completo a 41'703 path.
 */
const OPAQUE_RULES = [
  ['build', /\bnpm\s+run\s+build/], ['build', /\bvite\s+build\b/],
  ['vitest', /\bnpx\s+vitest\b/], ['vitest', /\bnpm\s+(?:run\s+)?test\b/], ['vitest', /\bvitest\s+run\b/],
  ['playwright-test', /\bplaywright\s+test\b/], ['audit', /\bnpm\s+run\s+audit/],
];

/**
 * Enumerazione di cartelle: chi la usa non nomina i file, quindi non e'
 * analizzabile per nome. Si cattura l'ARGOMENTO della chiamata, non la sola
 * presenza: `scripts/lib/git-commit-data.sh` fa 1'524 righe e contiene sia
 * `ls -` sia `public/data/jobs.json`, e la versione grossolana gli attribuiva
 * `public/images/` (4,4 GB) in 28 workflow che non lo leggono mai.
 */
const ENUMERATION_CALLS = [
  /\b(?:readdir|opendir)(?:Sync)?\s*\(([^)]{0,160})\)/g,
  /\b(?:globSync|glob|fg|fastGlob)\s*\(([^)]{0,160})\)/g,
  /\bfor\s+\w+\s+in\s+([^\n;]{0,160})/g,
  /\bfind\s+([^\n|;]{0,160})/g,
  /\bls\s+(?:-\S+\s+)*([^\n|;]{0,160})/g,
];
function enumerationTargets(text) {
  const out = [];
  for (const re of ENUMERATION_CALLS) for (const m of text.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

/**
 * Lettura con cache. I 229 job condividono le stesse librerie sotto
 * `scripts/lib/`, e senza cache la chiusura transitiva le rilegge una volta per
 * job: 9,1s contro 1,4s. Conta perche' questo modulo gira dentro la suite
 * vitest, dove ogni secondo e' pagato a ogni PR.
 */
const READ_CACHE = new Map();
const readSafe = (p) => {
  if (READ_CACHE.has(p)) return READ_CACHE.get(p);
  let v = null;
  try { v = fs.readFileSync(p, 'utf8'); } catch { v = null; }
  READ_CACHE.set(p, v);
  return v;
};
/** Anche l'esistenza di un percorso e' interrogata migliaia di volte. */
const STAT_CACHE = new Map();
const isFile = (abs) => {
  if (STAT_CACHE.has(abs)) return STAT_CACHE.get(abs);
  let v = false;
  try { v = fs.statSync(abs).isFile(); } catch { v = false; }
  STAT_CACHE.set(abs, v);
  return v;
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parentOf = (id) => { const s = id.replace(/\/$/, '').split('/'); return s.length > 1 ? s.slice(0, -1).join('/') : null; };

/**
 * Normalizza le forme spezzate in forme piene, cosi' una regex sola le copre
 * entrambe: `path.join(ROOT, 'public', 'images')` diventa `... 'public/images')`.
 * Senza, restava solo il segmento finale (`'images'`), che compare ovunque per
 * motivi scollegati e trascinava il bucket da 4,4 GB in 91 job su 204.
 */
const normalizeJoins = (t) => t.replace(/(['"])\s*,\s*(['"])/g, '/');

/** Raccoglie il testo dei comandi eseguiti dagli step dati (seguendo le action locali). */
function textOfSteps(steps, seen = new Set()) {
  const chunks = [];
  const strings = (o) => { if (o && typeof o === 'object') for (const v of Object.values(o)) if (typeof v === 'string') chunks.push(v); };
  if (!Array.isArray(steps)) return '';
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.run === 'string') chunks.push(s.run);
    strings(s.with); strings(s.env);
    if (typeof s.uses === 'string' && s.uses.startsWith('./')) {
      const rel = s.uses.replace(/^\.\//, '');
      for (const c of [path.join(ROOT, rel, 'action.yml'), path.join(ROOT, rel, 'action.yaml')]) {
        if (fs.existsSync(c) && !seen.has(c)) {
          seen.add(c);
          const raw = readSafe(c);
          try { chunks.push(textOfSteps(YAML.parse(raw, { logLevel: 'silent' })?.runs?.steps, seen)); }
          catch { chunks.push(raw ?? ''); }
          break;
        }
      }
    }
  }
  return chunks.join('\n');
}

export function checkoutEntryPoints(text, npmScripts, depth = 0) {
  const out = new Set();
  const push = (p) => { if (p && !p.startsWith('-')) out.add(p.replace(/^\.\//, '')); };
  for (const m of text.matchAll(/\b(?:node|tsx|bash|sh|python3?)\s+((?:--?\S+\s+)*)([\w./@-]+\.(?:mjs|cjs|js|ts|mts|sh|py))/g)) push(m[2]);
  for (const m of text.matchAll(/\bnpx\s+(?:-y\s+)?(?:tsx@?\S*|ts-node)\s+((?:--?\S+\s+)*)([\w./@-]+\.(?:ts|mts|mjs|js))/g)) push(m[2]);
  if (depth < 3 && npmScripts) for (const m of text.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)) {
    const b = npmScripts[m[1]];
    if (b) for (const e of checkoutEntryPoints(b, npmScripts, depth + 1)) out.add(e);
  }
  return [...out];
}

export function transitiveClosure(entries) {
  const seen = new Set(); const queue = [...entries]; const resolved = [];
  const cands = (b) => [b, b + '.mjs', b + '.js', b + '.ts', b + '.mts', b + '.cjs',
                        path.join(b, 'index.mjs'), path.join(b, 'index.ts'), path.join(b, 'index.js')];
  while (queue.length) {
    const rel = queue.shift();
    if (!rel || seen.has(rel) || rel.startsWith('..')) continue;
    seen.add(rel);
    const src = readSafe(path.join(ROOT, rel));
    if (src === null) continue;
    resolved.push({ rel, src });
    const dir = path.dirname(rel);
    const specs = new Set();
    for (const re of [/\bfrom\s+['"](\.[^'"]+)['"]/g, /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g, /\brequire\s*\(\s*['"](\.[^'"]+)['"]/g]) {
      for (const m of src.matchAll(re)) specs.add(m[1]);
    }
    for (const s of specs) {
      const base = path.normalize(path.join(dir, s));
      for (const t of cands(base)) {
        if (isFile(path.join(ROOT, t))) { queue.push(t); break; }
      }
    }
  }
  return resolved;
}

/** Un testo nomina questo bucket? Forma piena/spezzata, indizio debole, o enumerazione del padre. */
export function bucketsReferencedBy(text) {
  const norm = normalizeJoins(text);
  const rawEnum = enumerationTargets(text).join('\n');
  const enumArgs = normalizeJoins(rawEnum);
  const matches = (p, hay) => new RegExp(`['"\`(\\s=,\\[:!]${esc(p)}(?:['"\`/\\s),\\]*]|$)`, 'm').test(hay);
  // Si cerca sul testo GREZZO e su quello normalizzato, e si prende l'unione.
  // La normalizzazione serve a scoprire `path.join(ROOT, 'public', 'images')`,
  // ma applicata da sola ne perde altri: un array di percorsi come
  // `['data/', 'public/data/']` diventa `'data//public/data/'`, e il carattere
  // che precede `public/data` non e' piu' una virgoletta. Cosi' l'ha mancato
  // per `guard-data-integrity.mjs` e `validate-third-party-secrets.mjs`.
  // Regola: la normalizzazione puo' solo AGGIUNGERE match, mai toglierne.
  const refersTo = (p, hay, rawHay) => matches(p, hay) || (rawHay !== undefined && matches(p, rawHay));
  const hit = new Set();
  for (const b of BUCKETS) {
    const clean = b.id.replace(/\/$/, '');
    if (refersTo(clean, norm, text)) { hit.add(b.id); continue; }
    const par = parentOf(b.id);
    if (!par || !refersTo(par, norm, text)) continue;
    // Indizio debole: il padre e' nominato e il segmento finale compare come token
    // quotato — tipico di `una costante di cartella piu' il segmento finale`, dove la variabile nasconde
    // il prefisso.
    const last = clean.split('/').pop();
    if (new RegExp(`['"]${esc(last)}['"]`).test(text)) { hit.add(b.id); continue; }
    // Oppure: qualcuno enumera il padre, quindi non nomina i figli.
    if (refersTo(par, enumArgs, rawEnum) || new RegExp(`(?:^|[\\s'"\`(=,\\[])${esc(par)}[/*]`, 'm').test(enumArgs)) hit.add(b.id);
  }
  return hit;
}

/** Analizza un singolo job. */
function analyzeJobCheckout(jobId, job, workflowEnvText, npmScripts) {
  const exec = textOfSteps(job?.steps) + '\n' + workflowEnvText + '\n' +
    (job?.env && typeof job.env === 'object' ? Object.values(job.env).filter((v) => typeof v === 'string').join('\n') : '');
  const opaqueBy = [...new Set(OPAQUE_RULES.filter(([, r]) => r.test(exec)).map(([k]) => k))];
  const entries = checkoutEntryPoints(exec, npmScripts);
  const resolved = transitiveClosure(entries);
  const corpus = exec + '\n' + resolved.map((r) => r.src).join('\n');
  const needs = opaqueBy.length ? new Set(BUCKETS.map((b) => b.id)) : bucketsReferencedBy(corpus);
  if (needs.has('public/images/')) needs.add('public/data/');
  const exclude = BUCKETS.filter((b) => !needs.has(b.id));
  const hasCheckout = (job?.steps ?? []).some((s) => typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout@'));
  return {
    jobId, hasCheckout, opaqueBy, entries, filesFollowed: resolved.length,
    closure: resolved.map((r) => r.rel),
    needs: [...needs].sort(), exclude: exclude.map((b) => b.id),
    savedMb: exclude.reduce((a, b) => a + b.mb, 0),
    savedFiles: exclude.reduce((a, b) => a + b.files, 0),
    checkoutMb: TREE_MB - exclude.reduce((a, b) => a + b.mb, 0),
  };
}

/**
 * Memoizzazione per percorso. L'analisi di un workflow e' pura rispetto al
 * contenuto del repo, e nella suite di test viene richiesta piu' volte (dal
 * guard e dai singoli casi): senza cache la stessa passata costava 24,5s invece
 * di 8s. In un processo che gira una volta sola non cambia nulla.
 */
const ANALYSIS_CACHE = new Map();

export function analyzeWorkflow(file, npmScripts) {
  if (ANALYSIS_CACHE.has(file)) return ANALYSIS_CACHE.get(file);
  const r = analyzeWorkflowUncached(file, npmScripts);
  ANALYSIS_CACHE.set(file, r);
  return r;
}

function analyzeWorkflowUncached(file, npmScripts) {
  const raw = readSafe(file);
  let doc = null;
  try { doc = YAML.parse(raw, { logLevel: 'silent' }); } catch { /* illeggibile → nessun job, resta com'e' */ }
  const envText = doc?.env && typeof doc.env === 'object'
    ? Object.values(doc.env).filter((v) => typeof v === 'string').join('\n') : '';
  const jobs = doc?.jobs && typeof doc.jobs === 'object'
    ? Object.entries(doc.jobs).map(([id, j]) => analyzeJobCheckout(id, j, envText, npmScripts)) : [];
  return { file: path.basename(file), parsed: doc !== null, jobs };
}

export function analyzeAll() {
  const pkg = JSON.parse(readSafe(path.join(ROOT, 'package.json')) ?? '{}');
  return fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((f) => analyzeWorkflow(path.join(WF_DIR, f), pkg.scripts));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = analyzeAll();
  const jobs = all.flatMap((w) => w.jobs.filter((j) => j.hasCheckout).map((j) => ({ ...j, file: w.file })));
  const avg = jobs.reduce((a, j) => a + j.checkoutMb, 0) / jobs.length;
  console.log(`workflow: ${all.length} | job con checkout: ${jobs.length} | opachi: ${jobs.filter((j) => j.opaqueBy.length).length}`);
  console.log(`checkout medio: ${avg.toFixed(0)} MB contro ${TREE_MB} MB → -${(100 - (avg / TREE_MB) * 100).toFixed(0)}%`);
  console.log(`job al minimo (${BASELINE_MB} MB): ${jobs.filter((j) => j.exclude.length === BUCKETS.length).length}`);
  const hist = {};
  for (const j of jobs) { const k = j.checkoutMb < 300 ? 'a) <300 MB' : j.checkoutMb < 1000 ? 'b) 300MB-1GB' : j.checkoutMb < 3000 ? 'c) 1-3 GB' : 'd) >3 GB'; hist[k] = (hist[k] || 0) + 1; }
  console.log('\n=== distribuzione del checkout risultante ===');
  for (const [k, v] of Object.entries(hist).sort()) console.log(String(v).padStart(4), k);
  if (process.argv.includes('--list')) for (const j of jobs.sort((a, b) => b.checkoutMb - a.checkoutMb)) console.log(String(j.checkoutMb).padStart(5) + 'MB', (j.file + ':' + j.jobId).padEnd(56), j.opaqueBy.join(',') || '');
  if (process.argv.includes('--json')) fs.writeFileSync(process.env.OUT || '/tmp/profiles.json', JSON.stringify(all, null, 1));
}
