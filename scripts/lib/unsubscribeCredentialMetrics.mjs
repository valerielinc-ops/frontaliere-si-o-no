/**
 * unsubscribeCredentialMetrics.mjs — arithmetic behind the unsubscribe
 * credential-fallback monitor (#5757 item 3, deferred out of #5747/#5763).
 *
 * THE PROBLEM IT CLOSES
 *
 * #5719 gave every successful `unsubscribe` event a `credential` field:
 * `'email_token'` when the standard scoped `/disiscrivi-newsletter/` link
 * verified on its own, `'autologin_code'` when that check FAILED and the
 * request only got through because a still-authentic `ac` code was also on
 * the URL (`verifyOptOutCredential`,
 * functions/src/newsletterSubscriptionManagement.js). `ac` is a fallback
 * checked ONLY after the primary token fails — so under healthy operation
 * `autologin_code` should be rare-to-never. #5724 is in the process of
 * giving `ac` its own TTL/revocation; the day that ships, every unsubscribe
 * currently riding the `autologin_code` fallback is a person one policy
 * change away from a real "Link non valido" — the exact LPD-complaint shape
 * the whole `ac` credential exists to prevent (see
 * verifyOptOutCredential's docstring). This module is the arithmetic that
 * watches how many people are ALREADY depending on that fallback, so the
 * `ac` TTL rollout has a number instead of a surprise.
 *
 * WHY THE RATE IS `autologin_code / (autologin_code + email_token)`, NOT
 * `email_token`'s share
 *
 * `email_token` is the expected, primary path — every newsletter footer
 * carries the scoped token link, so under normal operation this credential
 * should cover close to 100% of unsubscribes. `autologin_code` only shows up
 * when the primary path already failed for that person. A RISING share of
 * `autologin_code` is the signal: it says the primary token is failing more
 * often (template regression? scope drift?) and these are exactly the
 * people who lose their exit the day `ac` gets a TTL too.
 *
 * `missing` (no `credential` field at all) is excluded from the rate on
 * purpose: `credential` is a field introduced by #5719, so every
 * `unsubscribe`/`unsubscribe_link` event that predates that deploy has no
 * opinion either way — counting it as either family would dilute the rate
 * with pre-rollout noise. `evaluate()` still surfaces total volume so a
 * denominator that stays at 0 (`credential` never getting written — a
 * regression at the write site) is reported (`no_signal`), never silently
 * read as "empty  == healthy".
 *
 * AND THAT EXCLUSION IS WHY `uncredentialed_share` EXISTS
 *
 * "Excluded because it predates the deploy" was true of the events, and false
 * of the claim it was resting on. #5719's own docstring said it had given the
 * field to every `unsubscribe_link` event; it had given it to ONE of the two
 * writers. `services/newsletterSubscribers.ts` — the SPA "Disiscriviti" write,
 * added by #5690 four hours and fifty minutes EARLIER the same afternoon —
 * emitted the same event on the same channel with no `credential` key at all,
 * and nothing here could tell that apart from pre-deploy residue.
 *
 * Measured read-only against production, 7 days to 2026-08-18, 209
 * `unsubscribe_link` events:
 *
 *   email_token                 110   (Cloud Function, credentialed)
 *   autologin_code                1   (Cloud Function, credentialed)
 *   missing, Cloud-Function shape 46   ALL on 08-11/08-12, none after → real
 *                                      pre-#5719 residue, ages out on its own
 *   missing, SPA-writer shape     52   EVERY day from 08-13 to 08-18 → not
 *                                      residue: a writer the field never
 *                                      reached
 *
 * The two are separable by field signature (the SPA writer emits
 * `user_id`/`metadata`/`source_page`; the function emits
 * `unsubscribe_ip`/`unsubscribe_method`), and the split is clean: 46 + 52,
 * with the boundary exactly at the deploy. So the monitor was grading 111 of
 * 163 post-deploy events and calling the answer 0,90%, while the 52 it dropped
 * were — by construction, see App.tsx — `ac`-authorised exits, i.e. the
 * population it was built to size. `uncredentialed_share` is the finding that
 * refuses to make that mistake silently a second time: a `missing` share this
 * large now says so out loud instead of quietly shrinking the denominator.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * Same reasoning as scripts/lib/autologinRefusalMetrics.mjs, its twin for
 * `exchange_auth_code` refusals: `check-unsubscribe-credential-rate.mjs`
 * holds a service account and talks to Firestore, none of which is
 * testable or where the decision lives. The decision — "is this fallback
 * rate the one that means somebody should look" — is pure arithmetic over
 * already-read event records, so it lives here where
 * `tests/unsubscribe-credential-metrics.test.ts` pins it against fixtures.
 */

