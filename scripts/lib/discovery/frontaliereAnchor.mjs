/**
 * Frontaliere anchor regex set — high-precision tokens that signal a news
 * headline has a direct nexus with the cross-border (Ticino-Italia) worker
 * domain.
 *
 * History — as of 2026-05-15 anchors are NO LONGER a fast-path that
 * short-circuits the classifier in `applyPreSpendTopicGate()`. Run
 * #25889568431 showed the fast-path was too permissive: a URL containing
 * "frontaliere" as a noun-adjective (e.g. cronaca/multa stories) matched
 * an anchor and bypassed the cheap LLM step, only to be rejected by
 * REGOLA #0 post-generation — burning ~25 min and ~150 model calls. Now
 * EVERY candidate is classified; anchors remain available as a negative
 * signal hint to feed into the classifier, or as a legacy fallback under
 * the emergency rollback env (`PRESPEND_TOPIC_GATE_CLASSIFIER=0`).
 *
 * Anchor design — narrower than the upstream `TOPICAL_KEYWORDS` list
 * (which is intentionally permissive — it just needs to keep enough
 * candidates flowing). These anchors must be:
 *   - frontaliere-specific (NOT "any Ticino municipality"),
 *   - case-insensitive (Italian editorial titles vary case freely),
 *   - anchored on a word boundary where it does not break Italian
 *     compound matching ("transfrontaliero" needs partial match — the
 *     `\b` goes BEFORE the stem, not after).
 *
 * If you add a new anchor, run `tests/pre-spend-topic-gate.test.ts` to
 * confirm it still rejects the cronaca-nera fixtures.
 */

export const FRONTALIERE_STRICT_ANCHORS = [
  /\bfrontalier/i,                   // frontaliere/i/o, frontalierato
  /\btransfrontalier/i,              // transfrontaliero/a/i/e
  /\bpendolar[ie]\b/i,               // pendolari/pendolare (alone is too noisy → \b)
  /\bcross[- ]border\b/i,
  /\bgrenzg[äa]nger/i,
  /\bpermess[oi]\s+[bgcdl]\b/i,      // permesso b/g/c/d/l
  /\bristorn[oi]\b/i,                // ristorni/ristorno
  /\bimposta\s+alla\s+fonte\b/i,
  /\bdoppia\s+imposizion/i,
  /\baccordo\s+(?:fiscale|bilaterale)\s+(?:italia[- ]svizzera|ch[- ]it|cra)/i,
  /\bnuovo\s+accordo\s+fiscale/i,
  /\b(?:tassa|imposta)\s+salute\b/i, // tassa salute frontalieri
  /\b(?:lamal|cassa\s+malati)\b/i,
  /\b(?:avs|ahv)\b/i,
  /\blpp\b/i,
  /\b(?:secondo|terzo)\s+pilastro\b/i,
  /\bbusta\s+paga\s+svizzer/i,
  /\bstipendi[oi]\s+svizzer/i,
  /\bnetto\s+svizzer/i,
  /\bvalico\s+(?:di\s+)?(?:brogeda|gaggiolo|ponte\s+tresa|chiasso|stabio)/i,
  /\bdogana\s+(?:di\s+)?(?:chiasso|brogeda|gaggiolo|ponte\s+tresa|stabio)/i,
  /\btelelavoro\s+frontalier/i,
  /\bmercato\s+del\s+lavoro\s+ticines/i,
  /\baziende?\s+che\s+assumon[oa]\s+frontalier/i,
  /\bcambio\s+(?:chf|franco|eur)/i,
  /\beur\s*\/\s*chf|chf\s*\/\s*eur/i,
  /\btotalizzazione\s+(?:dei\s+)?contributi\b/i,   // INPS/AVS pension coordination term-of-art
  /\bquadro\s+ce\b/i,                              // 730 foreign-income credit section used by frontalieri
  /\binps\b.{0,60}\b(?:frontalier|svizzer|ticino|avs|ahv)\b/i,
  /\b(?:frontalier|svizzer|ticino|avs|ahv)\b.{0,60}\binps\b/i,
  /\bagenzia\s+(?:delle\s+)?entrate\b.{0,60}\bfrontalier/i,
  /\bfrontalier.{0,60}\bagenzia\s+(?:delle\s+)?entrate\b/i,
];

