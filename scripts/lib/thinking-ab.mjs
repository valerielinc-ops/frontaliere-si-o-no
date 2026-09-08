// A/B sul thinking di `claude-cli/haiku` nel cascade di traduzione.
//
// PERCHE'. Misurato sulla run 33718515481 del corpus (2026-09-03, 30 chiamate
// strumentate dalla riga 🐢 di `ai-models.mjs`): la chiamata media dura 87,1s e
// il 77,5% e' tempo al primo token, non coda — il `rate_limit_event` dice
// `status=allowed` in ogni campione. I token di thinking sono il 73,4%
// dell'output totale. Il thinking e' il termine dominante del costo, e
// `CLAUDE_CLI_MAX_THINKING_TOKENS=0` lo spegne.
//
// Ma spegnerlo e' una scelta di QUALITA', non una deduzione da una misura di
// latenza: tradurre un annuncio non e' generazione creativa, quindi il thinking
// potrebbe valere poco — «potrebbe» non e' una misura. Comprimere il 77% del
// tempo peggiorando le traduzioni sarebbe un pessimo affare su una pipeline che
// esiste per alzare `complete`. Da qui l'esperimento invece dell'interruttore.
//
// COME. Il braccio si assegna per invocazione, perche' `runSharedCrawler(keys, n)`
// rilancia l'intero crawler del gruppo. Il costo per job varia di trenta volte
// fra un batch e l'altro (misurato nella stessa run: delvitech 152s/job con 1
// job, arxada 4,7s/job con 3, migros-ticino 65,6s/job con 25). Le righe
// dell'artefatto restano per azienda e riportano il gruppo condiviso; cosi' il
// tempo allocato e i job tentati restano attribuibili senza fingere invocazioni
// separate.
//
// Il sale include l'id della run, quindi l'assegnazione CAMBIA a ogni giro: la
// stessa azienda vede entrambi i bracci nel giro di poche run, e il confronto
// finale puo' essere appaiato per azienda invece che fra popolazioni diverse.
// Con un sale fisso, le differenze fra bracci sarebbero indistinguibili dalle
// differenze fra aziende — alcune hanno testo piu' difficile di altre.
//
// La leva e' `process.env.MAX_THINKING_TOKENS`, non la costante di libreria:
// `claudeCliChildEnv()` in `ai-models.mjs` legge l'ambiente del padre a ogni
// spawn e NON sovrascrive un valore gia' presente, quindi impostarlo prima di
// una azienda e toglierlo dopo agisce esattamente sulle chiamate di quel batch.
// Il ciclo delle invocazioni e' sequenziale (`await runSharedCrawler` una per
// volta), quindi la mutazione globale non puo' sovrapporsi fra bracci.
import { createHash } from 'node:crypto';

export const THINKING_AB_FLAG = 'TRANSLATION_THINKING_AB';
export const THINKING_ENV_VAR = 'MAX_THINKING_TOKENS';

/** Braccio di controllo: il comportamento di oggi, thinking al default. */
export const ARM_THINKING = 'thinking';
/** Braccio sperimentale: thinking spento. */
export const ARM_NO_THINKING = 'no-thinking';

/**
 * L'esperimento e' OPT-IN e spento di default: una pipeline di produzione non
 * cambia comportamento perche' qualcuno ha mergiato un modulo. Si accende con
 * `TRANSLATION_THINKING_AB=1` nel workflow.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isThinkingAbEnabled(env = process.env) {
  const raw = (env[THINKING_AB_FLAG] || '').trim();
  return raw === '1' || /^(on|true|yes)$/i.test(raw);
}

/**
 * Assegnazione deterministica e bilanciata. Deterministica perche' la stessa
 * (azienda, run) deve dare lo stesso braccio se il codice la interroga due
 * volte; bilanciata perche' e' la parita' di un digest, non un `Math.random()`
 * che su cinquanta aziende puo' sbilanciarsi parecchio.
 *
 * @param {string} companyKey
 * @param {string} salt  id della run: cambia l'assegnazione a ogni giro
 * @returns {'thinking' | 'no-thinking'}
 */
