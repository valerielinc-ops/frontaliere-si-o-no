/**
 * secrets-scope-detect.mjs — shared secrets-scope detection for the zero-Claude
 * pre-promotion gate in followup-drainer.mjs.
 *
 * STRUCTURAL fix for escalation #5057 (bucket fix-outcome:blocked-secrets, 6x/14d:
 * #5052 #5040 #5035 #5034 #5036 #5021). Three monitor-filed issue categories are
 * auto-routed to `agent:fix-queued` (no category regex match in classify-issue.mjs
 * → catch-all `other`, see ISSUES.md "Categorie") and structurally CANNOT be fixed
 * by the issue-fix.yml Claude agent, which runs with `GH_TOKEN` (GitHub App) only —
 * no Firebase Remote Config SA, so none of CF_API_TOKEN / POSTHOG_PERSONAL_API_KEY+
 * POSTHOG_PROJECT_ID / GEMINI_API_KEY+GH_MODELS_PAT are ever available to it
 * (scripts/load-rc-env.mjs requires GOOGLE_APPLICATION_CREDENTIALS, absent in this
 * container):
 *
 *   - `cloudflare-5xx` (scripts/cf-status-report.mjs / cf-5xx-issue-sync.mjs): root
 *     cause verification/mitigation is a Cloudflare zone-setting check
 *     (`always_online`) via CF_API_TOKEN — never a code diff. Confirmed live across
 *     6 independent runs (#4332/#4668/#4669/#5034/#5035/#5036/#5052): each correctly
 *     self-diagnosed as the known `cloudflare-5xx-deploy-churn` class (or genuinely
 *     inconclusive without the token) and terminated blocked, after paying the full
 *     diagnosis cost every time.
 *   - `campaign-goal` (scripts/campaign-goal-check.mjs): a real fix requires live
 *     PostHog HogQL triage to find the actual hotspot element/page (see PR #4324) —
 *     the issue body only ever contains an aggregate count, never a breakdown.
 *     POSTHOG_PERSONAL_API_KEY/POSTHOG_PROJECT_ID (scripts/lib/posthog-client.mjs)
 *     required.
 *   - `evergreen-refresh` (evergreen-refresh-audit.yml): a genuine content refresh
 *     runs the AI generation pipeline in scripts/create-article.mjs (GEMINI_API_KEY,
 *     fallback GH_MODELS_PAT) — a manual `updatedAt` bump would be a fake freshness
 *     signal (non-negotiable #1), not a real fix.
 *
 * Promoting any of these to `agent:fix` burns a full Claude diagnosis run that always
 * concludes `blocked-secrets` (or `no-root-cause` for the identical reason) — same
 * waste shape that #1724 fixed for `.github/workflows/**`-only issues via
 * `detectWorkflowScoped`. This module lets followup-drainer.mjs park these PRE-
 * promotion, zero Claude tokens, mirroring that gate.
 *
 * PROCEED-SAFE (bias to promote): only the 3 labels below trigger a park. Each is
 * applied exclusively by its own monitor script (not guessable/spoofable from issue
 * body prose), so this never blocks an issue outside these specific auto-filed
 * shapes — any other issue that happens to mention "Cloudflare"/"PostHog"/"evergreen"
 * in prose proceeds to the normal fixer, which may still find a genuine code-only fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Perche' la label da sola non bastava (escalation #5838)
 *
 * Rimisurato il 2026-08-14: il bucket `fix-outcome:blocked-secrets` conta ANCORA
 * **7 ricorrenze su 14gg** (#5824 #5758 #5737 #5699 #5696 #5629 #5607) — lo stesso
 * numero che #5057 aveva gia' affrontato. Il motivo e' che **nessuna delle 7 porta
 * una delle 3 label sopra**: il gate esisteva e non guardava questa forma. Tutti e 7
 * i marker `<!-- FIX_OUTCOME: blocked-secrets -->` sono stati scritti dal fixer
 * Claude A RUNTIME, dopo aver pagato il run intero — mai dal pre-flight.
 *
 * La famiglia piu' grande, e l'unica che accelera (3 delle 7, tutte negli ultimi
 * 3 giorni), e' **«imposta un parametro su Firebase Remote Config»**:
 *
 *   #5824  impostare `NEWSLETTER_TOKEN_LEGACY_SUNSET` su Remote Config
 *   #5758  flip Remote Config `NEWSLETTER_TOKEN_SCHEME=v1`
 *   #5737  flip Remote Config `NEWSLETTER_AC_SCHEME=v1` + `NEWSLETTER_AC_TTL_DAYS=30`
 *
 * Scrivere un parametro di Remote Config **non e' mai un diff di codice**: e' una
 * scrittura sul template del progetto `frontaliere-ticino`, che richiede il service
 * account (`GOOGLE_APPLICATION_CREDENTIALS`) che `issue-fix` non ha. Il run finisce
 * `blocked-secrets` per costruzione, esattamente come le 3 label sopra.
 *
 * Queste tre non erano riconoscibili DALLA LABEL perche' non le apre un monitor
 * dedicato: le apre il filer delle follow-up, che etichetta per funnel
 * (`funnel-ux`), non per capability. Quindi il segnale deve venire dal TESTO — ed
 * e' per questo che `detectRemoteConfigScoped` e' modellato su `detectWorkflowScoped`
 * e non su `detectSecretsScoped`: anche li' il segnale e' testuale (un path `.yml`
 * concreto), e la sicurezza non viene dalla provenienza del testo ma dal fatto che
 * il criterio sia **strutturale** e abbia una **valvola di promozione**.
 *
 * ## Perche' NON e' un match sulla prosa
 *
 * Il commento sopra dice, giustamente, che un match sulla prosa e' spoofabile. Qui
 * il criterio non e' una parola: sono TRE congiunzioni, e la terza e' una valvola
 * che apre verso la promozione.
 *
 *   1. il testo nomina la superficie   → `Remote Config` (o `firebase remoteconfig`)
 *   2. il testo nomina un PARAMETRO    → un token `SCREAMING_SNAKE` con almeno un `_`
 *   3. il testo NON cita codice        → `hasNonWorkflowCodeRefs` (lo stesso helper
 *                                        gia' testato di #1724/#5455)
 *
 * (3) e' la ragione per cui questo resta PROCEED-SAFE, ed e' la stessa forma della
 * valvola di `detectWorkflowScoped`: una issue che nomina Remote Config **e** un file
 * sotto `scripts/**` ha plausibilmente un fix di codice, e va promossa. E' cosi' che
 * #5696 — che nomina Remote Config-adiacenti ma chiede una allowlist in
 * `scripts/lib/article-factuality-gates.mjs`, cioe' un fix di codice VERO su questo
 * repo — resta promossa invece di essere parcheggiata per sbaglio.
 *
 * (2) e' il pezzo strutturale: `Remote Config` da solo compare in prosa
 * («la config sta su Remote Config») senza che ci sia niente da impostare. E' il nome
 * del parametro a rendere la issue un'ISTRUZIONE DI SCRITTURA, ed e' quello che il
 * fixer non puo' eseguire. Stessa divisione del lavoro che nella regola gemella dei
 * budget di caratteri: e' l'unita' di misura a fare il lavoro, non il verbo.
 *
 * ## Cio' che questo NON copre, e perche'
 *
 * Delle 7, restano fuori 4, per scelta misurata e non per dimenticanza:
 *
 *   #5699 #5696  il fix vive nel repo del corpus (nanako) → e' un confine di PUSH,
 *                non di credenziale, cioe' la classe di `blocked-workflows-scope`.
 *                #5696 offre per giunta un fix di codice reale su QUESTO repo
 *                (allowlist in `article-factuality-gates.mjs`), quindi parcheggiarla
 *                perderebbe lavoro fattibile: la valvola (3) la promuove, ed e' giusto.
 *   #5629        `blocked: decisione del proprietario` — e' una domanda, non un
 *                difetto tecnico: non tocca a un detector chiuderla.
 *   #5607        eccezione PostHog `RangeError` — un `Maximum call stack size` E'
 *                spesso un difetto di codice dell'app, fixabile senza credenziali.
 *                Promuoverla e' il comportamento corretto.
 *
 * Atteso dopo questa PR: **7 → 4** ricorrenze sulla stessa finestra, e le 3 tolte
 * sono quelle che si stanno moltiplicando.
 */
