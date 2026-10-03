#!/usr/bin/env node

/**
 * Pin del watchdog translate nel trasporto dei workflow crawler.
 *
 * Il corpus tiene un pin di sicurezza sul workflow di traduzione generato dal
 * sito: `TARGET_WORKFLOW_BLOB_SHA` in `scripts/ci/translate-queue-recovery.mjs`
 * deve valere il git blob sha di `.github/workflows/translate-pending.yml`, e
 * il manifest del ciclo registra il digest di quel runtime. Il trasporto
 * consegnava il workflow nuovo senza toccare il pin: ogni cambio di
 * `translate-pending.yml` apriva una PR di lockstep rossa per costruzione,
 * ferma finche' qualcuno non rinfrescava il pin a mano (corpus #1998, #2052:
 * 20 ore, due ondate crawler eseguite su codice vecchio).
 *
 * Qui il rinfresco entra nello stesso commit della consegna, ma solo quando il
 * workflow nuovo rispetta cio' che il runtime del watchdog presume sul suo
 * bersaglio. Se una presunzione non regge il pin resta com'e': il rosso del
 * corpus torna a significare «il runtime va rivisto», non «manca un commit
 * meccanico».
 *
 * Zero dipendenze: il job di trasporto gira su uno sparse checkout senza
 * `npm ci`, quindi niente parser YAML. Le letture strutturali valgono per la
 * forma che il generatore emette (indentazione a due spazi) e falliscono
 * chiuse su qualunque altra forma.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WATCHDOG_RUNTIME_PATH = 'scripts/ci/translate-queue-recovery.mjs';
export const TRANSLATE_WORKFLOW_PATH = '.github/workflows/translate-pending.yml';
export const TRANSLATE_ARTIFACT_FILE = 'translate-pending.yml';
export const WATCHDOG_MANIFEST_PATH = 'scripts/ci/loop-sync-manifest.json';

/**
 * Gate che l'artifact consegnato deve contenere (follow-up FU-2026-09-29-002):
 * una consegna verde non puo' lasciare nel corpus un mirror privo del gate di
 * budget della corsia di repair.
 */
export const REQUIRED_TRANSLATE_GATE_IDS = Object.freeze(['repair_lane_budget']);

/**
 * Presunzioni del runtime che il runtime stesso non dichiara in codice ma nel
 * suo commento di soglia: il mutex a slot singolo `jobs-data-pipeline` sul solo
 * job pesante e il timeout del bersaglio (350 min) su cui e' tarata la soglia
 * «coda non servita» di 6 ore.
 */
export const WATCHDOG_TARGET_MUTEX_GROUP = 'jobs-data-pipeline';
export const WATCHDOG_TARGET_MAX_TIMEOUT_MINUTES = 350;

export const UNREFRESHABLE_TITLE =
  'Lockstep crawler: pin del watchdog translate non rinfrescabile in automatico (assunzione del runtime violata)';

