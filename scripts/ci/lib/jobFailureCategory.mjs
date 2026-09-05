/**
 * jobFailureCategory.mjs — di che cosa e' fatto il rosso del check richiesto.
 *
 * ── PERCHE' ESISTE ────────────────────────────────────────────────────────
 * Il check richiesto dal ruleset si chiama `vitest (unit + integration)`, ma il
 * job che lo produce porta ~43 step: il contratto del body della PR, i lint, i
 * source guard, `tsc`, i test, e in fondo il verdetto della Claude review. Uno
 * qualunque di quegli step tinge di rosso un check che si chiama «vitest», e
 * ogni lettore — umano o agente — conclude che i test siano rotti.
 *
 * Non e' un'ipotesi: `vitestCheck.mjs` esiste in buona parte per questo, e il
 * suo `vitestFailureIsReviewGate` e' esattamente il predicato «quel rosso NON
 * sono i test». Quel predicato pero' vive fuori dal job, per i consumer che
 * decidono se riciclare una PR. Qui la stessa distinzione serve DENTRO il job,
 * per scriverla in chiaro nello Step Summary della run: la pagina della run e'
 * il primo posto dove si clicca dopo aver visto il rosso, e finora accoglieva
 * il lettore con 43 step da scorrere.
 *
 * ── PERCHE' UN MODULO A PARTE E NON DENTRO vitestCheck.mjs ────────────────
 * `scripts/ci/lib/vitestCheck.mjs` e' `identical` in
 * `frontaliere-articles/scripts/ci/loop-sync-manifest.json`: la sua copia nel
 * corpus deve restare byte-identica. I nomi di step qui sotto sono quelli del
 * `tests.yml` DEL SITO; il corpus ha un job con lo stesso ruolo ma step
 * completamente diversi (`node --test`, niente vitest, niente npm ci). Metterli
 * in un file mirrorato significherebbe spedire nel corpus una tabella che li'
 * non descrive nulla. `REVIEW_GATE_STEP_NAME` resta invece importato da
 * `vitestCheck.mjs`: il nome dello step del review gate ha UNA sola sorgente.
 *
 * ── UNO STEP ROSSO NON È UN JOB ROSSO ────────────────────────────────────
 * Sette step di questo job portano `continue-on-error: true` — fra cui
 * `Run Claude review`, i due `Mint … token` e i due commenti advisory. Il loro
 * fallimento NON tinge di rosso il job. Classificare per sola `conclusion`
 * degli step scriverebbe quindi un `❌` in cima alla pagina di una run VERDE,
 * cioè la stessa classe di bugia che questo modulo esiste per chiudere,
 * girata un'altra volta. Il verdetto del job arriva dal contesto
 * (`job.status`, che l'ultimo step legge mentre il job è ancora in corso) e
 * `classifyJobFailure` non spiega niente quando quel verdetto non è `failure`.
 * Filtrare invece i nomi degli step `continue-on-error` sarebbe una seconda
 * lista da tenere allineata a mano, cioè lo stesso drift con più superficie.
 *
 * ── L'INVARIANTE CHE CONTA ───────────────────────────────────────────────
 * La frase non deve MAI affermare «i test sono passati» senza prova positiva.
 * L'esito dei test si legge dalla `conclusion` del loro step, mai per assenza:
 * se lo step di test non e' nella lista, o e' `skipped` perche' un cancello a
 * monte ha gia' fatto fallire il job, la frase lo dice invece di inventare un
 * verde. E' la stessa bugia che questo modulo esiste per chiudere, girata al
 * contrario.
 */
import { REVIEW_GATE_STEP_NAME } from './vitestCheck.mjs';

/**
 * L'unico invocatore di Vitest del job su una PR (vedi il commento dello step
 * in `tests.yml`: «Questo e' l'unico invocatore di Vitest del job PR»).
 * `tests/ci-job-failure-category.test.ts` verifica che questo nome esista
 * ancora fra gli step del workflow: se lo step viene rinominato senza toccare
 * questa costante, la classificazione perderebbe la prova dell'esito dei test.
 */
export const TEST_STEP_NAME = 'vitest related (PR diff)';

/**
 * Le categorie, in ordine di PRIORITA': se piu' step sono rossi vince la prima
 * che matcha. I test per primi — un rosso dei test e' il rosso che il nome del
 * check gia' comunica correttamente, e non va mai mascherato da un gate.
 *
 * `ambiguous: true` marca uno step il cui rosso NON identifica una causa: il
 * join dei gate in background unisce `tsc`, i cinque lint e il gruppo vitest
 * indipendente, e dal solo esito dello step non si sa quale dei tre ha ceduto.
 * Per quel caso non si afferma nulla sull'esito dei test.
 */
