/**
 * sibling-check-gate.mjs — PreToolUse hook: blocks `gh pr create` when
 * check-sibling-patterns.mjs finds uncovered sibling files that have NOT been
 * declared as false positives in the PR body's `## Non implementato` section.
 *
 * False-positive filter (issue #3325): a candidate is a genuine sibling only
 * when it is NOT explicitly invoked as a false positive (AGENTS.md #6 escape
 * hatch: "solo lessicalmente simile ma semanticamente diverso" / "falso
 * positivo"). Mere deferral ("will fix in follow-up") is NOT a false positive —
 * the gate still blocks on it, consistently with AGENTS.md #8 (deferral ≠
 * closure). Mirrors the analogous isGenuinePrBodyContractViolation filter in
 * pr-body-check-gate.mjs (shipped in #3332).
 *
 * WHAT THIS GATE ANALYSES (rewritten 2026-09-05). Not "the working tree of
 * some directory" — THE BRANCH the gated command is proposing. The gate reads
 * `--head <branch>` off the `gh pr create` command line, falls back to the
 * tracked directory's `HEAD` when that is a shell substitution it cannot
 * expand, and passes the ref to `check-sibling-patterns.mjs --head`. Reason:
 * `payload.cwd` is the session's TRACKED cwd, updated by `cd`s in PREVIOUS
 * Bash calls, so in a fleet it is routinely the shared main checkout — and
 * that checkout's working tree carries other sessions' uncommitted files.
 * Measured that day: a branch touching 1 file (22 candidates from its own
 * worktree) was judged against 4 foreign dirty files and 50 candidates, none
 * of them declarable, because they were not the author's. A commit-to-commit
 * diff against a branch ref cannot see foreign uncommitted work, and worktrees
 * share `.git` so the ref resolves the same from any directory of the repo.
 * See lib/hook-target-cwd.mjs for the full incident and for what that module
 * does and does not close.
 *
 * When the branch cannot be identified at all — the ref diff comes back with
 * ZERO changed files, which at `gh pr create` time is impossible for a real
 * branch — the gate blocks and says exactly that, instead of reading it as a
 * clean sweep. Same #5195 principle as the `skipped` branch below: an analysis
 * that did not run must not be spelled "all clear".
 *
 * Fail-safe: any internal error → exit 0 (never block PR on script failure).
 *
 * Exit codes are Claude Code hook semantics, NOT Unix convention: for
 * PreToolUse only **2** blocks the tool call. 1 is a "non-blocking error" —
 * stderr is shown and `gh pr create` runs anyway. This gate printed
 * "PR bloccata" and exited 1, so it had never actually blocked anything; the
 * message asserted an enforcement that did not happen, which is the same
 * class of defect as the silent skip below (#5195) — a guard that reads as a
 * guard without being one. Use EXIT_BLOCK, never a bare 1.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { extractPrBody, describePrBodySource } from './pr-body-check-gate.mjs';
import { FALSE_POSITIVE_DECLARATION_RE } from './lib/false-positive-declaration.mjs';
import {
  ALLOW_UNRESOLVED_ENV,
  unresolvedBaseOverrideActive,
} from './lib/resolve-merge-base.mjs';
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import { resolveHookTargetCwd, resolveGatedHeadRef } from './lib/hook-target-cwd.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkScript = join(__dirname, 'check-sibling-patterns.mjs');
// Il repo a cui questo gate appartiene, ricavato dal proprio path: e' l'unica
// directory sempre giusta, anche quando `payload.cwd` e' inchiodato altrove
// (thread di sub-agente — vedi lib/hook-target-cwd.mjs).
const gateRepo = resolve(__dirname, '..', '..');

/**
 * Extract the text under `## Non implementato` from a PR body (up to the next
 * `##` section or end-of-string). Returns empty string when the section is absent.
 */
function extractNonImplementato(body) {
  const m = /#{2,3}\s+Non implementato[^\n]*([\s\S]*?)(?=\n#{2,3}|\s*$)/i.exec(body);
  return m ? m[1] : '';
}

