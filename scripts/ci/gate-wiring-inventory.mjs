#!/usr/bin/env node
/**
 * gate-wiring-inventory.mjs — quali cancelli sono AGGANCIATI a qualcosa che gira.
 *
 * ─── Perché esiste ───────────────────────────────────────────────────────
 *
 * Un cancello vive in due metà: il file che decide, e il punto che lo INVOCA.
 * La seconda metà non ha forma di import — è una riga `run:` in un workflow, un
 * nome di script npm, un `case` in un registry bash — quindi nessun guard che
 * segue gli import la vede. Un cancello scritto bene ma mai agganciato passa la
 * CI verde per mesi mentre sembra protezione: è la stessa forma di
 * `SiteShellContract` e di `tests/failure-issue-closers.test.ts`, un contratto
 * verificabile solo staticamente perché a runtime nessuno lo attraversa.
 *
 * Il difetto è misurato, non ipotizzato. Al momento in cui questo file è nato:
 *   - 23 file sotto `scripts/**` con un nome che dichiara un cancello
 *     (`audit-`, `validate-`, `-audit`, `verify-`, …) non erano nominati da
 *     nessun workflow, nessuno script npm raggiungibile, nessun altro file
 *     vivo. Sei di loro — l'intero Workstream D sotto `scripts/seo/` — dal
 *     primo commit del repo, mai toccati da allora.
 *   - un numero citato in una issue («19 pagine su 22 senza meta description»)
 *     era il residuo di un run manuale mai rimisurato: rimisurato, era zero.
 *   - 9 file di test si spengono su un interruttore d'ambiente che nessun
 *     workflow e nessuno script npm imposta: girano sempre, e sempre `skip`.
 *
 * ─── Le due domande, e come si rispondono ────────────────────────────────
 *
 *   B. Un FILE che si dichiara cancello è nominato da qualcosa che a sua volta
 *      gira? La transitività conta: nominato solo da un altro orfano, è orfano.
 *      È esattamente il caso che un grep ingenuo manca.
 *   C. Un interruttore d'ambiente che SPEGNE un test è acceso da qualche parte?
 *      Se no, il test è verde perché non asserisce niente.
 *
 * (Una terza domanda — «questo script npm lo chiama qualcuno?» — è stata
 * provata e scartata: gli alias npm legacy di audit poi migrati dentro
 * `audit:all` risultano senza chiamante pur essendo il file agganciato, e il
 * segnale era per tre quarti rumore.)
 *
 * ─── Trappola di auto-riferimento, da conoscere prima di editare ─────────
 *
 * Questo modulo è raggiungibile (lo importa il suo test). Se il suo testo
 * nominasse un file orfano CON l'estensione, la chiusura transitiva lo
 * marcherebbe agganciato e l'inventario si svuoterebbe da solo. Per questo
 * `SELF_EXCLUDE` toglie dai portatori questo file e il suo test, e in questo
 * commento i file si citano senza estensione. Non è pedanteria: è il gate che
 * altrimenti si assolve da sé.
 *
 * ─── Cosa NON vede (dichiarato, non nascosto) ────────────────────────────
 *
 * - Raggiungibilità TESTUALE, non semantica: basta che il basename compaia in
 *   un file raggiungibile, anche dentro un commento. È deliberato —
 *   sovrastimare l'aggancio lascia un buco noto, sottostimarlo produce falsi
 *   allarmi, e un falso allarme fa disattivare il gate entro una settimana.
 * - Non prova che l'invocazione VENGA ESEGUITA: un `if:` sempre falso, un job
 *   mai schedulato, uno step dietro `continue-on-error` risultano agganciati.
 * - Solo `scripts/**` per la domanda B, e solo il NOME come dichiarazione (più
 *   la registrazione sotto uno script npm del namespace dei cancelli). Un
 *   cancello con un nome neutro e nessuno script npm — `find-thin-pages` è
 *   l'esempio noto — non viene chiesto.
 * - I file omonimi in cartelle diverse si risolvono al path completo quando il
 *   riferimento lo contiene, altrimenti contano tutti: sovrastima, di nuovo.
 *
 * ─── Uso ─────────────────────────────────────────────────────────────────
 *
 *   node scripts/ci/gate-wiring-inventory.mjs           # riepilogo
 *   node scripts/ci/gate-wiring-inventory.mjs --json    # per un altro script
 *
 * Sempre exit 0: è un inventario, non un gate. Il gate è il test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Estensioni che possono contenere un'invocazione. */