/** The `source_channel` of the credentialed unsubscribe paths. TWO writers
 *  emit it, not one — functions/src/newsletterSubscriptionManagement.js
 *  (`action === 'unsubscribe'`, the RFC 8058 one-click and the session-less
 *  fallback) and services/newsletterSubscribers.ts
 *  (`unsubscribeNewsletterSubscriber`, the SPA "Disiscriviti" write driven by
 *  App.tsx). Both set `credential`; that they must is pinned by
 *  tests/newsletter-unsubscribe-integrity.test.ts, which runs both and
 *  compares the events. Other channels — bulk LPD requests, lost-unsubscribe
 *  recovery, the logged-in account settings page's own
 *  `subscription_unsubscribed` event — never authenticate a credential and
 *  never carry one; folding them into the denominator would look identical to
 *  `credential` disappearing from the paths that do set it. */
export const CREDENTIAL_LINK_CHANNEL = 'unsubscribe_link';

/**
 * Alert thresholds, expressed as a share of graded (credentialed) unsubscribes.
 *
 * Anchored to measured volume (read-only Firestore sample, 2026-08-14): the
 * `unsubscribe_link` channel served roughly 20-50 credentialed events over
 * the most recent 7-day window, with `autologin_code` at 0/20 — i.e. nobody
 * observed yet needed the fallback. That is a MUCH smaller population than
 * `exchange_auth_code`'s 335-502/day (the sibling monitor's anchor), so the
 * percentage thresholds are set higher and the sample floor lower: a
 * single-digit count out of ~20-50 is already double digits as a
 * percentage, and this monitor should not fire on ordinary noise at that
 * scale.
 */
export const FALLBACK_RATE_WARN = 0.10;
export const FALLBACK_RATE_URGENT = 0.25;

/**
 * Below this many graded (credentialed) events in the window, no rate is
 * reported. At n=5 a single autologin_code event is already 20% — loud and
 * uninformative. 20 is roughly a week of this channel's current volume, so
 * a real change is still visible within days, not months.
 */
export const MIN_SAMPLE = 20;

/**
 * Share of `missing` (uncredentialed) events in the window above which the
 * monitor says so instead of quietly narrowing its denominator.
 *
 * 20% and not 10%: the honest `missing` population — Cloud Function events
 * written before #5719 deployed — drains out of a 7-day window within a week
 * of that deploy, so a steady share above a fifth is a WRITER, not residue.
 * The real one measured 52/163 = 32% and sat there day after day (see the
 * header). Set at 10% this finding would fire on the last legitimate day of
 * the residue and be dismissed as noise, which is how a real one gets ignored.
 */
export const UNCREDENTIALED_SHARE_WARN = 0.20;

/** @returns {'autologin_code'|'email_token'|'legacy_auth_token'|'missing'} */
export function classifyCredential(value) {
  if (value === 'autologin_code') return 'autologin_code';
  if (value === 'email_token') return 'email_token';
  // The `at`/`authToken` Firebase custom token of the pre-`ac` link shape
  // (services/newsletterAutologinSignal.ts still parses it). A third primary
  // credential, neither the email HMAC nor the `ac` — graded, because it is a
  // credential somebody's exit actually rode, and a denominator that dropped
  // it would understate the population exactly the way `missing` did.
  if (value === 'legacy_auth_token') return 'legacy_auth_token';
  return 'missing';
}

/**
 * Fold parsed unsubscribe-link event records (`{credential}`) into the shape
 * the report and the alert both read.
 */
export function aggregate(records) {
  const counts = { autologin_code: 0, email_token: 0, legacy_auth_token: 0, missing: 0 };
  for (const rec of records || []) {
    if (!rec) continue;
    counts[classifyCredential(rec.credential)] += 1;
  }
  const graded = counts.autologin_code + counts.email_token + counts.legacy_auth_token;
  const total = graded + counts.missing;
  return {
    counts,
    graded,
    total,
    uncredentialedShare: total === 0 ? null : counts.missing / total,
    fallbackRate: fallbackRate({ counts }),
  };
}

/**
 * autologin_code / (every credentialed event).
 *
 * `null`, not 0, when there is nothing graded to divide: an empty window is
 * not a perfect score (see aggregate()'s docstring on `missing`) — the same
 * "silence looks like success" trap the sibling monitor's `lockoutRate`
 * guards against.
 */
export function fallbackRate(agg) {
  const c = agg?.counts || {};
  const denom = (c.autologin_code || 0) + (c.email_token || 0) + (c.legacy_auth_token || 0);
  if (denom === 0) return null;
  return (c.autologin_code || 0) / denom;
}

/**
 * Turn an aggregate into findings, each with the priority the issue should
 * carry. Priorities match `github-issue-creator.mjs`: 1 = urgent, 2 = high,
 * 3 = low.
 *
 * @param {ReturnType<typeof aggregate>} agg
 * @param {{baselineIsZero?: boolean}} [opts] `baselineIsZero` — has an
 *   `autologin_code` fallback EVER been observed in prior history? Mirrors
 *   the sibling monitor's zero-baseline finding: the first occurrence is a
 *   state change worth a (low-priority) line, well before it is a
 *   percentage worth paging over.
 */
