// scripts/lib/redditAutomationPolicy.mjs
//
// Who automated Reddit posting is allowed to target, and why that is not a
// question `data/reddit-subreddits.json` gets to answer on its own.
//
// THE HOLE THIS CLOSES (issue #5008).
//
// Automated submission ran through exactly one guard: the boolean
// `subreddits[name].allowsAutomation` in a JSON data file. Today only
// `r/frontaliere` — a community we moderate — has it set. A one-character edit
// to that file, by anyone, in a commit that looks like data and not like code,
// pointed the daily cron at r/Ticino, r/italiansinswitzerland and r/Svizzera.
//
// That is not a hypothetical severity. Posting automation into communities
// that have not approved it is spam: it earns a community ban, it burns the
// brand, and in the worst case it attaches spam signals to the whole domain —
// the exact opposite of the organic-traffic goal the automation exists to
// serve. And it is irreversible in the way that matters: you cannot un-post to
// a few thousand subscribers.
//
// So the decision is moved OUT of the data file. Enabling a third-party
// subreddit now requires editing THIS list, in code, with the moderator
// approval recorded next to the name — a diff a reviewer reads as a policy
// change, which is what it is. `allowsAutomation` keeps its meaning (an
// operator switch to turn a permitted sub off, or on again), it just stops
// being sufficient on its own.
//
// Both entry points import from here so the two copies of the gate cannot
// drift: `scripts/schedule-reddit-jobs-daily.mjs` (cron) and
// `scripts/post-to-reddit.mjs` (post-deploy). Before this module they were
// two independent implementations of the same filter — one exported and
// tested, one private and untested.

/**
 * Subreddits this project moderates, i.e. where we set the rules and posting
 * automation is ours to authorise.
 *
 * To add a THIRD-PARTY subreddit here you need moderator approval, and the
 * evidence belongs in the comment next to the entry: who approved it, when,
 * and where the approval is recorded. "The audience fit is good" is not
 * approval. "The rules page does not explicitly forbid it" is not approval.
 *
 * Keep this in sync with the `notes` field in `data/reddit-subreddits.json`,
 * which is documentation; this list is the enforcement.
 */
export const AUTOMATION_APPROVED_SUBREDDITS = Object.freeze({
  // Own community, moderated by us — we set the rules.
  frontaliere: 'own community (moderated by this project)',
  // Own community, moderated by us. Currently allowsAutomation:false in the
  // data file; policy permits it, the operator switch is simply off.
  FrontaliereTicino: 'own community (moderated by this project)',
});

/** @param {string} name */
export function isAutomationApproved(name) {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_APPROVED_SUBREDDITS, name);
}

/**
 * Subreddits the data file enables but policy refuses.
 *
 * Surfaced rather than silently dropped: a config that asks for something the
 * policy denies is a mistake someone should see in the run log, not a no-op.
 *
 * @param {object} config parsed reddit-subreddits.json
 * @returns {string[]} sorted subreddit names
 */
export function policyBlockedSubreddits(config) {
  const subs = config?.subreddits && typeof config.subreddits === 'object' ? config.subreddits : {};
  return Object.keys(subs)
    .filter((name) => subs[name]?.allowsAutomation === true && !isAutomationApproved(name))
    .sort();
}

/**
 * Resolve the subreddits automation may post to for a topic, in routing order.
 *
 * A subreddit qualifies only when BOTH hold:
 *   1. the data file has `allowsAutomation === true` (the operator switch), and
 *   2. it appears in {@link AUTOMATION_APPROVED_SUBREDDITS} (the policy).
 *
 * @param {object} config parsed reddit-subreddits.json
 * @param {string} topic e.g. 'jobs' | 'articles'
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {Array<{ name: string, config: object }>}
 */
export function automationEligibleSubs(config, topic, opts = {}) {
  const warn = opts.warn ?? ((msg) => console.warn(msg));
  const routed = Array.isArray(config?.routing?.[topic]) ? config.routing[topic] : [];

  const blocked = [];
  const out = [];
  for (const name of routed) {
    const sub = config?.subreddits?.[name];
    if (!sub || sub.allowsAutomation !== true) continue;
    if (!isAutomationApproved(name)) {
      blocked.push(name);
      continue;
    }
    out.push({ name, config: sub });
  }

  if (blocked.length > 0) {
    warn(
      `⚠️  reddit automation policy: refusing ${blocked.length} subreddit(s) that ` +
        `data/reddit-subreddits.json enables but policy does not approve: ${blocked.join(', ')}. ` +
        'Posting automation into a community that has not approved it is spam. ' +
        'To permit one, add it to AUTOMATION_APPROVED_SUBREDDITS in ' +
        'scripts/lib/redditAutomationPolicy.mjs with the moderator approval recorded.',
    );
  }

  return out;
}