/** Annotazione GitHub Actions col titolo stabile (`:` e `,` vanno codificati nelle proprieta'). */
export function unrefreshableAnnotation(level, message) {
  const title = UNREFRESHABLE_TITLE.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::${level} title=${title}::${message.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`;
}

const PIN_SOURCE = "^export const TARGET_WORKFLOW_BLOB_SHA = '([a-f0-9]{40})';$";
const PIN_PLACEHOLDER = "export const TARGET_WORKFLOW_BLOB_SHA = '<pin>';";

function pinMatches(runtime) {
  return [...runtime.matchAll(new RegExp(PIN_SOURCE, 'gm'))];
}

export function gitBlobSha(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto.createHash('sha1')
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest('hex');
}

/** Digest di baseline del manifest: primi 16 hex dello sha256 del file. */
export function manifestDigest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function unquote(value) {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}

/** Righe figlie di una chiave di primo livello scritta come `chiave:` da sola. */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start < 0) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Righe di un job (`  nome:` sotto `jobs:`), fino al job successivo. */
function jobBlock(jobsLines, jobName) {
  const start = jobsLines.findIndex((line) => line.trimEnd() === `  ${jobName}:`);
  if (start < 0) return null;
  const block = [];
  for (const line of jobsLines.slice(start + 1)) {
    if (/^ {2}[^\s#]/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Proprieta' dirette di un job: `    chiave: valore` a quattro spazi esatti. */
function jobProperties(block) {
  const properties = new Map();
  block.forEach((line, index) => {
    const match = /^ {4}([A-Za-z_-]+):(.*)$/.exec(line);
    if (match) properties.set(match[1], { value: match[2].trim(), index });
  });
  return properties;
}

function nestedProperties(block, index) {
  const nested = new Map();
  for (const line of block.slice(index + 1)) {
    if (line.trim() === '') continue;
    const match = /^ {6}([A-Za-z_-]+):(.*)$/.exec(line);
    if (!match) break;
    nested.set(match[1], unquote(match[2]));
  }
  return nested;
}

/**
 * Le presunzioni che il runtime del watchdog fa sul workflow bersaglio e che
 * si possono verificare staticamente. Il nome del job e gli eventi ammessi si
 * leggono dal runtime stesso, cosi' il controllo segue il corpus invece di
 * congelarne una copia. Ritorna l'elenco delle violazioni: vuoto = il pin si
 * puo' rinfrescare senza svuotare la guardia.
 */
export function evaluateWatchdogTargetAssumptions({ workflow, runtime } = {}) {
  if (typeof workflow !== 'string' || typeof runtime !== 'string') {
    throw new Error('workflow and runtime sources are required');
  }
  const jobNames = [...new Set(
    [...runtime.matchAll(/job\?\.name === '([^']+)'/g)].map((match) => match[1]),
  )];
  if (jobNames.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(jobNames[0])) {
    return [`il runtime del watchdog non dichiara un solo job bersaglio riconoscibile (trovati: ${jobNames.length})`];
  }
  const jobName = jobNames[0];
  const eventsMatch = /^const ALLOWED_EVENTS = new Set\(\[([^\]]*)\]\);$/m.exec(runtime);
  const allowedEvents = eventsMatch
    ? eventsMatch[1].split(',').map(unquote).filter(Boolean)
    : [];
  if (allowedEvents.length === 0) {
    return ['il runtime del watchdog non dichiara gli eventi ammessi del bersaglio'];
  }

  const violations = [];
  const lines = workflow.split(/\r?\n/);

  const triggers = topLevelBlock(lines, 'on');
  const triggerNames = (triggers ?? [])
    .map((line) => /^ {2}([A-Za-z_]+):/.exec(line)?.[1])
    .filter(Boolean);
  if (triggerNames.length === 0) {
    violations.push('trigger del workflow non leggibili (`on:` assente o in forma non generata)');
  } else {
    const foreign = triggerNames.filter((name) => !allowedEvents.includes(name));
    if (foreign.length > 0) {
      violations.push(`trigger fuori dagli eventi ammessi dal watchdog (${allowedEvents.join(', ')}): ${foreign.join(', ')}`);
    }
  }

  if (lines.some((line) => /^concurrency:/.test(line))) {
    violations.push('`concurrency` a livello di workflow: il guard della coda non sarebbe piu\' fuori dal mutex');
  }

  const jobs = topLevelBlock(lines, 'jobs');
  const block = jobs ? jobBlock(jobs, jobName) : null;
  if (!block) {
    violations.push(`job \`${jobName}\` assente dal workflow`);
    return violations;
  }
  // Il mutex vale per il SOLO job bersaglio: un altro job con `concurrency`
  // (il guard della coda dentro il mutex, in qualunque forma, anche inline)
  // cambia chi risulta «detentore» e falsa la soglia del watchdog. Un header di
  // job in forma non generata fallisce chiuso.
  for (const header of jobs.filter((line) => /^ {2}[^\s#]/.test(line))) {
    const otherJob = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(header)?.[1];
    if (!otherJob) {
      violations.push(`job in forma non generata sotto \`jobs:\` (\`${header.trim()}\`): presunzioni non verificabili`);
      continue;
    }
    if (otherJob === jobName) continue;
    if (jobBlock(jobs, otherJob).some((line) => /^ {4}['"]?concurrency['"]?\s*:/.test(line))) {
      violations.push(`il job \`${otherJob}\` dichiara \`concurrency\`: il mutex \`${WATCHDOG_TARGET_MUTEX_GROUP}\` deve stare sul solo job \`${jobName}\``);
    }
  }
  const properties = jobProperties(block);
  if (properties.has('name') && unquote(properties.get('name').value) !== jobName) {
    violations.push(`il job \`${jobName}\` ha un \`name\` diverso: l'API non lo riporterebbe come \`${jobName}\``);
  }
  for (const key of ['strategy', 'uses']) {
    if (properties.has(key)) {
      violations.push(`il job \`${jobName}\` usa \`${key}\`: l'API riporterebbe nomi di job derivati`);
    }
  }
  const timeout = properties.get('timeout-minutes')?.value ?? '';
  if (!/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > WATCHDOG_TARGET_MAX_TIMEOUT_MINUTES) {
    violations.push(`\`timeout-minutes\` del job \`${jobName}\` non e' un intero entro ${WATCHDOG_TARGET_MAX_TIMEOUT_MINUTES} (trovato: ${timeout || 'assente'})`);
  }
  const concurrency = properties.get('concurrency');
  const mutex = concurrency && concurrency.value === ''
    ? nestedProperties(block, concurrency.index)
    : new Map();
  if (mutex.get('group') !== WATCHDOG_TARGET_MUTEX_GROUP) {
    violations.push(`il job \`${jobName}\` non tiene il mutex \`${WATCHDOG_TARGET_MUTEX_GROUP}\``);
  }
  if (mutex.get('cancel-in-progress') !== 'false') {
    violations.push(`il mutex del job \`${jobName}\` non dichiara \`cancel-in-progress: false\``);
  }
  return violations;
}

/**
 * Guardia di consegna: l'artifact `translate-pending.yml` presente nel
 * checkout del corpus dopo la copia deve essere byte per byte quello che il
 * contratto dichiara e deve contenere i gate richiesti.
 */
export function assertTranslatePendingArtifact({ sourceDir, corpusRoot } = {}) {
  if (!sourceDir || !corpusRoot) throw new Error('sourceDir and corpusRoot are required');
  const contract = JSON.parse(fs.readFileSync(path.join(sourceDir, 'contract.json'), 'utf8'));
  const declared = (contract.artifacts ?? []).filter(({ file }) => file === TRANSLATE_ARTIFACT_FILE);
  if (declared.length !== 1 || !/^[a-f0-9]{64}$/.test(declared[0].artifactSha256 ?? '')) {
    throw new Error(`${TRANSLATE_ARTIFACT_FILE}: transport contract does not declare exactly one artifactSha256`);
  }
  const deliveredPath = path.join(corpusRoot, TRANSLATE_WORKFLOW_PATH);
  if (!fs.existsSync(deliveredPath)) {
    throw new Error(`${TRANSLATE_WORKFLOW_PATH}: artifact missing from the corpus checkout after the copy`);
  }
  const delivered = fs.readFileSync(deliveredPath);
  const sha256 = crypto.createHash('sha256').update(delivered).digest('hex');
  if (sha256 !== declared[0].artifactSha256) {
    throw new Error(
      `${TRANSLATE_WORKFLOW_PATH}: delivered artifact ${sha256} does not match the contract ${declared[0].artifactSha256} (stale mirror)`,
    );
  }
  const text = delivered.toString('utf8');
  for (const gate of REQUIRED_TRANSLATE_GATE_IDS) {
    if (!new RegExp(`^\\s+id: ${gate}$`, 'm').test(text)) {
      throw new Error(`${TRANSLATE_WORKFLOW_PATH}: delivered artifact lacks the required gate step \`${gate}\``);
    }
  }
  return { sha256 };
}

/**
 * Rinfresca pin e baseline del manifest quando il workflow consegnato non
 * coincide piu' col pin. `knownBlobs` sono i blob sha del workflow che il
 * corpus aveva prima di questa consegna (branch di trasporto e `main`): il pin
 * si rinfresca solo se era coerente con uno di essi, cioe' se a scadere e'
 * stata questa consegna e non un cambio precedente mai rivisto.
 */
export function refreshTranslateWatchdogPin({ corpusRoot, knownBlobs = [] } = {}) {
  if (!corpusRoot) throw new Error('corpusRoot is required');
  const runtimePath = path.join(corpusRoot, WATCHDOG_RUNTIME_PATH);
  if (!fs.existsSync(runtimePath)) {
    return { status: 'absent', previousPin: null, nextPin: null, reasons: [] };
  }
  const workflowBytes = fs.readFileSync(path.join(corpusRoot, TRANSLATE_WORKFLOW_PATH));
  const nextPin = gitBlobSha(workflowBytes);
  const runtimeBytes = fs.readFileSync(runtimePath);
  const runtime = runtimeBytes.toString('utf8');
  const pins = pinMatches(runtime);
  if (pins.length !== 1) {
    return {
      status: 'unrefreshable',
      previousPin: null,
      nextPin,
      reasons: [`il runtime del watchdog non contiene esattamente una costante \`TARGET_WORKFLOW_BLOB_SHA\` (trovate: ${pins.length})`],
    };
  }
  const previousPin = pins[0][1];
  if (previousPin === nextPin) {
    return { status: 'unchanged', previousPin, nextPin, reasons: [] };
  }

  const reasons = [];
  if (!knownBlobs.filter(Boolean).includes(previousPin)) {
    reasons.push('il pin non coincideva col workflow che il corpus aveva prima di questa consegna: era gia\' scaduto e non lo ha invalidato il trasporto');
  }
  const manifestPath = path.join(corpusRoot, WATCHDOG_MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = (manifest.files ?? []).filter((entry) => entry.path === WATCHDOG_RUNTIME_PATH);
  const entry = entries[0];
  if (entries.length !== 1 || entry.mode !== 'corpus-only' || entry.baseline?.site !== null) {
    reasons.push(`il manifest non registra \`${WATCHDOG_RUNTIME_PATH}\` come unica voce \`corpus-only\``);
  } else if (entry.baseline.corpus !== manifestDigest(runtimeBytes)) {
    reasons.push(`la baseline del manifest di \`${WATCHDOG_RUNTIME_PATH}\` non coincideva gia' col file: il runtime e' cambiato senza registrazione`);
  }
  reasons.push(...evaluateWatchdogTargetAssumptions({
    workflow: workflowBytes.toString('utf8'),
    runtime,
  }));
  if (reasons.length > 0) {
    return { status: 'unrefreshable', previousPin, nextPin, reasons };
  }

  const refreshed = runtime.replace(new RegExp(PIN_SOURCE, 'm'), (line) => line.replace(previousPin, nextPin));
  fs.writeFileSync(runtimePath, refreshed);
  entry.baseline.corpus = manifestDigest(Buffer.from(refreshed));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: 'refreshed', previousPin, nextPin, reasons: [] };
}

/**
 * Guardia sul delta completo della branch: rispetto a `main` del corpus il
 * runtime del watchdog puo' differire soltanto nella riga del pin, e il pin
 * deve valere il blob del workflow consegnato. Una branch orfana non puo'
 * quindi usare il path ora ammesso dall'allowlist per portare altro codice.
 * Ritorna il cambio di pin, o `null` se il runtime non e' cambiato.
 */
export function assertWatchdogRuntimeDelta({ baseRuntime, currentRuntime, workflowBytes } = {}) {
  if (baseRuntime === currentRuntime) return null;
  if (typeof baseRuntime !== 'string' || typeof currentRuntime !== 'string') {
    throw new Error('crawler transport may not add or remove the watchdog runtime');
  }
  const basePins = pinMatches(baseRuntime);
  const currentPins = pinMatches(currentRuntime);
  const strip = (source) => source.replace(new RegExp(PIN_SOURCE, 'gm'), PIN_PLACEHOLDER);
  if (basePins.length !== 1 || currentPins.length !== 1 || strip(baseRuntime) !== strip(currentRuntime)) {
    throw new Error('crawler transport changed the watchdog runtime beyond its target workflow pin');
  }
  const nextPin = currentPins[0][1];
  if (!workflowBytes || nextPin !== gitBlobSha(workflowBytes)) {
    throw new Error('crawler transport carries a watchdog pin that does not match the delivered workflow');
  }
  return { previousPin: basePins[0][1], nextPin };
}

/** Righe del body della PR di trasporto: una sola riga per sezione, o vuota. */
export function renderPinBodyLines({ delta, report } = {}) {
  const implemented = delta
    ? `- in questa PR: pin del watchdog rinfrescato: \`${delta.previousPin}\` → \`${delta.nextPin}\` (\`TARGET_WORKFLOW_BLOB_SHA\` in \`${WATCHDOG_RUNTIME_PATH}\` e baseline della sua voce nel manifest). Il rinfresco e' automatico perche' \`translate-pending.yml\` cambia in questa consegna e il workflow nuovo rispetta le presunzioni statiche del watchdog: job bersaglio presente col suo nome, mutex \`${WATCHDOG_TARGET_MUTEX_GROUP}\` sul solo job, timeout entro ${WATCHDOG_TARGET_MAX_TIMEOUT_MINUTES} minuti, soli trigger ammessi.\n`
    : '';
  const pending = report?.status === 'unrefreshable'
    ? `- blocked: decisione del proprietario. ${UNREFRESHABLE_TITLE}: il pin resta \`${report.previousPin ?? 'illeggibile'}\` mentre il workflow consegnato ha blob \`${report.nextPin}\`. **Motivo:** ${report.reasons.join('; ')}. **Prossimo passo:** rivedere nel corpus \`${WATCHDOG_RUNTIME_PATH}\` contro il workflow consegnato e aggiornare a mano pin e baseline del manifest; fino ad allora \`generator/tests/translate-queue-recovery.test.mjs\` resta rosso.\n`
    : '';
  return { implemented, pending };
}

/**
 * La riga del pin e' un fatto della CONSEGNA, non della creazione della PR: a
 * ogni ritrasporto il pin puo' cambiare (corpus PR 2066: body con `bb1c1e69…`
 * mentre il diff portava `befa1307…`). Il resto del body appartiene
 * all'orchestratore e non si riscrive; queste due sezioni si', ma solo fra i
 * loro marcatori. Una sezione vuota resta come coppia di marcatori, cosi'
 * l'aggiornamento successivo sa dove scrivere.
 */
export const PIN_BODY_SECTIONS = Object.freeze({
  implemented: Object.freeze({
    heading: '## Implementato',
    start: '<!-- translate-watchdog-pin:implemented -->',
    end: '<!-- /translate-watchdog-pin:implemented -->',
    legacyPrefix: '- in questa PR: pin del watchdog rinfrescato:',
  }),
  pending: Object.freeze({
    heading: '## Non implementato (ancora)',
    start: '<!-- translate-watchdog-pin:pending -->',
    end: '<!-- /translate-watchdog-pin:pending -->',
    legacyPrefix: `- blocked: decisione del proprietario. ${UNREFRESHABLE_TITLE}`,
  }),
});

/** Blocchi delimitati da accodare alle due sezioni del body. */
export function renderPinBodySections(lines = {}) {
  const block = (name) => {
    const { start, end } = PIN_BODY_SECTIONS[name];
    return `${start}\n${lines[name] ?? ''}${end}\n`;
  };
  return { implemented: block('implemented'), pending: block('pending') };
}

function blockLines(name, block) {
  const { start, end } = PIN_BODY_SECTIONS[name];
  const lines = String(block ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length < 2 || lines[0] !== start || lines.at(-1) !== end
    || lines.slice(1, -1).some((line) => line === start || line === end)) {
    throw new Error(`blocco ${name} del pin senza la coppia di marcatori attesa`);
  }
  return lines;
}

function replaceSection(lines, name, newLines) {
  const { heading, start, end, legacyPrefix } = PIN_BODY_SECTIONS[name];
  const bare = (line) => line.replace(/\r$/, '');
  const starts = lines.flatMap((line, i) => (bare(line) === start ? [i] : []));
  const ends = lines.flatMap((line, i) => (bare(line) === end ? [i] : []));
  if (starts.length > 0 || ends.length > 0) {
    if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
      throw new Error(`marcatori della sezione ${name} del pin non accoppiati nel body (start ${starts.length}, end ${ends.length})`);
    }
    return [...lines.slice(0, starts[0]), ...newLines, ...lines.slice(ends[0] + 1)];
  }

  // Body aperto prima dei marcatori: la riga generata, se c'e', si sostituisce
  // dov'e' (ogni sua copia: mai duplicarla); altrimenti la sezione entra dopo
  // l'ultimo bullet della sezione giusta.
  const legacy = lines.flatMap((line, i) => (bare(line).startsWith(legacyPrefix) ? [i] : []));
  if (legacy.length > 0) {
    const out = [];
    lines.forEach((line, i) => {
      if (i === legacy[0]) out.push(...newLines);
      else if (!legacy.includes(i)) out.push(line);
    });
    return out;
  }
  const headingIndex = lines.findIndex((line) => bare(line).trim() === heading);
  if (headingIndex < 0) {
    throw new Error(`sezione \`${heading}\` assente dal body: riga del pin non collocabile`);
  }
  let sectionEnd = lines.findIndex((line, i) => i > headingIndex && /^#{1,6}\s/.test(line));
  if (sectionEnd < 0) sectionEnd = lines.length;
  let insertAt = -1;
  for (let i = headingIndex + 1; i < sectionEnd; i += 1) {
    if (/^[-*+]\s/.test(lines[i])) {
      insertAt = i + 1;
      // Righe di continuazione rientrate dello stesso bullet.
      while (insertAt < sectionEnd && /^\s+\S/.test(lines[insertAt])) insertAt += 1;
    }
  }
  if (insertAt < 0) {
    insertAt = headingIndex + 1;
    while (insertAt < sectionEnd && bare(lines[insertAt]).trim() === '') insertAt += 1;
  }
  return [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
}

/**
 * Sostituisce nel body di una PR di trasporto gia' aperta SOLO le sezioni del
 * pin, lasciando byte per byte tutto il resto (bullet, `Closes`, contesto che
 * l'orchestratore aggiunge dopo la creazione). `sections` sono i blocchi di
 * `renderPinBodySections`. Ritorna `{ body, changed }`.
 */
export function replacePinBodySections(body, sections = {}) {
  if (typeof body !== 'string') throw new Error('body is required');
  const eol = body.includes('\r\n') ? '\r' : '';
  let lines = body.split('\n');
  for (const name of Object.keys(PIN_BODY_SECTIONS)) {
    const newLines = blockLines(name, sections[name]).map((line) => `${line}${eol}`);
    lines = replaceSection(lines, name, newLines);
  }
  const next = lines.join('\n');
  return { body: next, changed: next !== body };
}

function readOptional(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--assert-artifact') {
    const [sourceDir, corpusRoot] = rest;
    const { sha256 } = assertTranslatePendingArtifact({ sourceDir, corpusRoot });
    console.log(`Delivered ${TRANSLATE_ARTIFACT_FILE} matches the transport contract (${sha256.slice(0, 16)}) and carries its required gates.`);
  } else if (command === '--refresh') {
    // --refresh <corpusRoot> <stateDir> [<known blob sha>...]
    const [corpusRoot, stateDir, ...knownBlobs] = rest;
    if (!stateDir) throw new Error('usage: --refresh <corpusRoot> <stateDir> [<known blob sha>...]');
    const report = refreshTranslateWatchdogPin({ corpusRoot, knownBlobs });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(stateDir, 'status'), `${report.status}\n`);
    if (report.status === 'refreshed') {
      console.log(`Translate watchdog pin refreshed: ${report.previousPin} -> ${report.nextPin}`);
    } else if (report.status === 'unrefreshable') {
      console.log(unrefreshableAnnotation('warning', report.reasons.join('; ')));
    } else {
      console.log(`Translate watchdog pin ${report.status}.`);
    }
  } else if (command === '--describe') {
    // --describe <corpusRoot> <stateDir>; il runtime di main, se esiste, e' in <stateDir>/base-runtime.mjs
    const [corpusRoot, stateDir] = rest;
    if (!stateDir) throw new Error('usage: --describe <corpusRoot> <stateDir>');
    const workflowPath = path.join(corpusRoot, TRANSLATE_WORKFLOW_PATH);
    const delta = assertWatchdogRuntimeDelta({
      baseRuntime: readOptional(path.join(stateDir, 'base-runtime.mjs')),
      currentRuntime: readOptional(path.join(corpusRoot, WATCHDOG_RUNTIME_PATH)),
      workflowBytes: fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath) : undefined,
    });
    const report = JSON.parse(fs.readFileSync(path.join(stateDir, 'report.json'), 'utf8'));
    const { implemented, pending } = renderPinBodySections(renderPinBodyLines({ delta, report }));
    fs.writeFileSync(path.join(stateDir, 'implemented.md'), implemented);
    fs.writeFileSync(path.join(stateDir, 'pending.md'), pending);
    console.log(delta
      ? `Watchdog runtime delta is confined to its pin: ${delta.previousPin} -> ${delta.nextPin}`
      : 'Watchdog runtime unchanged against corpus main.');
  } else if (command === '--update-body') {
    // --update-body <body-in> <stateDir> <body-out>: scrive <body-out> solo se
    // le sezioni del pin cambiano; il chiamante scrive la PR solo se esiste.
    const [bodyIn, stateDir, bodyOut] = rest;
    if (!bodyOut) throw new Error('usage: --update-body <body-in> <stateDir> <body-out>');
    fs.rmSync(bodyOut, { force: true });
    // `gh pr view --jq .body` aggiunge un newline finale che il body salvato non
    // ha: toglierlo evita che ogni aggiornamento reale ne accumuli uno.
    const { body, changed } = replacePinBodySections(fs.readFileSync(bodyIn, 'utf8').replace(/\n$/, ''), {
      implemented: fs.readFileSync(path.join(stateDir, 'implemented.md'), 'utf8'),
      pending: fs.readFileSync(path.join(stateDir, 'pending.md'), 'utf8'),
    });
    if (changed) fs.writeFileSync(bodyOut, body);
    console.log(changed
      ? 'Transport PR body: watchdog pin sections updated.'
      : 'Transport PR body: watchdog pin sections already current.');
  } else if (command === '--fail-if-unrefreshable') {
    // Ultimo passo del trasporto: il job non resta verde su una consegna che
    // lascia la PR del corpus rossa in attesa di una revisione umana.
    const report = JSON.parse(fs.readFileSync(path.join(rest[0], 'report.json'), 'utf8'));
    if (report.status === 'unrefreshable') {
      console.log(unrefreshableAnnotation(
        'error',
        `la PR di trasporto resta rossa su generator/tests/translate-queue-recovery.test.mjs finche' runtime e pin non vengono rivisti nel corpus: ${report.reasons.join('; ')}`,
      ));
      process.exit(1);
    }
  } else {
    throw new Error('usage: translate-watchdog-pin.mjs --assert-artifact|--refresh|--describe|--update-body|--fail-if-unrefreshable ...');
  }
}