import { hasNonWorkflowCodeRefs } from './workflow-scope-detect.mjs';

/** label name -> advisory metadata used in the park comment. */
export const SECRETS_SCOPED_LABELS = {
  'cloudflare-5xx': {
    secret: 'CF_API_TOKEN',
    reason:
      'la verifica/mitigazione (zone setting Cloudflare `always_online`) richiede l\'API Cloudflare, non un fix di codice',
  },
  'campaign-goal': {
    secret: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID',
    reason:
      "un fix reale richiede triage live via query HogQL per-elemento (nessun breakdown per-elemento è nel body issue, solo l'aggregato)",
  },
  'evergreen-refresh': {
    secret: 'GEMINI_API_KEY / GH_MODELS_PAT',
    reason:
      "un refresh genuino gira la pipeline AI di scripts/create-article.mjs; un bump manuale di `updatedAt` sarebbe un freshness signal fittizio (non-negotiable #1)",
  },
};

/** True if any of the given label names is a known secrets-scoped category. */
export function detectSecretsScoped(labelNames) {
  return (labelNames || []).some((n) =>
    Object.prototype.hasOwnProperty.call(SECRETS_SCOPED_LABELS, n),
  );
}

/**
 * First matching known secrets-scoped label + its advisory metadata, or null.
 * Deterministic (object key insertion order) when an issue somehow carries >1 match.
 */