export const FAILURE_CATEGORIES = Object.freeze([
  {
    id: 'tests',
    names: [TEST_STEP_NAME],
    tail: 'hanno fallito i test',
  },
  {
    id: 'background-join',
    names: ['Wait for background gates and independent vitest'],
    tail: 'è rosso il join dei gate in background: typecheck, lint o gruppo vitest indipendente — quale dei tre sta scritto nel log di questo step',
    ambiguous: true,
  },
  {
    id: 'review-gate',
    names: [REVIEW_GATE_STEP_NAME],
    tail: 'manca la review approvante sulla HEAD — nessun `## LGTM`, oppure un finding \u{1F534} Important',
  },
  {
    id: 'review-run',
    names: ['Run Claude review', 'Fail on transient API error (no review posted)'],
    tail: "la Claude review non ha prodotto un verdetto (errore transient dell'API): basta ri-eseguire il job",
  },
  {
    id: 'pr-body',
    names: ['PR-body completeness + multi-issue Closes (no checkout, all events)'],
    tail: 'il body della PR non rispetta il contratto (`## Implementato` / `## Non implementato (ancora)`)',
  },
  {
    id: 'typecheck',
    names: ['tsc --noEmit (baseline + ratchet)'],
    tail: 'il typecheck è rosso',
  },
  {
    id: 'source-guards',
    names: [
      'Wait for background source guards',
      'Forbid hard-coded AdSense <ins> in build-plugins',
      'Forbid regex lookbehind in client-bundled source',
    ],
    tail: 'è rosso un source guard',
  },
]);

const OTHER = Object.freeze({
  id: 'other',
  names: [],
  tail: 'è rosso uno step che non esegue test',
});

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Classifica il rosso di un job a partire dai suoi step.
 *
 * Pura: nessuna I/O. Il chiamante passa `.steps` della jobs API (stessa forma
 * consumata da `vitestFailureIsReviewGate`).
 *
 * @param {Array<{name?: string, conclusion?: string}>} steps
 * @param {{jobStatus?: string}} [options] `job.status` del job in corso. Un
 *   valore diverso da `'failure'` significa che il job NON è rosso — gli step
 *   `continue-on-error` falliti non lo tingono — e allora non c'è niente da
 *   spiegare. Assente o vuoto: si classifica comunque, che è il caso dell'uso
 *   a mano su una run già conclusa, dove il contesto del job non esiste.
 * @returns {{category: string, headline: string, failedSteps: string[], testsVerdict: 'passed'|'failed'|'not-run'|'partial'|'unknown'}|null}
 *   `null` quando il job non è rosso, o quando nessuno step è rosso.
 */
export function classifyJobFailure(steps, { jobStatus = '' } = {}) {
  if (jobStatus && jobStatus !== 'failure') return null;
  if (!Array.isArray(steps)) return null;
  const failedSteps = steps
    .filter((s) => s && s.conclusion === 'failure' && typeof s.name === 'string' && s.name)
    .map((s) => s.name);
  if (failedSteps.length === 0) return null;

  const category =
    FAILURE_CATEGORIES.find((c) => failedSteps.some((name) => c.names.includes(name))) || OTHER;

  const testStep = steps.find((s) => s && s.name === TEST_STEP_NAME);
  let testsVerdict;
  if (category.id === 'tests') testsVerdict = 'failed';
  // Categoria ambigua con lo step di test verde: la prova positiva esiste ma
  // copre solo META' della domanda, e buttarla via darebbe al lettore la frase
  // meno utile delle due nel caso piu' frequente. `partial` la conserva e ne
  // dichiara il confine invece di generalizzarla a «i test sono passati».
  else if (category.ambiguous) {
    testsVerdict = testStep?.conclusion === 'success' ? 'partial' : 'unknown';
  } else if (testStep?.conclusion === 'success') testsVerdict = 'passed';
  else if (testStep?.conclusion === 'skipped') testsVerdict = 'not-run';
  else testsVerdict = 'unknown';

  let headline;
  if (testsVerdict === 'failed') {
    headline = `${capitalize(category.tail)}.`;
  } else if (testsVerdict === 'passed') {
    headline = `I test sono passati: ${category.tail}.`;
  } else if (testsVerdict === 'partial') {
    headline = `${capitalize(category.tail)}. Lo step «${TEST_STEP_NAME}» è verde: se sono test, sono quelli del gruppo indipendente, non quelli scelti dal diff della PR.`;
  } else if (testsVerdict === 'not-run') {
    headline = `${capitalize(category.tail)}. I test non sono stati eseguiti: lo step «${TEST_STEP_NAME}» è stato saltato da un cancello a monte.`;
  } else {
    headline = `${capitalize(category.tail)}. L'esito dei test non è determinabile da questi step.`;
  }

  return { category: category.id, headline, failedSteps, testsVerdict };
}

/**
 * Il markdown da appendere a `$GITHUB_STEP_SUMMARY`. Deliberatamente corto:
 * chi arriva qui ha appena visto un rosso e vuole sapere in due secondi di che
 * cosa e' fatto, non leggere un report.
 *
 * @param {ReturnType<typeof classifyJobFailure>} verdict
 * @param {string} checkName Nome del check-run, per ancorare la frase al rosso
 *   che il lettore ha appena visto in `gh pr checks`.
 * @returns {string}
 */
export function formatJobFailureSummary(verdict, checkName) {
  if (!verdict) return `### ✅ ${checkName}\n\nNessuno step rosso in questo job.\n`;
  const lines = [
    `### ❌ ${checkName}`,
    '',
    `**${verdict.headline}**`,
    '',
    'Step rossi:',
    ...verdict.failedSteps.map((name) => `- \`${name}\``),
    '',
    `_Il check richiesto si chiama \`${checkName}\` ma porta l'intero job: contratto del body, source guard, lint, typecheck, test e il verdetto della Claude review. Il suo nome non dice quale famiglia ha ceduto; questa riga sì._`,
    '',
  ];
  return lines.join('\n');
}