/**
 * Full path (dir/basename, last 2 segments) match against a bare-basename
 * mention in the PR body that names a DIFFERENT full path. Disambiguates
 * same-named files in different directories (e.g. `scripts/lib/scoring/
 * constants.mjs` vs `scripts/ci/lib/constants.mjs`): a basename-only FP
 * declaration for one must NOT be read as covering the other.
 */
function lineNamesADifferentPath(line, candidatePath, fname) {
  const pathRe = /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+)/g;
  let m;
  while ((m = pathRe.exec(line))) {
    if (basename(m[1]) === fname && m[1] !== candidatePath) return true;
  }
  return false;
}

/**
 * True if `candidatePath` is explicitly declared a false positive in the
 * `## Non implementato` section text. Only AGENTS.md #6 escape-hatch language
 * qualifies (see FALSE_POSITIVE_DECLARATION_RE); bare file mentions or
 * deferral notes ("will fix in follow-up") do NOT — those remain genuine
 * unaddressed siblings. A basename-only match is rejected when the line names
 * a full path for a DIFFERENT file with the same basename.
 */
export function isDeclaredFalsePositive(candidatePath, nonImplText) {
  if (!nonImplText || !candidatePath) return false;
  const fname = basename(candidatePath);
  const lines = nonImplText.split('\n').filter((l) => {
    if (l.includes(candidatePath)) return true;
    if (fname.length > 3 && l.includes(fname)) {
      return !lineNamesADifferentPath(l, candidatePath, fname);
    }
    return false;
  });
  return lines.some((l) => FALSE_POSITIVE_DECLARATION_RE.test(l));
}

/**
 * La forma di dichiarazione che `isDeclaredFalsePositive` accetta davvero,
 * scritta come la scriverebbe chi la deve usare.
 *
 * Il filtro richiede, PER OGNI candidato, UNA riga che contenga sia il path (o
 * il basename) sia la formula di falso positivo, e `lineNamesADifferentPath`
 * scarta una riga che nomina un altro path. Cioe': una riga per file. Un
 * paragrafo di giustificazione — che a un lettore umano sembra piu' che
 * sufficiente — non viene mai riconosciuto, e il gate lo ignorava in silenzio
 * limitandosi a ripetere che i candidati non erano coperti. Il messaggio ora
 * insegna la forma invece di lasciarla indovinare (2026-09-05).
 */
export const DECLARATION_HOWTO =
  'FORMA ACCETTATA: dentro `## Non implementato (ancora)`, UNA RIGA PER FILE,\n' +
  'ciascuna col suo path E la sua formula di falso positivo sulla STESSA riga.\n' +
  'Esempio di una riga:\n' +
  '  - scripts/foo.mjs — falso positivo, per scelta: condivide il token X ma lo usa\n' +
  '    come nome di variabile locale, non come helper condiviso.\n' +
  'Un paragrafo unico che giustifica più file NON viene riconosciuto: il filtro\n' +
  'cerca path e formula sulla STESSA riga.\n' +
  'Una riga che nomina un ALTRO path con lo stesso basename non copre il candidato.\n' +
  'Formule valide: «falso positivo» / «false positive» / «solo lessicalmente simile\n' +
  'ma semanticamente diverso» / «not the same bug class». Un rinvio a follow-up NO.';

