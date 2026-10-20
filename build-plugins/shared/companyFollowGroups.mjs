/**
 * Company follow groups: one employer published under several profile slugs.
 *
 * The crawler can label the same employer with more than one display name. The
 * Coop crawler (`companyKey: coop-ticino`) publishes about half of its jobs as
 * «Coop» and half as «Coop Genossenschaft», so the canonical profile slug
 * splits them into `coop` and `coop-genossenschaft`. A company alert pinned to
 * one slug therefore matched only half of the employer's jobs.
 *
 * Owner decision (2026-10-05): «chi segue coop segue entrambi». Following any
 * member of a group follows every member.
 *
 * This is deliberately NOT a brandCanonicalMap.mjs alias. That map also folds
 * the public SEO surfaces (company hubs, city hubs, `/aziende/<slug>/`
 * profiles, sitemap), turning the alias pages into bridges. A follow group
 * changes only the follow identity: the persisted `specificCompanyKey` stays
 * the slug of the page the user followed, and the group is resolved when an
 * alert is matched, deduplicated or looked up.
 *
 * Consumers (one module, no copies):
 *   - services/jobAlertMatching.mjs `canonicalCompanyToken`, the pinned-company
 *     comparison used by BOTH senders (send-company-alerts.mjs, send-job-alerts.mjs);
 *   - scripts/send-company-alerts.mjs, cross-alert dedup inside one recipient;
 *   - services/jobAlertService.ts `findCompanyAlert` / `createAlert` and
 *     services/userAlertsCache.ts, so a group has one follow;
 *   - services/employerSuggestions.ts, which never suggests a group member of
 *     an employer the user already follows.
 * The Cloud Functions bundle cannot import this file: its deployment-boundary
 * mirror in functions/src/newsletterSubscriptionManagement.js is parity-tested
 * by tests/company-alert.test.ts.
 *
 * Rules: members are canonical profile slugs (already brand-folded), the first
 * member is the group key, and a slug belongs to at most one group.
 */

/** @type {ReadonlyArray<ReadonlyArray<string>>} */
export const COMPANY_FOLLOW_GROUPS = Object.freeze([
  // Same crawler, same employer, two display names (measured 2026-10-05 on
  // data/jobs/by-crawler/coop-ticino.json: «Coop» 816, «Coop Genossenschaft» 787).
  Object.freeze(['coop', 'coop-genossenschaft']),
]);

/** member slug → group key (first member). */
const GROUP_KEY_BY_MEMBER = (() => {
  const map = new Map();
  for (const group of COMPANY_FOLLOW_GROUPS) {
    if (group.length < 2) {
      throw new Error(`[companyFollowGroups] Group "${group[0]}" needs at least two members.`);
    }
    for (const member of group) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(member)) {
        throw new Error(`[companyFollowGroups] Member "${member}" is not a canonical slug.`);
      }
      if (map.has(member)) {
        throw new Error(`[companyFollowGroups] Member "${member}" belongs to two groups.`);
      }
      map.set(member, group[0]);
    }
  }
  return map;
})();

/**
 * Group key of a canonical company slug; an ungrouped slug is its own key.
 *
 * @param {string} slug Canonical profile slug (`specificCompanyKey` shape).
 * @returns {string}
 */
export function companyFollowGroupKey(slug) {
  const s = String(slug || '');
  return GROUP_KEY_BY_MEMBER.get(s) || s;
}

/**
 * Every slug followed together with `slug` (itself included).
 *
 * @param {string} slug
 * @returns {string[]}
 */
export function companyFollowGroupMembers(slug) {
  const s = String(slug || '');
  if (!s) return [];
  const key = GROUP_KEY_BY_MEMBER.get(s);
  if (!key) return [s];
  return [...(COMPANY_FOLLOW_GROUPS.find((group) => group[0] === key) || [s])];
}

/**
 * True when following `a` and following `b` are the same follow.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameCompanyFollowGroup(a, b) {
  if (!a || !b) return false;
  return companyFollowGroupKey(a) === companyFollowGroupKey(b);
}
