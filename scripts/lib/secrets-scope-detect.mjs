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
 */

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