async function main() {
  let command = '';
  let targetCwd;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        command =
          payload?.tool_input?.command ??
          payload?.command ??
          '';
        targetCwd = resolveHookTargetCwd(payload);
      } catch {
        command = raw; // raw text fallback — grep for gh pr create
      }
    }
  } catch {
    process.exit(0); // stdin failure → fail-safe
  }

  if (!command.includes('gh pr create')) {
    process.exit(0);
  }

  // Run check-sibling-patterns.mjs --json to get the structured candidate list.
  // `--head <ref>` pins the analysis to the BRANCH being proposed (see the
  // module docstring): a commit-to-commit diff, identical from any directory of
  // the repo, blind to other sessions' uncommitted files. `cwd: targetCwd` now
  // only picks WHICH REPO to run git in.
  const head = resolveGatedHeadRef(command, targetCwd, gateRepo);
  let jsonOutput;
  try {
    jsonOutput = execFileSync('node', [checkScript, '--json', '--head', head.ref], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      // Capture stdout (parsed as JSON); let stderr propagate for progress messages.
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: head.cwd,
    });
  } catch {
    process.exit(0); // check script error → fail-safe
  }

  let candidates;
  let result;
  try {
    result = JSON.parse(jsonOutput);
    candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  } catch {
    process.exit(0); // JSON parse error → fail-safe
  }

  // Issue #5195, second half. check-sibling-patterns.mjs emits
  // `skipped: true` when it could not compute a merge-base — a deliberate
  // "I did not run" signal. This gate used to read only `candidates` and so
  // treated that as `candidates.length === 0` → exit 0, ZERO output, PR
  // created. That is the failure mode the shallow-clone fix was supposed to
  // remove, not relocate: 640 false positives at least got read, a silent
  // all-clear never does. An un-run analysis blocks, and says so.
  if (result?.skipped) {
    const override = unresolvedBaseOverrideActive();
    process.stderr.write(
      `\n🚫 sibling-check-gate: sweep sibling NON ESEGUITO (${result.reason ?? 'sconosciuto'}).\n` +
        'Nessun file gemello è stato verificato: questo NON equivale a "nessun candidato".\n' +
        (override
          ? `${ALLOW_UNRESOLVED_ENV} attivo → PR consentita senza verifica sibling (scelta dichiarata).\n\n`
          : 'Rimedio: `git fetch --deepen=500 origin` (clone shallow) e riprova, oppure\n' +
            `procedi deliberatamente con ${ALLOW_UNRESOLVED_ENV}=1.\n\n`),
    );
    process.exit(override ? 0 : EXIT_BLOCK);
  }

  // Difetto 1, seconda meta'. Un branch in apertura di PR cambia per forza
  // almeno un file: `changedFiles === 0` significa che il ref analizzato NON e'
  // il branch dell'autore — tipicamente `HEAD` del checkout principale
  // condiviso, fermo su main. Leggerlo come "sweep pulito" e' la stessa
  // classe di difetto del silent skip #5195, al contrario: qui il gate
  // lascerebbe passare senza aver guardato niente. Blocca e dice come uscirne.
  if (result?.changedFiles === 0) {
    process.stderr.write(
      '\n\u{1F6AB} sibling-check-gate: BRANCH NON IDENTIFICATO — nessuna verifica sibling eseguita.\n' +
        `Ref analizzato: ${head.ref} (${head.source === 'cwd-head' ? 'HEAD della directory tracciata' : 'da --head'})` +
        `${head.cwd ? ` in ${head.cwd}` : ''}\n` +
        `Quel ref non differisce da ${result.base ?? 'origin/main'}: non puo' essere il branch che stai proponendo.\n` +
        'Cause tipiche, in ordine di frequenza:\n' +
        '  1. la directory tracciata è il checkout principale, non il tuo worktree.\n' +
        '     Il `cd <worktree>` deve stare in una chiamata Bash PRECEDENTE: questo hook\n' +
        '     gira PRIMA del comando, quindi un `cd` nella stessa riga non conta.\n' +
        '  2. il branch non è ancora committato. Committa (e pusha) prima di aprire la PR.\n' +
        '  3. `--head` porta una sostituzione di shell non espansa: passa il nome\n' +
        '     letterale del branch, che questo hook sa risolvere da qualunque directory.\n' +
        '     Da un SUB-AGENTE questa è la causa quasi certa: lì `payload.cwd` resta\n' +
        '     inchiodato alla directory di lancio e nessun `cd` la muove, quindi il nome\n' +
        '     letterale del branch è l\'unico segnale che ti identifica.\n\n',
    );
    process.exit(EXIT_BLOCK);
  }

  if (candidates.length === 0) {
    process.exit(0); // no sibling candidates → allow PR creation
  }

  // Extract PR body for the false-positive filter. If we can't parse the body
  // (undefined), fall back to treating all candidates as genuine (conservative,
  // same behaviour as the old --strict mode) — never silently drop a real check.
  // `targetCwd` resolves a relative `--body-file` against the worktree the
  // gated command is in, same fix as the check-script invocation above.
  let prBody;
  try {
    prBody = extractPrBody(command, targetCwd);
  } catch {
    // body extraction error → conservative: treat all candidates as genuine
  }

  let genuineCandidates = candidates;
  if (prBody !== undefined) {
    const nonImplText = extractNonImplementato(prBody);
    genuineCandidates = candidates.filter(
      (c) => !isDeclaredFalsePositive(c.file, nonImplText),
    );
  }

  if (genuineCandidates.length === 0) {
    // All candidates declared false positives in ## Non implementato → allow.
    process.exit(0);
  }

  // Difetto 2. Quando il body non e' leggibile il comportamento resta lo stesso
  // (conservativo: tutti i candidati genuini), ma va detto PER PRIMO e con la
  // causa: senza, il gate accusa i file gemelli mentre il problema e' un path
  // risolto contro la directory sbagliata, e chi legge insegue i candidati.
  if (prBody === undefined) {
    const src = describePrBodySource(command, targetCwd);
    process.stderr.write(
      '\n\u{26A0}\u{FE0F}  sibling-check-gate: IL BODY DELLA PR NON È STATO LETTO ' +
        `(${src.reason ?? 'causa sconosciuta'}).\n` +
        `Sorgente rilevata: ${src.kind}\n` +
        (src.path ? `Path tentato: ${src.path}\nRisolto in: ${src.resolved}\n` : '') +
        `Directory di risoluzione: ${src.cwd}\n` +
        'Nessuna dichiarazione di falso positivo può quindi essere stata considerata:\n' +
        'i candidati qui sotto sono TUTTI quelli trovati, non quelli non coperti.\n' +
        'Scrivi il body su file e passa `--body-file <path>`; se il path è relativo,\n' +
        'lo risolviamo contro la directory qui sopra — mettilo lì o passalo assoluto.\n',
    );
  }

  // Print the genuine candidate list for the fixer to inspect. `strength`
  // (difetto 4) dice quanto e' forte l'aggancio: `debole` = un solo
  // identificatore nudo condiviso, storicamente quasi sempre rumore.
  process.stdout.write(
    `\n⚠ ${genuineCandidates.length} file gemello/i NON toccato/i condivide/ono costrutti modificati da questo branch:\n\n`,
  );
  for (const c of genuineCandidates) {
    process.stdout.write(`  ${c.strength ? `[${c.strength}] ` : ''}${c.file}\n`);
    if (c.tokens?.length) {
      process.stdout.write(`      costrutti condivisi: ${c.tokens.join(', ')}\n`);
    }
  }
  const weak = genuineCandidates.filter((c) => c.strength === 'debole').length;
  if (weak) {
    process.stdout.write(
      `\n[debole] = agganciato a UN SOLO identificatore nudo (${weak}/${genuineCandidates.length} qui).\n` +
        'Un nome di variabile o di campo reimplementato in file scorrelati finisce qui;\n' +
        'un helper condiviso o una forma strutturale del registro finisce in [forte].\n' +
        'Guardali comunque tutti, ma parti dai [forte]: è lì che stanno i gemelli veri.\n',
    );
  }

  process.stderr.write(
    '\n\u{1F6AB} sibling-check-gate: PR bloccata — file gemello/i non coperti trovati.\n' +
      'Ispeziona i candidati sopra e includi il fix nella STESSA PR (AGENTS.md #6),\n' +
      'oppure dichiarali falsi positivi.\n\n' +
      DECLARATION_HOWTO +
      '\n\n',
  );
  process.exit(EXIT_BLOCK);
}

// Only run when executed directly (e.g. as a PreToolUse hook), not on import.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
