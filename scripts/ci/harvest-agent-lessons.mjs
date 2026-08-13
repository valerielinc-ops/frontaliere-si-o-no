#!/usr/bin/env node
// Lessons harvester — DETERMINISTIC aggregator (zero Claude).
//
// Scans recent reviewer findings, recurring issue classes and issue-fix
// outcomes, buckets them by a fixed taxonomy, drops anything already covered by
// the doc-contracts (AGENTS.md / ISSUES.md / REVIEW.md / FOLLOWUP.md), and
// emits the surviving "novel recurring" clusters. The weekly/daily workflow
// only spends a Claude turn when this script reports has_novel=true, so the
// common (nothing-new) day costs zero model tokens.
//
// Output:
//   - writes clusters JSON to $HARVEST_OUT (default: harvest-clusters.json)
//   - prints a human summary to stdout
//   - appends `has_novel=<bool>` and `novel_count=<n>` to $GITHUB_OUTPUT
//
// Env knobs: WINDOW_DAYS (14), THRESHOLD (3), MAX_PRS (40), MAX_ISSUES (120).
//
// Pure helpers (detectSeverity / tallyFindings / bucketFinding / issueClass /
// severityLabelForCount / parseEscalationKey) are exported and unit-tested; the
// gh-scanning + escalation-emit side effects live in main(), run only when this
// file is invoked as a script (guard at bottom) so importing it is free.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { FALSE_POSITIVE_DECLARATION_RE } from './lib/false-positive-declaration.mjs';

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 14);
const THRESHOLD = Number(process.env.THRESHOLD || 3);
const MAX_PRS = Number(process.env.MAX_PRS || 40);
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 120);
const OUT = process.env.HARVEST_OUT || 'harvest-clusters.json';
// EFFICACY_FACTOR: a documented pattern that STILL recurs at ≥ THRESHOLD×factor
// is evidence the prose rule isn't preventing the mistake → escalate to a
// structural fix instead of writing another line nobody follows.
const EFFICACY_FACTOR = Number(process.env.EFFICACY_FACTOR || 2);