/**
 * Returns the first matched substring if any anchor hits `text`, else null.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function matchesFrontaliereAnchor(text) {
  if (!text || typeof text !== 'string') return null;
  for (const re of FRONTALIERE_STRICT_ANCHORS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

/**
 * Unambiguous frontaliere anchors — strict subset that CANNOT appear outside
 * a frontaliere-policy / fiscal / regulatory context. These bypass the
 * pre-spend classifier safely (re-introduced 2026-05-26 after run
 * 26440805420: gemini-flash-lite was rejecting 100% of pre-filtered
 * candidates, no_changes streak hit 8, fallback Google News RSS could not
 * resolve URLs because the proven pool went empty).
 *
 * Excluded vs FRONTALIERE_STRICT_ANCHORS — these are the patterns that leak
 * into cronaca/sports/general news (origin of the 2026-05-15 rollback):
 *   - bare `\bfrontalier/i`        — cittadino frontaliere multato, …
 *   - bare `\btransfrontalier/i`   — area transfrontaliera, …
 *   - bare `\bpendolar[ie]\b/i`    — any commuter, not just italo-svizzeri
 *   - bare `\bcross[- ]border\b/i` — generic; matches IT outside TI
 *   - `valico`/`dogana` municipality variants — kept in strict for ranking
 *     but cronaca leaks (incidenti in dogana, etc.)
 *   - bare `\bcambio\s+(?:chf|franco|eur)/i` — finanza market chatter
 *
 * Anything kept here must be a term-of-art for the frontaliere fiscal /
 * social-security / cross-border-employment domain.
 */
export const FRONTALIERE_UNAMBIGUOUS_ANCHORS = [
  /\bristorn[oi]\b/i,
  /\bimposta\s+alla\s+fonte\b/i,
  /\bdoppia\s+imposizion/i,
  /\baccordo\s+(?:fiscale|bilaterale)\s+(?:italia[- ]svizzera|ch[- ]it|cra)/i,
  /\bnuovo\s+accordo\s+fiscale/i,
  /\b(?:tassa|imposta)\s+salute\b/i,
  /\b(?:lamal|cassa\s+malati)\b/i,
  /\b(?:avs|ahv)\b/i,
  /\blpp\b/i,
  /\b(?:secondo|terzo)\s+pilastro\b/i,
  /\bbusta\s+paga\s+svizzer/i,
  /\bstipendi[oi]\s+svizzer/i,
  /\bnetto\s+svizzer/i,
  /\bpermess[oi]\s+[bgcdl]\b/i,
  /\btelelavoro\s+frontalier/i,
  /\bmercato\s+del\s+lavoro\s+ticines/i,
  /\baziende?\s+che\s+assumon[oa]\s+frontalier/i,
  /\beur\s*\/\s*chf|chf\s*\/\s*eur/i,
  /\binps\b.{0,60}\b(?:frontalier|svizzer|ticino|avs|ahv)\b/i,
  /\b(?:frontalier|svizzer|ticino|avs|ahv)\b.{0,60}\binps\b/i,
  /\bagenzia\s+(?:delle\s+)?entrate\b.{0,60}\bfrontalier/i,
  /\bfrontalier.{0,60}\bagenzia\s+(?:delle\s+)?entrate\b/i,
];

/**
 * Returns the first matched substring if any unambiguous anchor hits `text`,
 * else null. Safe for pre-spend classifier bypass.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function matchesFrontaliereUnambiguousAnchor(text) {
  if (!text || typeof text !== 'string') return null;
  for (const re of FRONTALIERE_UNAMBIGUOUS_ANCHORS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}