export function matchSecretsScopedLabel(labelNames) {
  const match = (labelNames || []).find((n) =>
    Object.prototype.hasOwnProperty.call(SECRETS_SCOPED_LABELS, n),
  );
  return match ? { label: match, ...SECRETS_SCOPED_LABELS[match] } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote Config scope (#5838) — il segnale e' TESTUALE, come detectWorkflowScoped
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La superficie, non il verbo. `Remote Config` con qualunque spaziatura, piu' la
 * forma API/CLI (`firebase remoteconfig`, `remoteConfig.getTemplate`).
 */
export const REMOTE_CONFIG_SURFACE_RE = /\b(?:remote[\s_-]*config|remoteconfig)\b/i;

/**
 * Un NOME DI PARAMETRO: `SCREAMING_SNAKE` con almeno un underscore interno.
 *
 * L'underscore obbligatorio e' la parte che tiene fuori la prosa: gli acronimi che
 * questi body usano davvero — `LPD`, `AVS`, `INPS`, `CHF`, `TTL`, `API`, `PR` — sono
 * token singoli e non matchano. Serve una coppia di segmenti, che in prosa italiana
 * non capita.
 */
export const REMOTE_CONFIG_PARAM_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** I nomi di parametro citati da `text`, dedotti e in ordine stabile. */
export function extractRemoteConfigParams(text) {
  return [...new Set(String(text || '').match(REMOTE_CONFIG_PARAM_RE) || [])];
}

/**
 * True se il fix di questa issue e' ESCLUSIVAMENTE una scrittura su Firebase
 * Remote Config, che `issue-fix` non puo' eseguire (nessun
 * `GOOGLE_APPLICATION_CREDENTIALS` nel container: solo `GH_TOKEN` GitHub App).
 * Puro → testabile, come `detectWorkflowScoped`.
 *
 * Le tre congiunzioni sono argomentate nell'intestazione del file. La terza e' la
 * valvola di promozione: in dubbio si promuove, mai il contrario.
 *
 * @param {string} text  title + body della issue
 * @returns {boolean}
 */
export function detectRemoteConfigScoped(text) {
  const s = String(text || '');
  if (!REMOTE_CONFIG_SURFACE_RE.test(s)) return false; // non nomina la superficie → promuovi
  if (extractRemoteConfigParams(s).length === 0) return false; // nessun parametro → promuovi
  if (hasNonWorkflowCodeRefs(s)) return false; // cita codice → forse c'e' un fix vero → promuovi
  return true; // scrittura su Remote Config e basta → blocked-secrets by construction
}

/**
 * Il match secrets-scoped COMPLETO: prima le label note (#5057), poi la forma
 * testuale Remote Config (#5838). Stessa metadata shape nei due casi, cosi' il
 * chiamante compone un solo commento di park.
 *
 * @param {{ labels?: string[], text?: string }} input
 * @returns {{ label: string, secret: string, reason: string, via: 'label'|'remote-config', params?: string[] }|null}
 */
export function matchSecretsScopedShape({ labels, text } = {}) {
  const byLabel = matchSecretsScopedLabel(labels);
  if (byLabel) return { ...byLabel, via: 'label' };
  if (!detectRemoteConfigScoped(text)) return null;
  const params = extractRemoteConfigParams(text).slice(0, 5);
  return {
    via: 'remote-config',
    label: 'remote-config-write',
    secret: 'GOOGLE_APPLICATION_CREDENTIALS (service account Firebase)',
    params,
    reason:
      `l'unica azione richiesta e' scrivere ${params.map((p) => `\`${p}\``).join(', ')} sul template Remote Config del progetto \`frontaliere-ticino\` — non e' un diff di codice, quindi non esiste un fix che questo repo possa contenere`,
  };
}