const CARRIER_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.sh', '.yml', '.yaml']);
/** Le cartelle da cui leggiamo sia i portatori sia i candidati. */
const SCAN_DIRS = ['scripts', 'tests', 'build-plugins', '.github', '.githooks'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__snapshots__', 'content']);
/** Vedi «Trappola di auto-riferimento» sopra. */
const SELF_EXCLUDE = new Set(['scripts/ci/gate-wiring-inventory.mjs', 'tests/gate-wiring.test.ts']);

/** Il namespace npm dei cancelli: registrarsi qui è dichiararsi cancello. */
export const GATE_NS_RE = /^(audit|validate|lint|gate|check):/;
/** Un nome di file che DICHIARA di essere un cancello. */
export const GATE_NAME_RE =
  /^(audit|validate|check|assert|guard|verify|lint|enforce|gate)[-_.]|[-_](audit|guard|gate|check|validate|verify)\.[cm]?[jt]sx?$/i;
/** Il marker che esonera uno strumento manuale (bonifica, diagnostica, seed). */
export const MANUAL_MARKER = '@manual-tool';

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
};

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, out);
    } else if (CARRIER_EXT.has(path.extname(e.name)) && !SELF_EXCLUDE.has(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** Tutti i file che possono nominare un cancello, path relativi alla root. */
export function listCarriers(root = REPO_ROOT) {
  const out = [];
  for (const d of SCAN_DIRS) walk(root, d, out);
  return out.sort();
}

/** Token che assomigliano a un nome di file eseguibile. */
const TOKEN_RE = /[\w.@/-]*[\w-]+\.(?:mjs|cjs|js|ts|tsx|sh)\b/g;
/** `npm run <nome>` in tutte le sue forme, più il `npm test` implicito. */
const NPM_RUN_RE =
  /(?:npm|pnpm|yarn)(?:\s+--\S+)*\s+(?:run(?:-script)?\s+(?:--\s+)?([\w:.@/-]+)|(test)\b)/g;

const CACHE = new Map();

/**
 * Chiusura transitiva: parte dai punti che GIRANO davvero e segue i nomi.
 *
 * Semi: i workflow, le composite action, gli hook git, e i test vitest — un
 * cancello esercitato dal proprio unit test È gated, il rosso arriva da lì.
 * Gli script npm entrano solo quando un nodo già raggiunto fa `npm run <nome>`:
 * è ciò che rende orfano uno script npm definito e mai chiamato.
 */
export function wiredFiles(root = REPO_ROOT) {
  const hit = CACHE.get(root);
  if (hit) return hit;

  const carriers = listCarriers(root);
  const text = new Map();
  for (const f of carriers) text.set(f, read(path.join(root, f)));

  const byBase = new Map();
  for (const f of carriers) {
    const b = path.basename(f);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }

  let pkg = {};
  try {
    pkg = JSON.parse(read(path.join(root, 'package.json'))).scripts ?? {};
  } catch {
    /* package.json illeggibile: nessuno script npm da seguire */
  }

  const seeds = carriers.filter(
    (f) =>
      f.startsWith('.github/workflows/') ||
      f.startsWith('.github/actions/') ||
      f.startsWith('.githooks/') ||
      (f.startsWith('tests/') && /\.(test|spec)\.[cm]?tsx?$/.test(f)),
  );

  const reached = new Set(seeds);
  const npmReached = new Set();
  const queue = [...seeds];

  while (queue.length) {
    const node = queue.pop();
    const t = node.startsWith('npm:') ? (pkg[node.slice(4)] ?? '') : (text.get(node) ?? '');
    for (const m of t.matchAll(TOKEN_RE)) {
      const cands = byBase.get(path.basename(m[0]));
      if (!cands) continue;
      const norm = m[0].replace(/^\.\/+/, '');
      const exact = cands.filter((c) => c === norm || c.endsWith(`/${norm}`));
      for (const c of exact.length ? exact : cands) {
        if (!reached.has(c)) {
          reached.add(c);
          queue.push(c);
        }
      }
    }
    for (const m of t.matchAll(NPM_RUN_RE)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      for (const n of [name, `pre${name}`, `post${name}`]) {
        if (n in pkg && !npmReached.has(n)) {
          npmReached.add(n);
          reached.add(`npm:${n}`);
          queue.push(`npm:${n}`);
        }
      }
    }
  }

  const out = { reached, npmReached, carriers, text, pkg };
  CACHE.set(root, out);
  return out;
}

/** I file che il repo tratta come cancelli, agganciati o no. */
export function declaredGates(root = REPO_ROOT) {
  const { carriers, text, pkg } = wiredFiles(root);
  const byNpm = new Map();
  for (const [name, body] of Object.entries(pkg)) {
    if (!GATE_NS_RE.test(name)) continue;
    for (const m of String(body).matchAll(/scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh)\b/g)) {
      if (!byNpm.has(m[0])) byNpm.set(m[0], []);
      byNpm.get(m[0]).push(name);
    }
  }
  return carriers
    .filter((f) => f.startsWith('scripts/'))
    .filter((f) => GATE_NAME_RE.test(path.basename(f)) || byNpm.has(f))
    .map((f) => ({
      file: f,
      npmScripts: byNpm.get(f) ?? [],
      manual: (text.get(f) ?? '').includes(MANUAL_MARKER),
    }));
}

/** B — i cancelli che niente di vivo nomina. */
export function orphanGateFiles(root = REPO_ROOT) {
  const { reached } = wiredFiles(root);
  return declaredGates(root)
    .filter((g) => !g.manual && !reached.has(g.file))
    .map((g) => g.file)
    .sort();
}

/**
 * C — gli interruttori che SPENGONO un test e che nessuno accende.
 *
 * Solo la polarità «assente ⇒ spento»: `X !== '1'`, `skipIf(!X)`. La polarità
 * opposta (`X === '1'` ⇒ skip) è un opt-OUT, e assente significa che il test
 * gira: segnalarla sarebbe un falso allarme.
 */
const SKIP_SWITCH_RE =
  /process\.env\.([A-Z][A-Z0-9_]{2,})\s*!==\s*['"][^'"]*['"]|(?:skipIf|runIf)\(\s*!\s*(?:process\.env\.)?([A-Z][A-Z0-9_]{2,})\b/g;

export function unsetTestSwitches(root = REPO_ROOT) {
  const { carriers, text, pkg } = wiredFiles(root);
  const setters = [
    ...carriers
      .filter((f) => f.startsWith('.github/') || f.startsWith('.githooks/'))
      .map((f) => text.get(f) ?? ''),
    JSON.stringify(pkg),
  ].join('\n');
  const found = new Map();
  for (const f of carriers) {
    if (!f.startsWith('tests/')) continue;
    const t = text.get(f) ?? '';
    for (const m of t.matchAll(SKIP_SWITCH_RE)) {
      const name = m[1] ?? m[2];
      if (!name || new RegExp(`\\b${name}\\b`).test(setters)) continue;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(f);
    }
  }
  return [...found.entries()]
    .map(([env, files]) => ({ env, files: [...files].sort() }))
    .sort((a, b) => a.env.localeCompare(b.env));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = {
    declaredGates: declaredGates().length,
    orphanGateFiles: orphanGateFiles(),
    unsetTestSwitches: unsetTestSwitches(),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`cancelli dichiarati sotto scripts/: ${report.declaredGates}`);
    console.log(`B. cancelli mai nominati da niente di vivo: ${report.orphanGateFiles.length}`);
    for (const f of report.orphanGateFiles) console.log(`   ${f}`);
    console.log(`C. interruttori di test mai accesi: ${report.unsetTestSwitches.length}`);
    for (const s of report.unsetTestSwitches) {
      console.log(`   ${s.env} → ${s.files.length} file di test sempre in skip`);
      for (const f of s.files) console.log(`      ${f}`);
    }
  }
}