const sinceMs = Date.now() - WINDOW_DAYS * 86_400_000;
const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    process.stderr.write(`gh ${args.join(' ')} failed: ${err.message}\n`);
    return '';
  }
}
function ghJson(args) {
  const raw = gh(args).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- Reviewer-finding taxonomy: stable buckets via regex on finding text. ----
// Each finding (a 🔴/🟡/❓ line in a reviewer review body) maps to ONE bucket so
// recurrence is countable without fuzzy NLP. `docKeys` are substrings searched
// in the doc corpus to decide "already documented".
//
// Two finding FAMILIES live here:
//   - TOPIC buckets (structured-data, cls, auto-ads, …): "agent shipped wrong
//     code about <domain>". Adding a NEW doc rule fixes these.
//   - PROCESS-failure-mode buckets (pr-body-contract, sibling-class-fix,
//     unvalidated-claim, stale-comment): "agent repeats a meta-mistake". These
//     are usually ALREADY documented, so they never surface as `novel`. They
//     matter via the EFFICACY signal instead: documented-but-still-recurring →
//     `recurringDespiteRule` → the prose rule isn't working → escalate to a
//     STRUCTURAL fix (template / CI gate / shared module), not another line.
//     (These 4 buckets were the harvester's blind spot until 2026-06-04.)
const TAXONOMY = [
  { key: 'structured-data', re: /structured data|json-?ld|basesalary|postalcode|hiringorganization|jobposting/i, docKeys: ['structured data', 'json-ld', 'basesalary'] },
  { key: 'missing-test-funnel', re: /missing test|test mancant|no test|senza test|test coverage/i, docKeys: ['test coverage', 'test mancant', 'senza test'] },
  { key: 'time-bomb-hardcoded', re: /hardcoded|time-?bomb|absolute date|aged? out|invecchia|date assolut/i, docKeys: ['date assolut', 'time-bomb', 'daysago'] },
  { key: 'cls-layout', re: /\bcls\b|layout shift|reflow|reserve space|min-h-|aspect-ratio/i, docKeys: ['cls', 'reserve space', 'layout shift'] },
  { key: 'auto-ads', re: /auto ?ads|adsense|anchor ad|vignette|in-page ad/i, docKeys: ['auto ads', 'adsense'] },
  { key: 'canonical-sitemap', re: /canonical|sitemap|noindex|cross-section/i, docKeys: ['canonical', 'sitemap', 'noindex'] },
  { key: 'workflow-scope-creds', re: /workflows? scope|github_pat|\bpat\b|credential|secret|branch protection|push.*workflow/i, docKeys: ['workflows`', 'capability-guard', 'github_pat'] },
  // i18n-NAMING: genuine naming/i18n defects only — locale URL segments, translated
  // brand names, canton-aware slug naming, missing/untranslated keys. The old regex
  // `/locale|i18n|translat|canton-?aware|naming|brand/i` was far too loose: the bare
  // `translat` swallowed the ENTIRE translate pipeline (a high-volume active area),
  // `naming` matched any "naming" (e.g. ad-container naming), `brand` matched
  // "branded"/"branding" — so heterogeneous, unrelated findings false-clustered here
  // and tripped a phantom `recurringDespiteRule` escalation (issue #2122, 15 hits / 0
  // real naming defects). Deliberately NO replacement topic-bucket for the translate
  // pipeline: those findings are genuine process-failures (unvalidated-claim,
  // sibling-class-fix, pr-body-contract) and now route to THOSE buckets, or fall to
  // the fingerprint safety-net — which clusters only on truly-repeated lead-phrases.
  { key: 'i18n-naming', re: /locale segment|locale-?prefix|canton-?aware (slug|naming|url)|translated? brand|brand.*translat|translation key|missing (locale|translation)|untranslated/i, docKeys: ['locale', 'i18n', 'canton-aware'] },
  { key: 'router-nav', re: /router|parsepath|staticoverlay|window\.location/i, docKeys: ['router', 'staticoverlay', 'parsepath'] },
  // PROCESS-failure-mode buckets (see family note above):
  { key: 'pr-body-contract', re: /implementato|non implementato|completeness contract|sezioni? (obbligatori|mancant)|## fix\b|## verify\b/i, docKeys: ['completeness contract', 'non implementato'] },
  { key: 'sibling-class-fix', re: /stesso anti-?pattern|file gemello|stesso costrutto|sibling|non toccat|class-complete/i, docKeys: ['file gemello', 'stesso anti', 'class-complete'] },
  { key: 'unvalidated-claim', re: /claim.*(non validat|unvalidated|speculativ)|non validat.*pre-?merge|atteso\s+green|revert-?trigger|sufficienza speculativa/i, docKeys: ['non validat', 'revert-trigger', 'speculativ'] },
  { key: 'stale-comment', re: /stale (comment|doc)|comment(o|i)? stale|docblock stale|descrive ancora|title.*(contraddice|stale)|commento.*vecchio/i, docKeys: ['stale comment', 'docblock', 'descrive ancora'] },
];

// Catch-all fingerprint: when a finding matches NO taxonomy bucket, don't drop
// it silently (the old behaviour that hid the 4 process classes above). Derive a
// deterministic fingerprint from the first few CONTENT words (stopwords, emoji,
// severity labels, code spans, paths and digits stripped) so genuinely-NEW
// recurring phrasings still cluster and surface for human review. Coarse by
// design: it catches stable lead-phrases ("manca la sezione…", "claim non…"),
// not every paraphrase — a safety net, not a classifier.
const STOPWORDS = new Set(['the', 'a', 'an', 'di', 'la', 'il', 'le', 'lo', 'un', 'una',
  'e', 'ed', 'o', 'in', 'su', 'per', 'con', 'da', 'del', 'della', 'dei', 'delle', 'al',
  'non', 'che', 'è', 'this', 'is', 'to', 'of', 'and', 'or', 'no', 'nel', 'nella']);
function fingerprintFinding(text) {
  const words = text
    .toLowerCase()
    .replace(/[🔴🟡🟣❓]/g, ' ')
    .replace(/`[^`]*`/g, ' ')          // code spans (file paths, symbols, values)
    .replace(/\b(important|nit|q|pre-existing|process)\b/gi, ' ') // severity labels
    .replace(/[#/].*?(\s|$)/g, ' ')    // headings, paths
    .replace(/[^a-zàèéìòù\s-]+/gi, ' ') // punctuation, digits
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const lead = words.slice(0, 4);
  return lead.length >= 3 ? `fp:${lead.join('-')}` : null; // too short → still drop
}
// ---- `pr-body-contract` false-positive guard (DETERMINISTIC) ----------------
// The `pr-body-contract` regex matches the contract VOCABULARY (`## Implementato`,
// `## Non implementato`, `completeness contract`, …), but a reviewer line mentions
// that vocabulary in four distinct senses, only ONE of which is a recurring agent
// mistake worth escalating:
//   (a) GENUINE violation — a section is missing/empty/incomplete, or a `Closes`
//       multi-issue line, or `## Implementato` makes a false/unverified claim.
//       This is the escalation target.
//   (b) AFFIRMATION — the reviewer states the contract is fine ("sezioni presenti
//       e sensate", "completeness contract OK", "## Implementato accurato"). NOT a
//       defect; counting it inflates the bucket (#2397/#2396 examples).
//   (c) LOCATION LABEL — the finding is about a DIFFERENT topic (sibling count,
//       stale comment, CSS) and merely cites `PR body ## Implementato L2` /
//       `## Non implementato L1` as the line address. Those findings belong to
//       their own bucket (sibling-class-fix / stale-comment), reached via the
//       fingerprint net or another taxonomy entry — not pr-body-contract (#2409/
//       #2408 examples).
//   (d) PRESCRIPTION REFERENCE — the reviewer prescribes what to ADD to
//       ## Non implementato / ## Implementato as a remediation suggestion ("dichiara
//       nel ## Non implementato il revert-risk", "listare in Non implementato il
//       provider"). The section itself is not flagged as broken; the vocabulary
//       appears only as the write-target of a suggested fix. Counting these inflates
//       the bucket with non-violations (#2836/#2840 examples: code findings that
//       mention ## Non implementato only as a remediation slot).
// Crucially the deterministic gate `pr-body-contract.yml` ALREADY enforces section
// PRESENCE (`hasImpl`/`hasNon`, multi-issue `Closes`) — the structural fix for
// missing-section violations already shipped. The bucket's recurrence is dominated
// by (b)/(c)/(d) false positives. Only count (a). Pure → unit-tested.
//
// Same false-positive class as the `❓`/per-line dedup fixes in tallyFindings and
// the `already-fixed` avoidability classifier: don't escalate non-defects.
// Explicit "the section/Closes is broken" language → a real violation. Negation-
// aware on the affirmation side (below): "non rispettato" must NOT read as "ok".
const PR_BODY_CONTRACT_VIOLATION_RE =
  /\b(manca\w*|mancant\w*|assent\w*|vuot\w*|incomplet\w*|placeholder|tbd|stub|multi-?issue)\b|sezion\w*\s+obbligator\w*\s+(manca|assent)|non\s+(è\s+|e\s+)?(corrisponde|rispettat\w*|accurat\w*|coerent\w*|corrett\w*)|senza testo|n\/a|claim.*(?:non.*(diff|reale)|\bfalso\b|errat\w*|sbagliato\w*)|rivendicat\w*.*non\s+esiste|una riga sola/i;
// Positive contract-state words. Only an AFFIRMATION when NOT negated by a
// preceding "non " (so "non rispettato" / "non accurato" are not swallowed here).
const PR_BODY_CONTRACT_AFFIRM_RE =
  /(?<!non\s)\b(ok|presenti|presente|sensate?|accurat\w*|coerent\w*|corrett\w*|completo|in regola|rispettat\w*)\b|nessun\w*\s+(problema|drift|violazione|scope drift)/i;
// Location-label tell: the finding cites `## Implementato`/`## Non implementato`
// (optionally prefixed "PR body", optionally with an L<n> line ref) only as the
// ADDRESS of a finding about another topic. Tolerant of arrows/quotes between
// "PR body" and the section, and of the section being quoted.
const PR_BODY_CONTRACT_LOCATION_RE =
  /pr body\b[^a-z]*#{0,3}\s*"?\s*(non\s+)?implementato\b|#{2,3}\s*(non\s+)?implementato\s+l?\d|"\s*#{2,3}\s*(non\s+)?implementato\s*"\s*l?\d/i;
// Prescription-reference tell: an imperative/infinitive suggestion verb followed
// (within the same sentence) by "in"/"nel" and then the section name. The
// reviewer is telling the author WHERE to write something, not flagging the
// section as broken. Bounded by sentence boundary ([^.]{0,150}) to prevent
// runaway cross-sentence matches. Case (a) still wins: if the explicit violation
// RE fires (e.g. "claim falso") the prescription filter is never reached.
const PR_BODY_CONTRACT_PRESCRIPTION_RE =
  /\b(?:aggiungi|inserisci|inserir[ei]|dichiara(?:re)?|elenc[ao](?:re)?|list[ao](?:re)?|menziona(?:re)?|nota(?:re)?|documenta(?:re)?|scrivi|scrivere|aggiorna(?:re)?|specifica(?:re)?|includi|includere)\b[^.]{0,150}\b(?:in|nel(?:la)?)\b[^.]{0,80}\b(?:non\s+)?implementato\b/i;
export function isGenuinePrBodyContractViolation(text) {
  const s = String(text || '');
  // (a) explicit violation language wins — a real missing/empty/mismatched section,
  //     a multi-issue Closes, or a false/unverified claim in ## Implementato.
  if (PR_BODY_CONTRACT_VIOLATION_RE.test(s)) return true;
  // (b) the line AFFIRMS the contract is fine (un-negated positive) → not a defect.
  if (PR_BODY_CONTRACT_AFFIRM_RE.test(s)) return false;
  // (c) section name used only as a `PR body ## X (L<n>)` location label for a
  //     finding about a different topic → not a contract defect.
  if (PR_BODY_CONTRACT_LOCATION_RE.test(s)) return false;
  // (d) the reviewer prescribes what to ADD to ## Non implementato / ## Implementato
  //     as a remediation suggestion — the section itself is not broken, the
  //     vocabulary appears only as the write-target. (#2836/#2840 pattern)
  if (PR_BODY_CONTRACT_PRESCRIPTION_RE.test(s)) return false;
  // Default: no affirmation, no location-label, no prescription → conservative:
  // keep as a genuine violation.
  return true;
}

// ---- `sibling-class-fix` false-positive guard (DETERMINISTIC) ---------------
// Same false-positive class as `isGenuinePrBodyContractViolation` above, applied
// to the OTHER process-failure-mode bucket the reviewer regex matches loosely on
// sweep vocabulary (`sibling`, `file gemello`, `stesso anti-pattern`, `non
// toccat[o]`, …). Unlike pr-body-contract (structural gate already blocks missing
// sections), `check-sibling-patterns.mjs` is a candidate-SURFACER with no
// enforcement — but the reviewer regex still can't tell these senses apart:
//   (a) GENUINE violation — a sibling file left un-swept still carries the SAME
//       antipattern the PR just fixed elsewhere (e.g. #3317: `.slice(0, 20)`
//       cap-trim fixed in one crawler, "resta intatto" in 7 siblings). This is
//       the escalation target. A divergent-but-deferred nit ("diverges from the
//       sibling's pattern — deferred, non funnel-critical", #3312) is STILL a
//       real finding here — AGENTS.md #8 abolished deferral-as-closure, so only
//       (b)/(c) below are excluded, never a plain "deferred".
//   (b) AFFIRMATION — the reviewer confirms the sibling sweep is COMPLETE / no
//       residual finding ("nessun sibling residuo", "no inconsistency", "coerente
//       col sibling", "correctly mirrors the sibling"). NOT a defect. Includes the
//       same emoji-as-word trap that inflated pr-body-contract (#2397/#2396): a
//       line like "nessun 🔴/🟡 da propagare" (#3319) contains the literal glyphs
//       `detectSeverity` substring-matches on, even though the sentence explicitly
//       says there is NOTHING to report.
//   (c) DECLARED FALSE POSITIVE — the reviewer explicitly invokes AGENTS.md #6's
//       own escape hatch: the construct is "solo lessicalmente simile ma
//       semanticamente diverso" / an explicit "falso positivo" — not the same bug
//       class, just a shared token.
// Issue #3325 (escalation ×6 in 14gg: #3319/#3317/#3312/#3267/#3265) — the bucket
// had no filter at all, unlike its pr-body-contract sibling shipped in #3332.
// Pure → unit-tested, mirrors isGenuinePrBodyContractViolation's structure.
const SIBLING_CLASS_AFFIRM_RE =
  /nessun\w*\s*(?:[\u{1F534}\u{1F7E1}]\s*\/?\s*)*(?:da propagare|altro finding|bug replicat\w*|antipattern replicat\w*)|nessun\s+sibling\s+resid\w*|no inconsistenc\w*|not a candidate for|correctly mirrors? the sibling|coerente\s+(?:col|con il)\s+sibling|match(?:es)?\s+the sibling'?s?\s+(?:proven\s+)?(?:pattern|guard)/iu;
// Negation-aware false-positive-declaration matcher, shared with
// sibling-check-gate.mjs's isDeclaredFalsePositive (issue #3367 — the two
// copies drifted when kept in sync by docstring promise only).
export function isGenuineSiblingClassViolation(text) {
  const s = String(text || '');
  // (c) explicit false-positive declaration wins first — a reviewer can declare
  //     lexical-vs-semantic mismatch even inside an otherwise alarming sentence.
  if (FALSE_POSITIVE_DECLARATION_RE.test(s)) return false;
  // (b) the line AFFIRMS the sweep is complete / nothing to propagate → not a
  //     defect, even if it contains 🔴/🟡 glyphs as prose rather than a marker.
  if (SIBLING_CLASS_AFFIRM_RE.test(s)) return false;
  // Default: no affirmation, no declared false positive → conservative: keep as
  // a genuine (possibly deferred-but-real) sibling-class finding.
  return true;
}

export function bucketFinding(text) {
  for (const t of TAXONOMY) {
    if (!t.re.test(text)) continue;
    // pr-body-contract: drop affirmations / location-label false positives so the
    // bucket counts only genuine contract violations (the deterministic gate
    // pr-body-contract.yml already blocks missing sections). Falls through to the
    // next matching taxonomy entry / fingerprint net so a co-mentioned real defect
    // (sibling-class-fix, stale-comment) still clusters in its own bucket.
    if (t.key === 'pr-body-contract' && !isGenuinePrBodyContractViolation(text)) continue;
    // sibling-class-fix: same treatment (issue #3325) — drop affirmations /
    // declared false positives so the bucket counts only genuine unswept-sibling
    // findings, mirroring pr-body-contract's filter above.
    if (t.key === 'sibling-class-fix' && !isGenuineSiblingClassViolation(text)) continue;
    return t.key;
  }
  return fingerprintFinding(text); // unbucketed → fingerprint safety net (or null)
}

// Severities that count as a CONFIRMED recurring mistake. `❓` is an
// adversarial-uncertainty note ("couldn't verify X") — the reviewer doing due
// diligence on a PR that legitimately touches the topic, NOT the agent
// repeating a documented error. Counting `❓` (and counting every matching LINE
// rather than every distinct PR) inflated TOPIC buckets with non-defects and
// mis-fired escalations: `auto-ads` reached 7 from a negation substring match
// ("non SEO/AdSense", #2114) plus the three `❓` adversarial lines of a single
// PR (#2086) — none of them a rule violation (#2124). So: count only confirmed
// severities, at most once per (PR, bucket).
const COUNTABLE_SEVERITIES = new Set(['🔴', '🟡']);
// Negated-count opener: an LGTM recap line ("Nessun 🔴; sibling-check risolto…",
// "Zero 🔴. Single-source html fix è corretto…, sibling-check risolto…") states
// there are ZERO findings of that severity, yet the raw glyph is still present
// in the text — a naive `.includes()` reads it as a CONFIRMED finding, and if
// the surrounding recap prose happens to name a bucket's vocabulary (here:
// "sibling-check"/"siblings", used routinely in a clean LGTM summary) the recap
// sentence itself gets miscounted as a genuine reviewer-finding (issue #4342:
// this exact bug inflated `sibling-class-fix` on #4279/#4276/#4259, all zero-🔴
// LGTM passes, driving a false `recurringDespiteRule` escalation — the rule was
// never broken, the harvester's own tally was). Same negation-substring class
// already fixed for `auto-ads` at the taxonomy-regex level (#2114); this closes
// it at the severity-detection level so EVERY bucket is protected, not just one.
const NEGATED_SEVERITY_RE = /\b(?:nessun\w*|zero|0)\s+(?:🔴|🟡|❓)/giu;
export function detectSeverity(line) {
  const s = String(line ?? '').replace(NEGATED_SEVERITY_RE, '');
  return s.includes('🔴') ? '🔴' : s.includes('🟡') ? '🟡' : s.includes('❓') ? '❓' : null;
}

// Pure tally: reviewer-PRs → { counts, examples } per bucket. Mirrors the
// per-issue dedup already used for fix-outcome markers below: one PR with N
// matching lines in the same bucket counts ONCE (the lesson is "N distinct PRs
// got <topic> wrong", not "N lines"). `❓`/uncountable severities are skipped.
// `bucketOf` is injectable for testing. Each example is stamped with `at`
// (the PR's `mergedAt`, when the caller provides one) so the post-fix
// re-escalation guard (`examplesSinceFix`) can filter reviewer-finding buckets
// the same way it already filters fix-outcome ones (#5516: without this stamp
// a bucket re-fires on the SAME pre-fix occurrences forever, indistinguishable
// from a rule that never worked).
export function tallyFindings(prs, { bucketOf = bucketFinding } = {}) {
  const counts = {};
  const examples = {};
  for (const { number, reviews, mergedAt } of prs || []) {
    const seenBuckets = new Set(); // per-PR dedup across all its reviews
    for (const r of reviews || []) {
      if (r.author?.login !== 'claude') continue;
      for (const line of String(r.body || '').split('\n')) {
        const sev = detectSeverity(line);
        if (!sev || !COUNTABLE_SEVERITIES.has(sev)) continue;
        const bucket = bucketOf(line);
        if (!bucket) continue;
        if (seenBuckets.has(bucket)) continue;
        seenBuckets.add(bucket);
        counts[bucket] = (counts[bucket] || 0) + 1;
        (examples[bucket] ||= []).push({ pr: number, severity: sev, snippet: line.trim().slice(0, 160), at: mergedAt });
      }
    }
  }
  return { counts, examples };
}

// ---- `already-fixed` avoidability classifier (DETERMINISTIC) ----
// A `fix-outcome:already-fixed` marker is recurring-BURN signal worth escalating
// ONLY when the zero-Claude pre-flight gate (check-issue-already-resolved.mjs)
// COULD plausibly have caught it but didn't → a real gate gap. For two whole
// classes of issue the gate, by its own deliberately-conservative design, NEVER
// short-circuits — so a genuine Claude run discovering "already-fixed" is the
// EXPECTED minimal-cost confirmation path, NOT a rule violation, and counting it
// re-fires escalation #2290 perpetually with no actionable fix (you cannot make
// the gate aggressive enough without dropping real bugs — explicitly forbidden by
// the gate's bias-to-PROCEED invariant). Those two classes:
//   1. AGGREGATE follow-ups ("N item deferred", N≥2, or sweep/batch/bulk): the gate
//      refuses to short-circuit them (one item resolved ≠ all). Their title carries
//      the count verbatim (post-merge-followup.yml batches them, AGENTS.md #925), so
//      this is detectable from the title alone — no extra body fetch.
//   2. NON-follow-up issues (crawler-health, validation-failure, free-form): the
//      gate's scope is `follow-up`-labelled only; everything else is always let
//      through. A crawler-health `stale` that auto-resolves transiently (#2147) can
//      never be pre-empted by a content-token matcher.
// Same feedback-loop class as the reconcile-bot / pre-flight-deterministic skips in
// the outcome loop below: don't count burn that no safe gate could have prevented.
// Pure → unit-tested. `labels` is an array of label-name strings.
export function isAvoidableAlreadyFixed(title, labels) {
  const names = Array.isArray(labels) ? labels : [];
  if (!names.includes('follow-up')) return false; // out of the gate's scope
  const t = String(title || '');
  const m = t.match(/(\d+)\s+items?\s+deferred/i);
  // An explicit count is authoritative once present — no keyword fallback
  // needed (and none applied), else a single-item title containing an
  // ordinary word like "batch" (e.g. "1 item deferred ... batch backfill...")
  // was misclassified as an aggregate (#3378).
  if (m) return Number(m[1]) < 2;
  if (/\b(?:sweep|batch|bulk)\b/i.test(t)) return false; // aggregate by keyword (no explicit count stated)
  return true; // single-item follow-up → the gate's real target → countable
}

// ---- `max-turns` avoidability classifier (DETERMINISTIC) --------------------
// A `fix-outcome:max-turns` marker (issue-fix.yml granular telemetry: a fixer run
// that died `error_max_turns`) is recurring-BURN worth escalating ONLY when the
// run hit the cap on a task the automation COULD have completed in budget — i.e. a
// genuinely-fixable loop. Two whole classes hit the cap DETERMINISTICALLY by their
// own structure, and for them the structural fix ALREADY shipped (followup-drainer
// pre-flight #2291 + the per-item circuit-breaker in issue-fix.yml). Re-tentando
// li riproduce; raising max-turns is explicitly forbidden (AGENTS.md, reverts
// #795/#802). Counting them re-fires escalation #2439 with no actionable fix left:
//   1. AGGREGATE follow-ups ("N item deferred", N≥2, or sweep/batch/bulk): doing
//      ALL items in one run blows the budget by construction (#2332 = 5 items). The
//      circuit-breaker already caps the run at ONE item; a death here is the
//      multi-item attempt the breaker is meant to stop, not a fixable loop.
//   2. Issues the drainer has ALREADY PARKED `needs-human` (malformed body / network
//      -audit / repeated-death too-large): the deterministic pre-flight detected the
//      structural non-fixability and stopped re-queueing. The lingering marker is the
//      run that triggered the park, expected — not preventable burn.
// Single-item, still-routable follow-ups that die at the cap (no `needs-human`) are
// the genuine signal — a fixable loop the budget should have covered → countable.
// Same feedback-loop class as isAvoidableAlreadyFixed. Pure → unit-tested.
// `labels` is an array of label-name strings.
//   3. The run ALREADY SHIPPED A PR (`hasDeliveredPr`, i.e. the issue carries a
//      `<!-- FIX_OUTCOME: pr-created -->` marker): the cap was hit on harmless
//      POST-delivery churn (telemetry comment, sibling-sweep verify, a second
//      item). The workflow's own `Classify outcome` step already treats this as
//      job-SUCCESS ("false-failure: lavoro consegnato"). Counting it as burn was
//      the false positive driving escalation #2653 (3/5 examples — #2590/#2560/
//      #2476 — opened a MERGED PR then overran). By-construction: a run that
//      delivered a PR can never inflate the bucket, mirroring the workflow.
//   4. The run left RECOVERABLE WORK on its branch (`hasRecoverableBranch`): commits on
//      `fix/issue-<N>` ahead of `main`, from the anti-100%-loss WIP checkpoint issue-fix.yml
//      pushes as soon as the edit is applied (#4337, step 4 of the fixer prompt). Until
//      2026-08-13 the ONLY proof of delivery this classifier accepted was a `pr-created`
//      marker, so a cap hit AFTER the checkpoint but BEFORE the PR read as "produced
//      nothing" and was counted as preventable burn. Measured on the corpus over 31
//      `max-turns` deaths: delivered=0, recoverable=11, empty=20 — eleven branches
//      carrying a real diff, classified as noise. Two of them were recovered by hand and
//      merged (site #5767 → PR #5774, corpus #166 → PR #293), which is the whole argument:
//      work you can merge is not a fixable-loop signal, it is a delivery that stopped one
//      step short. The actionable follow-up is to OPEN THAT PR (the drainer's resume-aware
//      retry does), not to write another doc rule — so it must not drive an escalation.
//      `hasDeliveredPr` and `hasRecoverableBranch` therefore point the same way here even
//      though they are opposite evidence: partial delivery and full delivery are both
//      delivery.
/**
 * @param {string} title
 * @param {string[]} labels
 * @param {boolean | { hasDeliveredPr?: boolean, hasRecoverableBranch?: boolean }} [delivery]
 *   Legacy boolean (`hasDeliveredPr`) or the two delivery evidences together.
 * @returns {boolean} true when the cap-death is preventable burn worth escalating.
 */
export function isAvoidableMaxTurns(title, labels, delivery = false) {
  const names = Array.isArray(labels) ? labels : [];
  const t = String(title || '');
  // `delivery` accepts the legacy boolean (`hasDeliveredPr`) or the richer
  // `{ hasDeliveredPr, hasRecoverableBranch }` — call sites written before the branch
  // evidence existed keep their meaning exactly.
  const { hasDeliveredPr = false, hasRecoverableBranch = false } =
    (delivery && typeof delivery === 'object') ? delivery : { hasDeliveredPr: Boolean(delivery) };
  // (3) a PR was delivered → cap hit on post-delivery overrun, not a fixable loop.
  if (hasDeliveredPr) return false;
  // (4) commits on `fix/issue-<N>` ahead of main → the run delivered recoverable work.
  if (hasRecoverableBranch) return false;
  // (2) drainer already parked it as structurally non-fixable → expected death.
  if (names.includes('needs-human')) return false;
  // (1) aggregate multi-item → over-budget by construction (circuit-breaker target),
  //     not a fixable loop. Same detection as isAvoidableAlreadyFixed — an explicit
  //     count is authoritative once present, no keyword fallback needed (else a
  //     single-item title containing an ordinary word like "batch" was
  //     misclassified as an aggregate, #3378).
  const m = t.match(/(\d+)\s+items?\s+deferred/i);
  if (m) return Number(m[1]) < 2;
  if (/\b(?:sweep|batch|bulk)\b/i.test(t)) return false; // aggregate by keyword (no explicit count stated)
  return true; // single-item, still-routable → fixable loop → countable
}

// ---- `no-root-cause` avoidability classifier (DETERMINISTIC) ----------------
// A `fix-outcome:no-root-cause` marker is recurring-BURN worth escalating ONLY
// when the fixer genuinely explored a real code bug and couldn't diagnose it —
// the prose rule ("se dopo ~15 turni non emerge una root cause chiara... termina
// con l'outcome no-root-cause") failing to prevent repeat exploration dead-ends.
// Escalation #4580 fired at 6/14d, but EVERY example (#4540/#4516/#4515/#4484/
// #4458) is a CORRECT, non-preventable abort forced into this one generic code
// because the taxonomy had no dedicated code for either class below — the rule
// was never broken, the taxonomy was too coarse:
//   1. TRANSIENT / VERIFIED-LIVE NON-BUG (#4540/#4516/#4515): the fixer verified
//      live (curl, `gh run list`) that the alert is a monitor false-positive — a
//      self-heal debounced-opener issue by design (#4540), or a deploy-churn edge
//      503 blip that had already resolved by the time of diagnosis (#4516/#4515).
//      There is no root cause to find because there is no bug: "try harder to
//      diagnose" cannot fix a symptom that stopped existing.
//   2. BLOCKED-ON-DEPENDENCY (#4484/#4458): the fixer found the root cause — an
//      epic/sub-issue this issue explicitly depends on ("Dipende dalla sub-issue
//      X") isn't done yet — but building that dependency here would blow the
//      single-issue scope (AGENTS.md #6) and duplicate the dedicated fixer run
//      already queued for it. Root cause IS known; the run is blocked, not lost.
// Neither class is a diagnosis failure, so counting them can never validate a
// "the rule works now" outcome — no amount of prompt tuning eliminates a
// transient monitor blip or an unmet epic dependency. A genuine no-root-cause
// (explored and still can't tell) has neither tell below and stays counted.
// Detected from the OUTCOME COMMENT BODY (not title/labels, unlike the sibling
// classifiers above): the distinguishing signal is the fixer's own diagnosis
// prose, not issue metadata. Pure → unit-tested, same shape as
// isAvoidableAlreadyFixed / isAvoidableMaxTurns.
const NO_ROOT_CAUSE_TRANSIENT_RE =
  /verificat[oa]\s+live,?\s+nessuna root cause di codice|nessun bug di codice|self-heal|debounc\w*|blip\s+(?:edge\s+)?transitori[oa]|rumore\s+(?:edge\/)?deploy-churn|rumore\s+transitori[oa]/i;
const NO_ROOT_CAUSE_BLOCKED_DEP_RE =
  /blocco di dipendenza|dipend[ei]\s+esplicitamente\s+dalla\s+sub-?issue|blocked:\s*dipendenza/i;
export function isAvoidableNoRootCause(commentBody) {
  const s = String(commentBody || '');
  if (NO_ROOT_CAUSE_TRANSIENT_RE.test(s)) return false; // (1) verified non-bug
  if (NO_ROOT_CAUSE_BLOCKED_DEP_RE.test(s)) return false; // (2) blocked on unmet dependency
  return true; // genuine "couldn't diagnose" → the real signal → countable
}

// ---- `overlap-skip` avoidability classifier (DETERMINISTIC) -----------------
// The classifier this file was MISSING. Every sibling outcome code above has one; the
// scheduling pair did not, so the outcome loop counted every `overlap-skip` marker as
// recurring burn. Measured on the corpus mirror (2026-08-13): 11 markers seen, 11
// counted, 0 discarded — the bucket sat above threshold on outcomes that are, by the
// loop's OWN declaration, not faults at all.
//
// That declaration lives in `followup-drainer.mjs` and is explicit: `overlap-skip` and
// `pr-already-open` are deliberately EXCLUDED from `NON_RETRYABLE` because "l'overlap è
// transitorio (la PR bloccante può mergiare → ri-tentabile)", and
// `close-recovered-structural-hold.mjs` refuses to hold them for the same reason
// ("scheduling, not a fault"). Two issues touching one file at the same time is the
// normal shape of a loop that runs several fixers in parallel; the deferral IS the
// correct handling, and no doc rule an agent could follow makes two independent issues
// stop overlapping. Counting it re-fires an escalation whose only possible remedy is the
// zero-Claude pre-flight that already exists (#3810) — and whose corpus half was
// separately found INERT and fixed in `workflow-scope-detect.mjs` (see `CODE_DIRS`), which
// is the actual cause of the burn these markers recorded.
//
// The ONE case that stays countable: the issue also carries a `pr-created` marker. Then
// the fixer was re-promoted onto an issue that already had its PR open, which the
// drainer's `hasFixPR` guard exists to prevent — a real gate gap, and a whole Claude run
// spent to rediscover the loop's own output. Note the polarity is the opposite of
// `isAvoidableMaxTurns`'s: there a delivered PR means the cap was hit AFTER the work
// landed (harmless overrun); here it means the run should never have started.
// Pure → unit-tested, same shape as the classifiers above.
export function isAvoidableOverlapSkip(title, labels, hasDeliveredPr = false) {
  if (hasDeliveredPr) return true; // promoted despite an open PR → hasFixPR gap → countable
  return false; // transient scheduling deferral → expected, not preventable burn
}

// #4750: isAvoidableNoRootCause STILL misses both classes above whenever the
// fixer paraphrases them — e.g. "verificato live: nessuna root cause di
// codice" (colon, not the regex's comma) or "blip edge/deploy-churn
// transitorio" (an inserted "/deploy-churn" the regex doesn't allow) — because
// it is, unlike every sibling avoidable-* filter, matching open-ended
// LLM-authored diagnosis prose rather than a fixed-format field (title/labels).
// That input space is unbounded: #4580 escalated once, the regex was widened,
// and #4750 escalated again 6/14d later on a FRESH set of paraphrases
// (#4748/#4738/#4735/#4702/#4696 — all verified transient-live or
// blocked-on-a-separately-tracked-issue, none a genuine stuck diagnosis; see
// their `no-root-cause` comments). Widening the regex again would only repeat
// the same failure a third time. The structural fix is to stop trying to
// parse prose for the escalation decision: `no-root-cause` never drives a
// "ricorre nonostante regola" escalation (same treatment as `issue-class`,
// which is operational volume/context, not instruction signal) — a docs-only
// prompt rule can't bound how many ways an LLM restates "this was transient"
// or "blocked on #N", so recurrence here is expected noise, not a preventable
// mistake. isAvoidableNoRootCause / the regexes above stay in place for the
// volume/context count shown in the harvest summary; they just no longer gate
// whether the bucket can escalate.
// #4938: the carve-out above never actually fired in production. main()'s
// outcome-tally loop builds keys as `fix-outcome:${code}` (already prefixed
// with the source), but the check below only ever matched the bare code -
// a shape that only existed in the unit test, not at the real call site.
// Strip the redundant `${source}:` prefix (same normalization
// `alreadyDocumented` already does for non-taxonomy keys) before comparing.
// `rate-limited` (2026-08-05): stessa classe, causa diversa. Il marker dice che
// la quota Max CONDIVISA era esaurita quando è arrivato il turno di quella issue
// — la run è morta su HTTP 429 al primo turno, senza mai leggerla (`num_turns: 1`,
// `total_cost_usd: 0`). Non è una regola che un agent ha violato e che
// un'aggiunta ai doc potrebbe prevenire: è una condizione ambientale. Farla
// guidare un'escalation significherebbe spendere il turno Claude della proposta
// per redigere istruzioni che non possono fixare un'interruzione di quota —
// per giunta proprio nella finestra in cui la quota manca, cioè il momento
// peggiore possibile. Come per `no-root-cause`, il bucket resta CONTATO (volume
// e context nel summary del harvest restano visibili); smette solo di poter
// aprire una PR di regole. Il segnale di capacità ha già la sua sede giusta: il
// failure-rate di `issue-fix.yml` nel tracker #1951 (loop-health-report).
// `skip-duplicate-diagnosis` (2026-08-08, #5288): emesso SOLO dal Mode 2 di
// check-workflows-scope.mjs, cioè quando una issue con titolo identico a una
// precedente già diagnosticata viene short-circuitata PRIMA di spendere un turno
// Claude. Non è un blocco né una regola violata: è il guard che funziona, a costo
// zero. Prima condivideva il marker con `blocked-workflows-scope`, e quella
// conflazione ha una conseguenza perversa — più il guard è efficace, più alza il
// bucket che fa scattare l'escalation su quello stesso bucket, così l'escalation
// può ripresentarsi PROPRIO perché il fix funziona. Stessa classe di feedback-loop
// già vista con `already-fixed` (#2123) e `rate-limited`: separato il codice, il
// bucket resta contato come volume/context nel summary ma non può più driveare
// una proposta.
// `overlap-skip` / `pr-already-open` (2026-08-13): stessa classe, causa ancora diversa.
// Sono i due esiti che `followup-drainer.mjs` dichiara TRANSIENTI — li esclude apposta da
// `NON_RETRYABLE` perché «la PR bloccante può mergiare → ri-tentabile», e
// `close-recovered-structural-hold.mjs` si rifiuta di trattenerli («scheduling, not a
// fault»). Un'escalation su questo bucket chiederebbe una regola di prosa contro il fatto
// che due issue indipendenti nominino lo stesso file nello stesso momento, che è la forma
// normale di un ciclo con più fixer in parallelo: nessuna riga di doc la previene. Il
// rimedio strutturale esiste già ed è la pre-flight zero-Claude (#3810) — la cui metà
// corpus era però INERTE (`CODE_PATH_RE` matchava dalla directory, mai dal path completo,
// vedi `scripts/lib/workflow-scope-detect.mjs`), ed è quello il difetto che questi marker
// stavano davvero registrando. I due codici restano CONTATI come volume/context nel
// summary, esattamente come `rate-limited`: smettono solo di poter aprire una PR di regole.
export function isEscalationDriver(source, key) {
  if (source === 'issue-class') return false;
  const bareKey = key.startsWith(`${source}:`) ? key.slice(source.length + 1) : key;
  if (source === 'fix-outcome' && bareKey === 'no-root-cause') return false;
  if (source === 'fix-outcome' && bareKey === 'rate-limited') return false;
  if (source === 'fix-outcome' && bareKey === 'skip-duplicate-diagnosis') return false;
  if (source === 'fix-outcome' && bareKey === 'overlap-skip') return false;
  if (source === 'fix-outcome' && bareKey === 'pr-already-open') return false;
  return true;
}

// ---- Recoverable work left on the fixer's branch ---------------------------
// issue-fix.yml pushes a WIP checkpoint (`wip(issue-N): checkpoint pre-test`) the moment
// the edit is applied, precisely so a run that dies at the turn cap doesn't take the diff
// down with the container (#4337). The branch it pushes is `fix/issue-<N>` — the same head
// the workflow's own `Classify outcome` step reads. Nothing downstream of the death ever
// looked at it: `isAvoidableMaxTurns` asked only about a PR, so a branch with real commits
// and no PR was indistinguishable from a run that produced nothing.
export function fixBranchName(issueNumber) {
  return `fix/issue-${issueNumber}`;
}

// Stamp written by mark-claude-terminal-outcome.mjs next to the `max-turns` marker, at the
// one moment the evidence is free (inside the job, on the machine that pushed the branch).
// Reading it costs no API call and survives the branch being deleted later by a merge.
export const RECOVERABLE_BRANCH_RE = /<!--\s*RECOVERABLE_BRANCH:\s*(\S+)\s+ahead=(\d+)\s*-->/i;

/**
 * `{ branch, aheadBy }` from a stamped comment, or null. Pure → testabile.
 * @param {string} commentBody
 */
export function parseRecoverableBranchStamp(commentBody) {
  const m = RECOVERABLE_BRANCH_RE.exec(String(commentBody || ''));
  if (!m) return null;
  const aheadBy = Number(m[2]);
  if (!Number.isFinite(aheadBy) || aheadBy <= 0) return null;
  return { branch: m[1], aheadBy };
}

/**
 * Recoverable work for `issueNumber`: the stamp when a run left one, otherwise ask GitHub
 * how far `fix/issue-<N>` is ahead of `main`. Impure (gh) — kept thin, and FAIL-SAFE: any
 * gh error / missing branch answers null, i.e. exactly the pre-2026-08-13 behaviour.
 * @param {number} issueNumber
 * @param {Array<{body?: string}>} comments
 */
function recoverableWorkOnBranch(issueNumber, comments) {
  for (const c of comments || []) {
    const stamped = parseRecoverableBranchStamp(c?.body);
    if (stamped) return stamped;
  }
  const branch = fixBranchName(issueNumber);
  const cmp = ghJson(['api', `repos/{owner}/{repo}/compare/main...${branch}`,
    '--jq', '{ahead_by: .ahead_by}']);
  const aheadBy = Number(cmp?.ahead_by);
  return Number.isFinite(aheadBy) && aheadBy > 0 ? { branch, aheadBy } : null;
}

// ---- 2. Recurring issue classes (created in window) ----
export function issueClass(title, labels) {
  const t = title || '';
  if (/^Crawler Failure/i.test(t)) return 'issue:crawler-failure';
  if (/Validation Failure|Publish post-deploy/i.test(t)) return 'issue:validation-failure';
  if (/\[crawler-health\]/i.test(t)) return 'issue:crawler-health';
  if (/^follow-up\(/i.test(t)) return 'issue:follow-up';
  const names = (labels || []).map((l) => l.name);
  if (names.includes('revenue') || names.includes('rpm-canary')) return 'issue:revenue';
  return null;
}

// ---- Dedup vs existing doc-contracts ----
const DOC_FILES = ['AGENTS.md', 'ISSUES.md', 'REVIEW.md', 'FOLLOWUP.md'];
export function alreadyDocumented(bucketKey, corpus) {
  const tax = TAXONOMY.find((t) => t.key === bucketKey);
  if (tax) return tax.docKeys.some((k) => corpus.includes(k.toLowerCase()));
  // Non-taxonomy keys (issue-class / fix-outcome codes): check hyphen, space
  // and nospace variants so "follow-up" matches a doc that writes "follow up".
  const base = bucketKey.replace(/^[a-z-]+:/, '').toLowerCase();
  const variants = [base, base.replace(/-/g, ' '), base.replace(/-/g, '')];
  return variants.some((v) => corpus.includes(v));
}

// ---- Escalation issue title/body helpers (DETERMINISTIC, see emit note) ----
function escalationTitle(c) {
  return `escalation(harvester): ${c.source}/${c.key} ricorre nonostante regola`;
}
// Recurrence bumps SEVERITY, not count: un'escalation è già "ricorre nonostante
// regola" (≥soglia×fattore) → baseline medium; se il count scala oltre 2× il
// fattore → high. Puro → testabile.
export function severityLabelForCount(count, threshold = THRESHOLD, factor = EFFICACY_FACTOR) {
  return count >= threshold * factor * 2 ? 'severity:high' : 'severity:medium';
}
// Estrae `<source>/<key>` dal titolo canonico, o null. Puro → testabile. Serve
// al self-heal: mappare un'escalation issue aperta al suo bucket.
export function parseEscalationKey(title) {
  const m = /^escalation\(harvester\):\s*(.+?)\s+ricorre nonostante regola\s*$/.exec(String(title || ''));
  return m ? m[1].trim() : null;
}
// ---- POST-FIX RE-ESCALATION GUARD (DETERMINISTIC, escalation #4578) --------
// `fix-outcome:revenue-tracker-manual` re-fired the day AFTER its own structural
// fix shipped: #4517 (this exact bucket) was closed by merging PR #4535, which
// added a zero-Claude pre-flight (`detectEpicTracker` in followup-drainer.mjs)
// that now prevents FUTURE burn. But the very next harvester run still counted
// 11 occurrences in the trailing 14-day window — all of them from BEFORE the fix
// merged (the 2026-07-18 `[EPIC]` batch) — so `recurringDespiteRule` fired again
// and `createGithubIssue` minted a brand-new duplicate (#4578) instead of finding
// #4517, because that dedup only searches OPEN issues by title and #4517 was
// already closed. The bucket wasn't still broken; the window just hadn't aged
// out yet. Root cause is generic (applies to ANY fix-outcome bucket, not just
// this one): count only examples NEWER than the bucket's last shipped fix.
//
// CONSERVATIVE (bias to escalate — a missed re-fire wastes a review cycle, a
// false suppression hides a real regression): only excludes examples when a
// PRIOR escalation for the SAME bucket key was actually closed (a shipped fix
// happened) AND the example predates that closure. A bucket with no prior
// closed escalation (first time above threshold) is unaffected — full count.

/**
 * Epoch ms of the most recent CLOSED escalation issue whose title parses to
 * `fullKey` (`<source>/<key>`, matching `escalationTitle`'s format), or null if
 * none. Pure → testable.
 * @param {string} fullKey
 * @param {Array<{title?: string, closedAt?: string}>} closedIssues
 */
export function lastEscalationClosedAt(fullKey, closedIssues) {
  let latest = null;
  for (const iss of closedIssues || []) {
    if (parseEscalationKey(iss?.title) !== fullKey) continue;
    const t = Date.parse(iss?.closedAt);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

/**
 * Examples occurring strictly AFTER `cutoffMs` (the bucket's last shipped fix).
 * `cutoffMs === null` means no prior fix ever shipped for this bucket → return
 * examples unchanged (first-ever escalation must still fire on full history).
 * An example lacking a parseable `at` timestamp is dropped once a cutoff exists
 * (conservative: can't prove it's post-fix, so don't let it count toward
 * re-firing an already-fixed bucket). Pure → testable.
 * @param {Array<{at?: string}>} examples
 * @param {number|null} cutoffMs
 */
export function examplesSinceFix(examples, cutoffMs) {
  if (cutoffMs === null || cutoffMs === undefined) return examples || [];
  return (examples || []).filter((e) => {
    const t = Date.parse(e?.at);
    return !Number.isNaN(t) && t > cutoffMs;
  });
}

function escalationBody(c) {
  const examples = (c.examples || [])
    .map((e) => '#' + (e.pr || e.issue))
    .filter((s) => s !== '#undefined')
    .join(', ') || '—';
  return [
    '## Bucket',
    `\`${c.source}/${c.key}\` — count **${c.count}** su finestra ${WINDOW_DAYS}gg (dal ${sinceDay})`,
    '',
    '## Esempi PR/issue',
    examples,
    '',
    '## Perché escalare',
    `Pattern GIÀ documentato ma che ricorre ≥ soglia×fattore-efficacia ` +
      `(${THRESHOLD}×${EFFICACY_FACTOR}). La regola prosa NON previene l'errore ` +
      `→ serve un fix **STRUTTURALE** (gate CI deterministico, template, lint, ` +
      `modulo condiviso, refactor che lo renda impossibile by-construction), ` +
      `non un'altra riga di doc.`,
    '',
    '_Auto-filed dal lessons-harvester (dedup deterministico per bucket)._',
  ].join('\n');
}

async function main() {
  // ---- 1. Reviewer findings on recently-merged PRs ----
  // `mergedAt` fetched here (not from `pr view`) so tallyFindings can stamp each
  // example with it — needed so the post-fix re-escalation guard below can filter
  // reviewer-finding examples the same way it already filters fix-outcome ones.
  const mergedPrs = ghJson(['pr', 'list', '--state', 'merged', '--search', `merged:>=${sinceDay}`,
    '--limit', String(MAX_PRS), '--json', 'number,mergedAt']) || [];
  const prReviews = [];
  for (const { number, mergedAt } of mergedPrs) {
    const data = ghJson(['pr', 'view', String(number), '--json', 'reviews']);
    prReviews.push({ number, reviews: data?.reviews || [], mergedAt });
  }
  const { counts: findingCounts, examples: findingExamples } = tallyFindings(prReviews);

  // ---- 2. Recurring issue classes (created in window) ----
  const issueCounts = {};
  const issueExamples = {};
  const allIssues = ghJson(['issue', 'list', '--state', 'all', '--search', `created:>=${sinceDay}`,
    '--limit', String(MAX_ISSUES), '--json', 'number,title,labels']) || [];
  for (const it of allIssues) {
    const cls = issueClass(it.title, it.labels);
    if (!cls) continue;
    issueCounts[cls] = (issueCounts[cls] || 0) + 1;
    (issueExamples[cls] ||= []).push({ issue: it.number, title: (it.title || '').slice(0, 80) });
  }

  // ---- 3. issue-fix outcomes via FIX_OUTCOME markers in issue comments ----
  // Marker contract (issue-fix.yml prompt): the fixer's terminal comment starts
  // with `<!-- FIX_OUTCOME: <code> -->`. We bucket the blocked/no-pr codes since
  // those are the recurring-burn signal; `pr-created` is the healthy path.
  const outcomeCounts = {};
  const outcomeExamples = {};
  // `max-turns` deaths that left commits on `fix/issue-<N>`: work the loop can still
  // land, not noise. Surfaced in the harvest output (and in $GITHUB_OUTPUT) so it is
  // visible without reading 31 run logs by hand.
  const recoverableMaxTurns = [];
  const fixIssues = ghJson(['issue', 'list', '--search', `label:agent:triaged updated:>=${sinceDay}`,
    '--state', 'all', '--limit', String(MAX_ISSUES), '--json', 'number,title,labels']) || [];
  for (const issue of fixIssues.slice(0, MAX_ISSUES)) {
    const { number } = issue;
    const labelNames = (issue.labels || []).map((l) => l.name);
    const data = ghJson(['issue', 'view', String(number), '--json', 'comments']);
    const comments = data?.comments || [];
    // Dedup PER-ISSUE: una stessa issue ri-accodata dal followup-drainer (rescue
    // a 3 tentativi) può postare lo STESSO marker N volte. Contarli tutti gonfia
    // il bucket (3 run di UNA issue → conta 3) e fa scattare l'escalation su una
    // soglia di issue-distinte falsata — è esattamente ciò che ha prodotto #1478.
    // La lezione cercata è «N issue DISTINTE bloccate da questo esito», non «N
    // commenti» → conta ogni codice al più una volta per issue. (Il re-queue è
    // ora fermato alla sorgente in followup-drainer.mjs, ma il dedup rende il
    // conteggio robusto anche allo storico e a ri-tentativi manuali.)
    // Lo stesso principio dedup-per-sorgente vale per i reviewer-finding sopra,
    // dove la chiave è la PR (vedi tallyFindings).
    const seenThisIssue = new Set();
    // A `pr-created` marker anywhere on the issue means a fixer run delivered a PR
    // (open or merged) — so a `max-turns` death is post-delivery overrun, not a
    // fixable loop (escalation #2653). Pre-scan once; per-issue dedup already
    // collapses re-queued runs, and a delivered PR means the work landed.
    const hasDeliveredPr = comments.some((c) =>
      /<!--\s*FIX_OUTCOME:\s*pr-created\s*-->/i.test(String(c.body || '')));
    for (const c of comments) {
      const m = String(c.body || '').match(/<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i);
      if (!m) continue;
      const code = m[1].toLowerCase();
      if (code === 'pr-created') continue; // healthy
      // Backstop-emitted fallbacks (issue-fix.yml "post-step deterministico") tag
      // crashed/max_turns runs — expected catch-all, not a doc-rule violation.
      // Counting them inflates no-pr-unspecified → feedback loop: escalation keeps
      // re-firing even after the backstop fix (PR #1067) landed.
      if (String(c.body || '').includes('post-step deterministico')) continue;
      // SAME feedback-loop, `already-fixed` flavour: the zero-Claude pre-flight gate
      // (check-issue-already-resolved.mjs, structural fix #1647) and the scheduled
      // reconciler (reconcile-followups.mjs) BOTH post `<!-- FIX_OUTCOME: already-fixed -->`
      // when they short-circuit a done-but-open follow-up WITHOUT ever spending a Claude
      // run. Counting those as burn makes the structural fix re-escalate ITSELF (#2123:
      // bucket re-fired at 10/14d even though the gate had already shipped). Only a
      // marker from a genuine Claude fixer run is recurring-burn signal → skip the
      // deterministic short-circuit comments (carry the `<!-- reconcile-bot -->` marker
      // and the "Pre-flight (auto, zero-Claude)" / "Reconcile (auto)" signature).
      const cb = String(c.body || '');
      if (cb.includes('reconcile-bot') ||
          cb.includes('Pre-flight (auto, zero-Claude)') ||
          cb.includes('Reconcile (auto)') ||
          // SAME feedback-loop, drainer pre-flight flavour (structural fix #2291):
          // followup-drainer.mjs posta `no-root-cause` / `blocked-*` DETERMINISTICAMENTE
          // quando rileva body malformato o audit-curl PRIMA di spendere un run Claude.
          // Contarli come burn gonfia il bucket e ri-scalderebbe l'escalation stessa.
          cb.includes('Pre-flight drainer (zero-Claude')) continue;
      // `already-fixed` on an issue the pre-flight gate could NEVER safely have
      // short-circuited (aggregate follow-up, or non-follow-up out of gate scope)
      // is the EXPECTED confirmation path, not preventable burn → don't escalate it
      // (root cause of #2290: bucket re-fired at 9/14d, all 5 examples aggregate or
      // non-follow-up). Single-item follow-ups — the gate's real target — still count.
      if (code === 'already-fixed' && !isAvoidableAlreadyFixed(issue.title, labelNames)) continue;
      // `max-turns` on an aggregate multi-item issue (over-budget by construction,
      // the per-item circuit-breaker's target) or on an issue the drainer has already
      // parked `needs-human` (structurally non-fixable: malformed body / network-audit
      // / repeated-death) is an EXPECTED deterministic death, not a fixable loop → no
      // actionable structural fix beyond what shipped (#2291 + circuit-breaker), so
      // don't escalate it (root cause of #2439: bucket re-fired at 14/14d, examples
      // dominated by aggregate / parked runs). Single-item still-routable deaths count.
      if (code === 'max-turns') {
        // Consult the BRANCH, not just the PR: a cap hit after the WIP checkpoint left
        // commits on `fix/issue-<N>` that a retry can resume from (or a human can open a
        // PR from, as happened with #5767 → PR #5774). Recognised here so the work stops
        // being invisible — recoverableMaxTurns surfaces it in the harvest output — and
        // so the bucket stops treating a partial delivery as a fixable loop.
        const recoverable = hasDeliveredPr ? null : recoverableWorkOnBranch(number, comments);
        if (recoverable && !recoverableMaxTurns.some((r) => r.issue === number)) {
          recoverableMaxTurns.push({ issue: number, title: (issue.title || '').slice(0, 80), ...recoverable });
        }
        if (!isAvoidableMaxTurns(issue.title, labelNames,
          { hasDeliveredPr, hasRecoverableBranch: Boolean(recoverable) })) continue;
      }
      // `overlap-skip` / `pr-already-open`: deferral by the loop's own scheduling rule,
      // declared TRANSIENT by followup-drainer.mjs — expected, not preventable burn. Only
      // an overlap on an issue that ALREADY had its PR open is a real gate gap (hasFixPR).
      if ((code === 'overlap-skip' || code === 'pr-already-open') &&
          !isAvoidableOverlapSkip(issue.title, labelNames, hasDeliveredPr)) continue;
      // `no-root-cause` on a verified-transient monitor blip or an explicit
      // unmet-epic-dependency block is an EXPECTED correct abort, not a
      // diagnosis failure the prose rule could ever prevent (#4580: all 5
      // examples were one of these two, none a genuine stuck-diagnosis).
      if (code === 'no-root-cause' && !isAvoidableNoRootCause(cb)) continue;
      const k = `fix-outcome:${code}`;
      if (seenThisIssue.has(k)) continue;
      seenThisIssue.add(k);
      outcomeCounts[k] = (outcomeCounts[k] || 0) + 1;
      (outcomeExamples[k] ||= []).push({ issue: number, at: c.createdAt });
    }
  }

  // ---- Dedup vs existing doc-contracts ----
  let corpus = '';
  for (const f of DOC_FILES) { try { corpus += '\n' + fs.readFileSync(f, 'utf-8').toLowerCase(); } catch { /* ignore */ } }

  // ---- Post-fix re-escalation guard (escalation #4578, see lastEscalationClosedAt) ----
  // Sources whose examples carry a per-example `at` timestamp can be filtered
  // against a bucket's last shipped fix: fix-outcome (`at` = the FIX_OUTCOME
  // comment's createdAt) and reviewer-finding (`at` = the PR's mergedAt, #5516 —
  // without this, a reviewer-finding bucket like sibling-class-fix re-fires
  // forever on the SAME pre-fix PRs still sitting in the trailing window,
  // indistinguishable from a shipped fix that never worked). issue-class isn't
  // an escalation driver at all (isEscalationDriver), so it's excluded here too.
  // Fetched once, reused per bucket key inside consider().
  const TIMESTAMPED_SOURCES = new Set(['fix-outcome', 'reviewer-finding']);
  const closedEscalations = ghJson(['issue', 'list', '--state', 'closed',
    '--search', 'ricorre nonostante regola in:title',
    '--json', 'number,title,closedAt', '--limit', '100']) || [];

  // ---- Assemble clusters above threshold + novel ----
  const clusters = [];
  // `driver`: clusters that can drive a doc-rule proposal (an agent repeating a
  // mistake or hitting a wall). issue-class counts are operational VOLUME handled
  // by triage/monitors, not instruction signal → included as context, never a
  // proposal driver (novel stays false for them). Per-key, not blanket per-source
  // (see isEscalationDriver, #4750): `fix-outcome:no-root-cause` is carved out the
  // same way even though its source is otherwise driver-eligible.
  function consider(source, counts, examples) {
    for (const [key, count] of Object.entries(counts)) {
      if (count < THRESHOLD) continue;
      const driver = isEscalationDriver(source, key);
      const documented = alreadyDocumented(key, corpus);
      const allExamples = examples[key] || [];
      // A bucket whose last escalation was already closed via a shipped fix
      // shouldn't re-fire on the SAME pre-fix occurrences still sitting in the
      // trailing window — only count what happened AFTER that fix landed.
      const cutoff = TIMESTAMPED_SOURCES.has(source)
        ? lastEscalationClosedAt(`${source}/${key}`, closedEscalations)
        : null;
      const liveExamples = TIMESTAMPED_SOURCES.has(source) ? examplesSinceFix(allExamples, cutoff) : allExamples;
      const effectiveCount = TIMESTAMPED_SOURCES.has(source) ? liveExamples.length : count;
      // Documented + still recurring hard (post-fix) = the rule exists but isn't working.
      const recurringDespiteRule = driver && documented && effectiveCount >= THRESHOLD * EFFICACY_FACTOR;
      clusters.push({ source, key, count, driver, novel: driver && !documented,
        recurringDespiteRule, alreadyDocumented: documented,
        examples: (liveExamples.length ? liveExamples : allExamples).slice(0, 5) });
    }
  }
  consider('reviewer-finding', findingCounts, findingExamples);
  consider('fix-outcome', outcomeCounts, outcomeExamples);
  consider('issue-class', issueCounts, issueExamples);

  clusters.sort((a, b) => b.count - a.count);
  const novel = clusters.filter((c) => c.novel);
  const escalations = clusters.filter((c) => c.recurringDespiteRule);

  const result = { generatedForWindowDays: WINDOW_DAYS, threshold: THRESHOLD,
    efficacyFactor: EFFICACY_FACTOR, since: sinceDay, totalClusters: clusters.length,
    novelClusters: novel.length, escalationClusters: escalations.length, clusters,
    recoverableMaxTurns };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

  // ---- Human summary ----
  console.log(`Lessons harvest — window ${WINDOW_DAYS}d (since ${sinceDay}), threshold ≥${THRESHOLD}`);
  console.log(`Merged PRs scanned: ${mergedPrs.length} · issues scanned: ${allIssues.length} · fix-issues: ${fixIssues.length}`);
  if (!clusters.length) console.log('No recurring clusters above threshold.');
  for (const c of clusters) {
    const tag = c.novel ? 'NOVEL' : c.recurringDespiteRule ? 'ESCALATE' : 'documented';
    console.log(`  [${tag}] ${c.source}/${c.key} ×${c.count}` +
      (c.examples?.length ? `  e.g. ${c.examples.map((e) => '#' + (e.pr || e.issue)).join(',')}` : ''));
  }
  console.log(`\n→ novel recurring clusters: ${novel.length} · escalations (documented-but-recurring): ${escalations.length}`);
  if (recoverableMaxTurns.length) {
    console.log(`\n♻️  max-turns con lavoro RECUPERABILE sul branch (commit avanti a main, nessuna PR): ${recoverableMaxTurns.length}`);
    for (const r of recoverableMaxTurns) {
      console.log(`   #${r.issue} → ${r.branch} (+${r.aheadBy} commit) — ${r.title}`);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `has_novel=${novel.length > 0}\nnovel_count=${novel.length}\n` +
      `has_escalation=${escalations.length > 0}\nescalation_count=${escalations.length}\n` +
      `recoverable_max_turns=${recoverableMaxTurns.length}\n`);
  }

  // ---- Escalation issues: DETERMINISTIC + dedup-by-construction (zero Claude) ----
  // Previously the Claude step was told to open one escalation issue per
  // `recurringDespiteRule` cluster and dedup by re-searching the title. That
  // soft, LLM-driven dedup drifted (same bucket filed under `source/key` AND
  // `source:key`) and re-fired every run → duplicate escalations piled up
  // (i18n-naming ×4, blocked-workflows-scope ×5, …). Emit them from code with a
  // SINGLE canonical title + the hardened code-level dedup in
  // github-issue-creator.mjs (comments on the open canonical instead of
  // duplicating). The Claude step now handles ONLY novel doc-rule proposals.
  // Gate: emit only when explicitly enabled (the workflow sets this). Keeps local
  // dry-runs and tests from minting real GitHub issues.
  if (process.env.HARVEST_EMIT_ESCALATIONS === 'true') {
    // 1. EMIT/UPDATE: una issue canonica per bucket attivo. createGithubIssue
    //    dedupa (commenta sul canonico se esiste). Poi bump SEVERITÀ in base al
    //    count (recidiva → severity sale, non si accumula un'altra issue).
    for (const c of escalations) {
      try {
        const res = await createGithubIssue({
          title: escalationTitle(c),
          description: escalationBody(c),
          priority: 2,
          labels: ['follow-up'],
          workflow: 'Lessons harvester',
        });
        const num = res?.number;
        if (num) {
          const sev = severityLabelForCount(c.count);
          const drop = sev === 'severity:high' ? 'severity:medium' : 'severity:high';
          try {
            gh(['label', 'create', sev, '--color', sev === 'severity:high' ? 'B60205' : 'D93F0B', '-f']);
          } catch { /* label esiste già */ }
          try {
            gh(['issue', 'edit', String(num), '--add-label', sev, '--remove-label', drop]);
          } catch (e) { process.stderr.write(`sev bump #${num} fallito: ${e.message}\n`); }
        }
      } catch (err) {
        process.stderr.write(`escalation emit failed for ${c.source}/${c.key}: ${err.message}\n`);
      }
    }

    // 2. SELF-HEAL CLOSE: un'escalation aperta il cui bucket NON è più tra quelli
    //    attivi (sceso sotto soglia per un'intera finestra) → il pattern si è
    //    fermato: chiudila (drena il ratchet; riapribile, riemerge se ricorre).
    //    Search via la frase senza parentesi (le `(` rompono gh search → era il
    //    blind-spot del monitoring) e filtro per titolo esatto.
    const liveKeys = new Set(escalations.map((c) => `${c.source}/${c.key}`));
    const openEsc = (ghJson([
      'issue', 'list', '--state', 'open', '--search', 'ricorre nonostante regola in:title',
      '--json', 'number,title', '--limit', '100',
    ]) || []).filter((i) => parseEscalationKey(i.title));
    for (const iss of openEsc) {
      const key = parseEscalationKey(iss.title);
      if (liveKeys.has(key)) continue; // ancora attivo → lascia aperta
      try {
        gh(['issue', 'comment', String(iss.number), '--body',
          `🌱 Self-heal: il bucket \`${key}\` non ricorre più sopra soglia nella finestra ${WINDOW_DAYS}gg (dal ${sinceDay}) → il pattern si è fermato. Chiusa dal lessons-harvester. Riemergerà in automatico se torna a ricorrere.`]);
        gh(['issue', 'close', String(iss.number), '--reason', 'completed']);
        console.log(`SELF-HEAL close #${iss.number} — bucket ${key} quiet`);
      } catch (e) {
        process.stderr.write(`self-heal close #${iss.number} fallito: ${e.message}\n`);
      }
    }
  }
}

// Run only as a script, never on import (lets the test import the pure helpers
// above without firing gh / writing files). Same guard convention as
// auto-merge-eval.mjs.
if (process.argv[1]?.endsWith('harvest-agent-lessons.mjs')) {
  await main();
}