export function evaluate(agg, { baselineIsZero = true } = {}) {
  const findings = [];
  const counts = agg?.counts || {};
  const graded = agg?.graded ?? 0;
  const total = agg?.total ?? 0;
  const rate = agg?.fallbackRate ?? null;

  // A window with zero `unsubscribe_link` events (credentialed or not) means
  // either nobody unsubscribed via the email link in the window (plausible
  // only for a short window at this channel's volume) or the query/filter
  // itself broke. Distinguishing those needs a human, so this reports,
  // never silently passes as "0% fallback rate".
  if (total === 0) {
    return {
      findings: [{
        code: 'no_signal',
        priority: 2,
        alert: true,
        message: 'Zero eventi `unsubscribe` con source_channel `unsubscribe_link` nella finestra: query cambiata, canale morto, o davvero nessun click nella finestra — non distinguibile senza guardare.',
      }],
      alert: true,
      priority: 2,
    };
  }

  // ── The denominator has to defend itself (#5719's false claim) ──────────
  //
  // Every finding below divides by `graded`, and `graded` is whatever is left
  // after `missing` has been dropped. That drop is only safe while `missing`
  // means "written before #5719 deployed" — a set that shrinks to nothing
  // within a window's length. When it does NOT shrink, the drop is not
  // hygiene, it is a writer that never learned to stamp the field, and every
  // percentage under it is computed on half a population while looking
  // exactly as calm as a healthy one. That is what happened, for six days,
  // and no finding existed that could say it.
  const uncredentialed = agg?.uncredentialedShare ?? null;
  if (total >= MIN_SAMPLE && uncredentialed !== null && uncredentialed >= UNCREDENTIALED_SHARE_WARN) {
    findings.push({
      code: 'uncredentialed_share',
      priority: 2,
      alert: true,
      message: `${counts.missing} dei ${total} eventi \`${CREDENTIAL_LINK_CHANNEL}\` della finestra non hanno il campo \`credential\` (${pct(uncredentialed)} ≥ ${pct(UNCREDENTIALED_SHARE_WARN)}): sopra questa quota non è più residuo pre-#5719 — è un writer che non lo scrive, e la quota fallback qui sotto è calcolata su ${graded} eventi invece che su ${total}. I due writer del canale sono functions/src/newsletterSubscriptionManagement.js e services/newsletterSubscribers.ts: guarda la firma dei campi degli eventi scoperti (\`user_id\`/\`metadata\`/\`source_page\` = writer SPA, \`unsubscribe_ip\`/\`unsubscribe_method\` = Cloud Function) per sapere quale.`,
    });
  }

  if (graded < MIN_SAMPLE) {
    findings.push({
      code: 'insufficient_sample',
      priority: 3,
      alert: false,
      message: `Solo ${graded} unsubscribe con \`credential\` valorizzato nella finestra (soglia ${MIN_SAMPLE}, su ${total} eventi totali): nessun rapporto calcolato.`,
    });
  } else if (rate !== null) {
    if (rate >= FALLBACK_RATE_URGENT) {
      findings.push({
        code: 'fallback_rate_urgent',
        priority: 1,
        alert: true,
        message: `Quota fallback \`autologin_code\` ${pct(rate)} ≥ ${pct(FALLBACK_RATE_URGENT)} su ${graded} unsubscribe graduati: il token primario sta fallendo su una fetta larga di disiscrizioni.`,
      });
    } else if (rate >= FALLBACK_RATE_WARN) {
      findings.push({
        code: 'fallback_rate_warn',
        priority: 2,
        alert: true,
        message: `Quota fallback \`autologin_code\` ${pct(rate)} ≥ ${pct(FALLBACK_RATE_WARN)} su ${graded} unsubscribe graduati: da guardare prima del flip della TTL su \`ac\` (#5724).`,
      });
    } else if (counts.autologin_code > 0 && baselineIsZero) {
      findings.push({
        code: 'first_fallback_after_zero_baseline',
        priority: 3,
        alert: true,
        message: `Primi ${counts.autologin_code} unsubscribe risolti solo dal fallback \`autologin_code\` (${pct(rate)}) mai osservati: da tenere d'occhio.`,
      });
    }
  }

  const alerting = findings.filter((f) => f.alert);
  return {
    findings,
    alert: alerting.length > 0,
    priority: alerting.length ? Math.min(...alerting.map((f) => f.priority)) : 3,
  };
}

export function pct(value) {
  if (value === null || value === undefined) return 'n/d';
  return `${(value * 100).toFixed(2)}%`;
}