export function assignThinkingArm(companyKey, salt) {
  const digest = createHash('sha256').update(`${companyKey}\u0000${salt}`).digest();
  return (digest[0] & 1) === 0 ? ARM_THINKING : ARM_NO_THINKING;
}

/**
 * Il sale della run. `GITHUB_RUN_ID` quando esiste, altrimenti un fallback che
 * cambia comunque fra esecuzioni: un sale costante appaierebbe per sempre ogni
 * azienda allo stesso braccio, che e' il difetto che questo esperimento deve
 * evitare.
 *
 * @param {Record<string, string | undefined>} env
 * @param {number} nowMs
 * @returns {string}
 */
export function runSalt(env = process.env, nowMs = Date.now()) {
  const runId = (env.GITHUB_RUN_ID || '').trim();
  const attempt = (env.GITHUB_RUN_ATTEMPT || '').trim();
  if (runId) return attempt ? `${runId}#${attempt}` : runId;
  return `local-${nowMs}`;
}

/**
 * Applica il braccio all'ambiente del processo e rende la funzione che
 * ripristina lo stato precedente. Il ripristino va chiamato in `finally`: se un
 * crawler lancia, l'azienda successiva erediterebbe il braccio sbagliato e
 * l'esperimento misurerebbe un mix invece di due bracci.
 *
 * Se `MAX_THINKING_TOKENS` era gia' impostato dall'esterno lo lascia stare e
 * non fa nulla: chi lo mette in un workflow lo sta facendo apposta, ed e' la
 * stessa regola che `claudeCliChildEnv()` applica a se' stessa.
 *
 * @param {'thinking' | 'no-thinking'} arm
 * @param {Record<string, string | undefined>} env
 * @returns {{ applied: boolean, restore: () => void }}
 */
export function applyThinkingArm(arm, env = process.env) {
  const preexisting = env[THINKING_ENV_VAR];
  if (preexisting !== undefined && String(preexisting).trim() !== '') {
    return { applied: false, restore: () => {} };
  }
  if (arm === ARM_THINKING) {
    // Il braccio di controllo e' «non toccare niente»: il default del modello.
    return { applied: false, restore: () => {} };
  }
  env[THINKING_ENV_VAR] = '0';
  return {
    applied: true,
    restore: () => { delete env[THINKING_ENV_VAR]; },
  };
}

/**
 * Aggrega le righe per braccio. Il rapporto che conta e' `cleared/attempted`:
 * quante traduzioni prodotte hanno superato il gate, non quante ne sono state
 * tentate. Un braccio piu' veloce che produce piu' scarti non e' piu' veloce.
 *
 * Rende `null` per una media quando il denominatore e' zero, mai `0`: «nessuna
 * misura» e «zero» sono due cose diverse, e confonderle e' esattamente il
 * difetto riparato in `queue-alarm.mjs`.
 *
 * @param {Array<{arm: string, companyKey: string, jobCount: number, elapsedMs: number, attempted: number, cleared: number}>} rows
 */
export function summarizeThinkingAb(rows) {
  const arms = {};
  for (const arm of [ARM_THINKING, ARM_NO_THINKING]) {
    const own = rows.filter((r) => r.arm === arm);
    const companies = own.length;
    const jobs = own.reduce((s, r) => s + (r.jobCount || 0), 0);
    const elapsedMs = own.reduce((s, r) => s + (r.elapsedMs || 0), 0);
    const attempted = own.reduce((s, r) => s + (r.attempted || 0), 0);
    const cleared = own.reduce((s, r) => s + (r.cleared || 0), 0);
    arms[arm] = {
      companies,
      jobs,
      elapsedMs,
      attempted,
      cleared,
      msPerJob: jobs > 0 ? Math.round(elapsedMs / jobs) : null,
      acceptRate: attempted > 0 ? cleared / attempted : null,
    };
  }
  return { rows: rows.length, arms };
}
