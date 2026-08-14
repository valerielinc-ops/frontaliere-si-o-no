/**
 * THE INVARIANT: no signup path creates a subscriber without a consent text,
 * and no entry claims it was SHOWN unless a call site renders it (#5712, #5718).
 *
 * `tests/newsletter-consent-proof.test.ts` proves the WRITE side —
 * `captureNewsletterSubscriber` refuses to create a document with no formula,
 * and every formula is pinned so an edit cannot be silent. This file is the
 * DISPLAY side, and it exists because the write side turned out not to be the
 * hard half.
 *
 * Measured 2026-08-12, before this change: sixteen register entries, sixteen
 * `displayed: false`, zero `displayed: true`. Every gate recorded "the notice
 * in force here" and not one recorded "the sentence this person read" — and in
 * two of them (NewsletterPopup, SubscriptionCTA) the divergence was concrete:
 * the checkbox label came from `t('newsletter.consentLabel')`, translated four
 * ways, while the stored string was an Italian literal. A German visitor's
 * document therefore recorded a sentence they had never seen.
 *
 * WHY IT DISCOVERS THE CALL SITES FROM DISK
 * -----------------------------------------
 * Same reason as `tests/no-channel-mails-unconfirmed.test.ts`, whose shape
 * this file follows deliberately: a hand-kept array goes stale silently, and
 * the failure it hides is a new signup path that stores nothing. Anything that
 * calls `upsertNewsletterSubscriber`/`captureNewsletterSubscriber` can create
 * a `newsletter_subscribers` document, so that call IS the definition of a
 * signup path — and a twenty-first one fails this file on the day it is
 * written rather than on the day somebody reads the collection.
 *
 * WHAT IT DOES NOT PROVE, said plainly. That the notice is legible, or above
 * the fold, or that the person read it. It proves that the exact bytes stored
 * are the exact bytes a component renders, in the visitor's own locale — which
 * is the claim `displayed: true` makes, and the only one it is allowed to make.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { render } from '@testing-library/react';

import ConsentNotice from '@/components/shared/ConsentNotice';
import {
  CONSENT_LOCALES,
  CONSENT_PAGE_LABEL,
  CONSENT_PAGE_PATH,
  CONSENT_TEXTS,
  consentDisplayText,
  consentProof,
  type ConsentTextKey,
} from '@/services/consentTexts';
import {
  ADVERTISING_NAMED_FROM_PAGE_VERSION,
  ADVERTISING_OPT_OUT_FIELD,
  COMMUNICATION_CHANNELS,
  COMMUNICATIONS_PAGE_PATH,
  COMMUNICATIONS_PAGE_REVISIONS,
  COMMUNICATIONS_PAGE_VERSION,
  CONSENT_CATEGORIES,
  NON_SUBSCRIBER_SENDERS,
  SUSPENDED_WORKFLOW_MARKER,
  hasLiveChannel,
  isUncoveredChannel,
} from '@/services/communicationChannels';
import {
  ADVERTISING_NAMED_FROM_PAGE_VERSION as MATCHER_ADVERTISING_FROM,
  ADVERTISING_OPT_OUT_FIELD as MATCHER_OPT_OUT_FIELD,
  advertisingDisclosureWasShown,
  consentCoversAdvertising,
  matchSubscribersForAd,
} from '../services/publisherBlastMatch.mjs';
import { consentNamesJobAlerts } from '../functions/src/jobAlertBackfillCore.js';
import {
  DATA_CONTROLLER_NAME,
  DATA_CONTROLLER_EMAIL,
} from '../functions/src/lib/dataControllerIdentity.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Comments are where this invariant is DISCUSSED — several call sites explain
 * at length why they do or do not render a notice — so a scan that did not
 * strip them would pass on a file that only talks about the register.
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * What makes a file a signup path.
 *
 * The two service functions are the obvious half. The second pattern is the
 * half that mattered: a raw `addDoc`/`setDoc` on the collection never
 * reaches `captureNewsletterSubscriber`, so the `consent-text-required`
 * guard added by #5695 does not run on it (the file that motivated this
 * pattern, `hooks/useNewsletterState.ts`, was itself dead code and has since
 * been removed — see #5698). A rule that only looked for the function calls
 * would have declared such a file covered.
 */
const CREATES_SUBSCRIBER =
  /(upsert|capture)NewsletterSubscriber\s*\(|(addDoc|setDoc)\(\s*(collection|doc)\([^)]*'newsletter_subscribers'/;

type Verdict =
  /**
   * Puts the exact sentence it stores on screen, once per gate.
   *
   * The assertion is per SENTENCE, not per key, and that changed with #5765.
   * An access gate has two ways through one door — provider buttons and a
   * "continue with email" button — and it may show only ONE notice, so the two
   * register entries it stores (different `act`, same text) are both satisfied
   * by that one notice. Comparing keys would have demanded a second notice and
   * re-created the defect; comparing sentences asserts the thing `displayed`
   * actually claims.
   *
   * `notices` is how many gate surfaces the file has, and therefore exactly how
   * many `<ConsentNotice>` it may render. It is the anti-regression counter for
   * #5765: the defect was four notices in JobBoard.tsx (two per gate), and a
   * gate that grows a second one fails here rather than in review.
   */
  | { verdict: 'shown'; why: string; notices: number }
  /**
   * Stores a formula that no JSX renders, and says so instead of leaving it to
   * be inferred. `onFire` says what to do when the entry stops being
   * `displayed: false` — which is not the same answer everywhere.
   */
  | { verdict: 'recorded-not-shown'; why: string; issue: string; onFire: string }
  /**
   * Contains the call but nothing imports the module, so no visitor reaches
   * it. Asserted, not assumed: the day something imports it, this fails.
   */
  | { verdict: 'unreachable'; why: string; issue: string }
  /**
   * Merges fields onto `newsletter_subscribers/{email}` for an address that
   * already signed in — a preference or profile write, not a subscription.
   * Creation-capable all the same (a merge write on a missing document creates
   * it), so it is declared and constrained rather than filtered out: the
   * assertion is that it never writes the fields that would ESTABLISH a
   * subscription.
   */
  | { verdict: 'merge-update'; why: string };

/**
 * Every signup path, with the verdict that lets it past this file.
 *
 * The KEYS are checked for exhaustiveness against the filesystem below.
 */
const VERDICTS: Record<string, Verdict> = {
  'components/community/NewsletterPopup.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'the checkbox label IS the stored string now — this file and SubscriptionCTA are where the show/store divergence was measurable',
  },
  'components/shared/SubscriptionCTA.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'same divergence as the popup, same fix',
  },
  'components/shared/PdfDownloadGate.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'IT-only gate (its upsert passes locale: it), checkbox label from the register',
  },
  'components/community/OfferwallNewsletterGate.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'had its own four-locale table describing only the newsletter; now renders and stores the register formula',
  },
  'components/community/Newsletter.tsx': {
    verdict: 'shown',
    notices: 2,
    why: 'two mutually exclusive renders — the compact footer form and the full page form — never on screen together, one notice each',
  },
  'components/community/WeeklyDigest.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'notice under the subscribe row',
  },
  'components/shared/LeadMagnetCTA.tsx': {
    verdict: 'shown',
    notices: 2,
    why: 'two mutually exclusive variants of the guide-for-address form, one notice each',
  },
  'components/calculator/MobileCalcLayout.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'notice under the analysis-gate email form',
  },
  'components/fisco/TaxCalendar.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'one reminder panel, one notice under its email button, covering the provider buttons above it (#5765)',
  },
  'components/community/JobBoard.tsx': {
    verdict: 'shown',
    notices: 2,
    why: 'two gate surfaces (modal + inline region), ONE notice each — it rendered four before #5765',
  },
  'components/community/JobOrphanView.tsx': { verdict: 'shown', notices: 1, why: 'notice under the unlock form' },
  'components/community/JobBridgeView.tsx': { verdict: 'shown', notices: 1, why: 'notice under the unlock form' },
  'components/community/JobExpiredView.tsx': { verdict: 'shown', notices: 1, why: 'notice under the unlock form' },
  'components/community/CompanyFollowButton.tsx': {
    verdict: 'shown',
    notices: 2,
    why: 'two gate surfaces, one notice each: the email-capture form (anonymous) and the signed-in "Segui" button, which records a job-alert consent-upgrade proof on the same click (#5902)',
  },
  'components/community/SaveSignInPromptModal.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'its own upsert covers the EMAIL branch only, and that branch renders what it stores; the social branch is recorded by App.tsx and is declared there',
  },
  'components/pages/PublisherPublishPage.tsx': {
    verdict: 'shown',
    notices: 1,
    why: 'one gate, one notice under its email button, covering the provider buttons above it (#5765)',
  },

  'components/pages/UserProfile.tsx': {
    verdict: 'merge-update',
    why: 'writes autologin_enabled on the signed-in visitor\'s own address',
  },
  'services/profileFirestore.ts': {
    verdict: 'merge-update',
    why: 'shared profile-field writer for UserProfile and ProfileEnrichmentPrompt',
  },
  'services/behaviorTracker.ts': {
    verdict: 'merge-update',
    why: 'writes the private/personalization SUBcollection, not the subscriber document itself',
  },
  'components/preferences/SubscriptionPreferencesController.tsx': {
    verdict: 'recorded-not-shown',
    why: 'the authenticated in-app toggle: a signed-in visitor turning the newsletter back on for their own address writes status + the confirmation stamp (deliberately, #5686) and records no formula — the act is a toggle they operated, not a form they read',
    issue: '#5720',
    onFire:
      'good, but the formula has to describe a TOGGLE, not a signup — reusing communicationsOptIn here would record "accetto di ricevere" for somebody who only flipped a switch they already owned',
  },

  'App.tsx': {
    verdict: 'recorded-not-shown',
    why: 'the auth listener fires AFTER a sign-in completes, from a component that renders no gate of its own; the win-back branch runs on an emailed link with no UI at all',
    issue: '#5726 / #5712',
    onFire:
      'good — but check WHICH key: a rendered notice here also fixes SaveSignInPromptModal\'s social branch, which currently has none',
  },
  'services/authService.ts': {
    verdict: 'recorded-not-shown',
    why: 'Google One Tap draws its own prompt in a cross-origin iframe; there is no surface of ours to render a notice into',
    issue: '#5712',
    onFire:
      'STOP unless the notice is genuinely on screen BEFORE the One Tap prompt — a notice rendered after the credential is returned is not a disclosure at collection',
  },
  'hooks/useUserState.ts': {
    verdict: 'unreachable',
    why: 'calls the upsert wrapper it is handed as an argument; nothing imports the hook either',
    issue: '#5712',
  },
};

/**
 * The signup paths, derived from disk rather than listed.
 *
 * `services/newsletterSubscribers.ts` is excluded because it DEFINES the two
 * functions — including the guard that makes a text mandatory — rather than
 * calling them from a gate.
 */
function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

function discoverSignupPaths(): string[] {
  const files = ['App.tsx', ...walk('components'), ...walk('hooks'), ...walk('services')];
  return files
    .filter((rel) => rel !== 'services/newsletterSubscribers.ts')
    .filter((rel) => CREATES_SUBSCRIBER.test(stripComments(read(rel))))
    .sort();
}

/**
 * Every `consentProof(...)` call in a file, sliced on balanced parentheses.
 *
 * Not a flat regex on purpose: two call sites choose the key with a ternary
 * spread across lines (`isTrustedAuthSource ? 'communicationsSignIn' :
 * 'communicationsOptIn'`), and a regex anchored on the first argument read
 * them as "passes no consent proof" — i.e. it would have reported the two
 * richest gates as uncovered while they were the best covered.
 */
function consentProofCalls(src: string): string[] {
  const clean = stripComments(src);
  const calls: string[] = [];
  const needle = 'consentProof(';
  let at = clean.indexOf(needle);
  while (at >= 0) {
    let depth = 0;
    let quote: string | null = null;
    let i = at + needle.length - 1;
    for (; i < clean.length; i += 1) {
      const ch = clean[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(clean.slice(at + needle.length, i));
    at = clean.indexOf(needle, i);
  }
  return calls;
}

/** Split one call's argument list on the commas that are not nested. */
function topLevelArgs(call: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < call.length; i += 1) {
    const ch = call[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(call.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = call.slice(start).trim();
  if (tail) args.push(tail);
  return args.filter(Boolean);
}

/** Register keys a file hands to `consentProof`, in source order. */
function proofKeysIn(src: string): ConsentTextKey[] {
  const keys: ConsentTextKey[] = [];
  for (const call of consentProofCalls(src)) {
    const first = topLevelArgs(call)[0] ?? '';
    for (const m of first.matchAll(/'([A-Za-z0-9_]+)'/g)) {
      if (m[1] in CONSENT_TEXTS) keys.push(m[1] as ConsentTextKey);
    }
  }
  return keys;
}

/** Register keys a file renders through `<ConsentNotice consentKey="…">`. */
function renderedKeysIn(src: string): ConsentTextKey[] {
  const clean = stripComments(src);
  return [...clean.matchAll(/<ConsentNotice[^>]*consentKey="([A-Za-z0-9_]+)"/g)].map(
    (m) => m[1] as ConsentTextKey,
  );
}

const DISPLAYED_KEYS = Object.entries(CONSENT_TEXTS)
  .filter(([, p]) => p.displayed)
  .map(([k]) => k as ConsentTextKey);

/**
 * The four locales of one entry, joined — the identity of a SENTENCE.
 *
 * Two register entries are the same disclosure when a visitor in any of the
 * four languages reads the same characters. `communicationsSignIn` and
 * `communicationsSignInEmail` are the same disclosure and different acts; a
 * comparison on `it` alone would also call them equal after somebody edited
 * only the German half of one, which is the divergence #5712 was about.
 */
function sentenceOf(key: ConsentTextKey): string {
  return CONSENT_LOCALES.map((l) => consentDisplayText(key, l)).join(' | ');
}

/**
 * Everything wrong with one call site, as a list of sentences a human can act
 * on. Pure, and given the source rather than a path, so the block at the bottom
 * of this file can run it against gates that do NOT exist in this repo —
 * a gate rendering two notices, a gate whose notice contradicts its document —
 * and prove the checker fails on them.
 *
 * That block is not ceremony. #5764's lesson, paid for four times: a guard
 * exercised only on a population where the defect is already absent is
 * indistinguishable from a guard that works. Every rule here is therefore run
 * once against a source that breaks it.
 */
function consentGateViolations(src: string, declaredNotices: number): string[] {
  const problems: string[] = [];
  const stored = proofKeysIn(src);
  const rendered = renderedKeysIn(src);

  if (!/from '@\/services\/consentTexts'/.test(src)) problems.push('does not import the register');
  if (stored.length === 0) problems.push('passes no consent proof');

  // ONE notice per gate surface, and no more. This is the #5765 counter.
  if (rendered.length !== declaredNotices) {
    problems.push(
      `renders ${rendered.length} <ConsentNotice> but declares ${declaredNotices} gate surface(s) — ` +
        'a gate showing two notices makes two statements about one decision, and stores one of them',
    );
  }

  // …and one sentence per file. The two access-gate entries share a sentence,
  // so this stays satisfiable at a gate with two acts, while a screen carrying
  // both the sign-in wording and the opt-in wording cannot pass it.
  const renderedSentences = new Set(rendered.map(sentenceOf));
  if (renderedSentences.size > 1) {
    problems.push(
      `renders ${renderedSentences.size} different consent sentences — they cannot coexist in one view`,
    );
  }

  // What is stored has to be what was on screen, character for character, in
  // every locale. Comparing sentences and not keys is what lets one notice
  // cover two acts without either document quoting something else.
  for (const key of stored) {
    if (!CONSENT_TEXTS[key]?.displayed) continue;
    if (!renderedSentences.has(sentenceOf(key))) {
      problems.push(
        `stores '${key}' (displayed: true) but no <ConsentNotice> here renders that exact sentence — ` +
          'either render it or store a displayed:false formula',
      );
    }
  }

  // The mirror image: a notice next to a gate that records something else is
  // the show/store divergence, dressed as compliance.
  const storedSentences = new Set(stored.map(sentenceOf));
  for (const key of rendered) {
    if (!storedSentences.has(sentenceOf(key))) {
      problems.push(
        `renders '${key}' but stores no formula with that sentence — ` +
          'the visitor would read one sentence and the document would keep another',
      );
    }
  }

  return problems;
}

/**
 * The mirror rule, for a call site that deliberately shows nothing.
 *
 * It may store as many formulas as it likes; what it may not do is store one
 * that CLAIMS to have been shown. Same asymmetry as everywhere else in this
 * file — a missing proof is a gap, a fabricated one is a defence that collapses
 * — and pulled out of the assertion below so the shape can be driven at the
 * bottom of this file. It cannot be sampled from the repo: a call site with
 * this defect is exactly what the assertion forbids.
 */
function recordedNotShownViolations(src: string): ConsentTextKey[] {
  return proofKeysIn(src).filter((k) => CONSENT_TEXTS[k]?.displayed);
}

describe('every signup path is classified', () => {
  const paths = discoverSignupPaths();

  it('the discovery found the signup paths at all', () => {
    // Guards the scan itself: a broken filter would make every assertion below
    // pass vacuously.
    expect(paths.length).toBeGreaterThan(15);
    expect(paths).toContain('App.tsx');
    expect(paths).toContain('components/community/NewsletterPopup.tsx');
    expect(paths).toContain('services/authService.ts');
  });

  it('no signup path is missing a verdict — a new one must declare one here', () => {
    const undeclared = paths.filter((p) => !(p in VERDICTS));
    expect(
      undeclared,
      'a new signup path must say whether it shows the person the formula it stores, and why',
    ).toEqual([]);
  });

  it('no verdict is stale — every entry still names a file that can create a subscriber', () => {
    const orphaned = Object.keys(VERDICTS).filter((p) => !paths.includes(p));
    expect(orphaned, 'this file no longer creates subscribers — delete its entry').toEqual([]);
  });
});

describe('the verdicts hold', () => {
  const entries = Object.entries(VERDICTS);
  const shown = entries.filter(([, v]) => v.verdict === 'shown');
  const notShown = entries.filter(([, v]) => v.verdict === 'recorded-not-shown');
  const unreachable = entries.filter(([, v]) => v.verdict === 'unreachable');

  it.each(shown)('%s shows, once per gate, the exact sentence it stores', (file, v) => {
    const { notices } = v as Extract<Verdict, { verdict: 'shown' }>;
    expect(consentGateViolations(read(file), notices), file).toEqual([]);
  });

  it.each(shown)('%s passes the visitor locale to every proof it stores', (file) => {
    // Storing the Italian string for a German reader is the specific defect
    // this argument closes, so the third argument is required wherever a
    // displayed formula is stored.
    for (const call of consentProofCalls(read(file))) {
      const args = topLevelArgs(call);
      const keys = [...(args[0] ?? '').matchAll(/'([A-Za-z0-9_]+)'/g)]
        .map((m) => m[1])
        .filter((k): k is ConsentTextKey => k in CONSENT_TEXTS);
      if (!keys.some((k) => CONSENT_TEXTS[k].displayed)) continue;
      expect(
        args.length,
        `${file}: consentProof(${args[0]}, …) is missing the locale argument`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(notShown)('%s still stores only formulas nobody has been shown', (file, v) => {
    const g = v as Extract<Verdict, { verdict: 'recorded-not-shown' }>;
    expect(
      recordedNotShownViolations(read(file)),
      `${file} now stores a displayed formula — ${g.onFire} (${g.issue})`,
    ).toEqual([]);
  });

  it.each(shown)('%s asserts consent_given only where a box is really ticked', (file) => {
    /**
     * THE LINE BETWEEN "WAS SHOWN" AND "AGREED", and the reason they are two
     * fields (#5712, #5718 item 1).
     *
     * `consent_text_displayed` is now true at sixteen gates. `consent_given`
     * must NOT follow it: a rendered notice above a submit button proves a
     * disclosure, not a decision. Four gates carry a real checkbox the visitor
     * has to tick before the form submits — those may assert it. Four others
     * asserted `consentGiven: true` with no checkbox anywhere in the file, and
     * this PR removed the claim rather than the notice.
     *
     * The stake is not cosmetic. `hasAffirmativeJobAlertConsent`
     * (functions/src/jobAlertBackfillCore.js) needs consent_given AND
     * displayed AND a text naming the alert channel: the first gate where all
     * three are true is the one that re-opens job-alert creation. Letting a
     * checkbox-less gate assert the first condition would re-open it for
     * people who never asked — the shape of #5705, which produced 6.308
     * unrequested alerts.
     */
    const src = stripComments(read(file));
    if (!/consentGiven:\s*true/.test(src)) return;
    expect(
      src,
      `${file} asserts consent_given: true but renders no consent checkbox — a shown notice is not a ticked box`,
    ).toMatch(/type="checkbox"/);
    expect(
      src,
      `${file} asserts consent_given: true but nothing blocks submit on an unticked box`,
    ).toMatch(/if \(!consentChecked\)/);
  });

  it.each(entries.filter(([, v]) => v.verdict === 'merge-update'))(
    '%s never writes the fields that would establish a subscription',
    (file) => {
      // The line between "updates a subscriber" and "creates one". These files
      // may merge a preference onto a document; the day one of them writes a
      // status or an isActive it is making somebody a subscriber, and it needs
      // a consent text like every other path here.
      const src = stripComments(read(file));
      expect(src, `${file} writes a subscription status`).not.toMatch(/status:\s*'(subscribed|confirmed|pending)'/);
      expect(src, `${file} writes isActive`).not.toMatch(/isActive:\s*(true|false)/);
      // And it merges rather than replaces, so an existing document — consent
      // text included — cannot be wiped by a profile save.
      expect(src, `${file} must write with { merge: true }`).toMatch(/merge:\s*true/);
    },
  );

  it.each(unreachable)('%s is still imported by nothing outside tests', (file) => {
    const moduleName = path.basename(file).replace(/\.tsx?$/, '');
    const importers = ['App.tsx', ...walk('components'), ...walk('hooks'), ...walk('services')]
      .filter((rel) => rel !== file)
      .filter((rel) => new RegExp(`from '[^']*${moduleName}'`).test(read(rel)));
    expect(
      importers,
      `${file} is now reachable — give it a real verdict, and check it stores a consent text`,
    ).toEqual([]);
  });

});

/**
 * THE SCREENS THAT SUBSCRIBE SOMEBODY WITHOUT WRITING ANYTHING (#5739).
 *
 * `discoverSignupPaths` defines a signup path as a file that WRITES the
 * document, and that rule has one blind spot, with a name: a screen can put a
 * provider button in front of an anonymous visitor and let the auth listener in
 * `App.tsx` do the write. Nothing in such a file matches `CREATES_SUBSCRIBER`,
 * so every rule above passes over it — and the visitor is a subscriber anyway.
 *
 * This is #5764's question asked of this file: what shape has the population
 * never contained? Not "a gate with the wrong notice" — that one is sampled ten
 * times over. It is "a gate that is not a gate by our own definition". Measured
 * on the tree that produced this block: twenty-two files open a federated
 * sign-in, five of them show the visitor NOTHING before the write, and not one
 * of the five was visible to any assertion in this file.
 *
 * WHAT THIS BLOCK DOES NOT DO, and why that is the point. It does not demand a
 * notice on those five. The write for a provider click stores
 * `signInAutoSubscribe`/`chatbotSignIn`, and those are Italian-only,
 * `displayed: false` entries; rendering `communicationsSignIn` next to the
 * button would put one sentence on screen and keep another in the document,
 * which is worse than silence, because it manufactures a proof instead of
 * leaving one missing. `SaveSignInPromptModal` says exactly this at its own
 * provider buttons and has since #5712.
 *
 * So the rule enforced here is the one that IS available, and it is the one
 * nothing else guards: a surface may show nothing, but nothing may CLAIM to
 * have been shown. Flipping `signInAutoSubscribe` to `displayed: true` — the
 * tempting one-line "fix", and the one App.tsx's own `onFire` note warns about
 * — turns every silent screen below into a false record, and until now the
 * whole suite would have stayed green while it happened.
 */
const OPENS_FEDERATED_SIGNIN =
  /<SocialSignInButtons|renderGoogleButton(WithReadiness)?\s*\(|signInWithLinkedIn\s*\(|promptOneTap\s*\(/;

type SignInSurface =
  /**
   * Writes the provider branch itself, with the notice for it on screen. Fully
   * covered by the VERDICTS table above; declared here so the two populations
   * cannot silently disagree about which files those are.
   */
  | { consent: 'self'; why: string }
  /**
   * Renders a notice for its OWN email branch. The provider click beside it is
   * written by the App.tsx listener under a `displayed: false` formula, so the
   * document claims nothing about what that visitor read.
   */
  | { consent: 'email-branch-only'; why: string }
  /** Shows nothing at all before the write, which happens in App.tsx. */
  | { consent: 'none'; why: string; issue: string }
  /** Neither a gate nor a visitor surface. */
  | { consent: 'not-a-gate'; why: string };

const SIGN_IN_SURFACES: Record<string, SignInSurface> = {
  'App.tsx': {
    consent: 'not-a-gate',
    why: 'this file IS the listener that writes; the only button it mounts itself is the admin re-auth, and its One Tap prompt is drawn by Google in a cross-origin iframe (see services/authService.ts above)',
  },
  'components/shared/SocialSignInButtons.tsx': {
    consent: 'not-a-gate',
    why: 'the shared control, mounted by eight of the files below — it records nothing and belongs to whichever screen renders it',
  },

  'components/community/JobBoard.tsx': {
    consent: 'self',
    why: 'both gate surfaces write the provider branch as communicationsSignIn and render that sentence',
  },
  'components/fisco/TaxCalendar.tsx': {
    consent: 'self',
    why: 'the reminder panel writes communicationsSignIn and renders it',
  },
  'components/pages/PublisherPublishPage.tsx': {
    consent: 'self',
    why: 'the publish gate writes communicationsSignIn and renders it',
  },

  'components/community/NewsletterPopup.tsx': { consent: 'email-branch-only', why: 'checkbox form' },
  'components/shared/SubscriptionCTA.tsx': { consent: 'email-branch-only', why: 'checkbox form' },
  'components/shared/PdfDownloadGate.tsx': { consent: 'email-branch-only', why: 'checkbox form' },
  'components/community/OfferwallNewsletterGate.tsx': {
    consent: 'email-branch-only',
    why: 'checkbox form',
  },
  'components/community/Newsletter.tsx': { consent: 'email-branch-only', why: 'two address forms' },
  'components/community/WeeklyDigest.tsx': { consent: 'email-branch-only', why: 'subscribe row' },
  'components/shared/LeadMagnetCTA.tsx': {
    consent: 'email-branch-only',
    why: 'two guide-for-address forms',
  },
  'components/calculator/MobileCalcLayout.tsx': {
    consent: 'email-branch-only',
    why: 'analysis-gate email form',
  },
  'components/community/JobOrphanView.tsx': { consent: 'email-branch-only', why: 'unlock form' },
  'components/community/JobBridgeView.tsx': { consent: 'email-branch-only', why: 'unlock form' },
  'components/community/JobExpiredView.tsx': { consent: 'email-branch-only', why: 'unlock form' },
  'components/community/SaveSignInPromptModal.tsx': {
    consent: 'email-branch-only',
    why: 'the file that states this position in its own source, and the reason it is a position and not an oversight',
  },

  'components/pages/SubscribePage.tsx': {
    consent: 'none',
    issue: '#5739',
    why: 'the paid-plan page: provider buttons, an email/password login and a checkout button, none of which writes a subscriber — the App.tsx listener does, under signInAutoSubscribe',
  },
  'components/pages/JournalistDashboardPage.tsx': {
    consent: 'none',
    issue: '#5739',
    why: 'the press-room sign-in gate, same shape and same writer',
  },
  'components/calculator/CalculatorPaywall.tsx': {
    consent: 'none',
    issue: '#5739',
    why: 'the calculator paywall offers Google and LinkedIn and writes nothing itself',
  },
  'components/shared/AiChatbot.tsx': {
    consent: 'none',
    issue: '#5739',
    why: 'the assistant asks the visitor to sign in to continue the conversation; App.tsx writes it under chatbotSignIn, whose text says in so many words that no consent box was offered',
  },
  'components/pages/UserProfile.tsx': {
    consent: 'none',
    issue: '#5739',
    why: 'the profile page draws its own sign-in when nobody is signed in; its VERDICTS entry above covers only the preference merge it performs afterwards',
  },
};

/**
 * What the listener stores for a provider click, read from App.tsx rather than
 * listed — `act: 'authentication'` is what makes a key the answer to "somebody
 * pressed a provider button", and it is the field that cannot be faked without
 * misdescribing the gesture. `resubscribeLink` is deliberately excluded by that
 * filter: an emailed link is not a button on any of these screens.
 */
const AUTH_LISTENER_KEYS = proofKeysIn(read('App.tsx')).filter(
  (k) => CONSENT_TEXTS[k].act === 'authentication',
);

/**
 * The one rule a silent screen can still break, as a pure function so the
 * shapes below can be driven against it.
 *
 * Reads the same way round as the register: `displayed: false` is not a defect
 * here, it is the honest answer. Only a formula that CLAIMS to have been shown
 * has to actually be on screen.
 */
function falseProofViolations(
  surfaceSrc: string,
  writerKeys: readonly ConsentTextKey[],
): string[] {
  const rendered = new Set(renderedKeysIn(surfaceSrc).map(sentenceOf));
  return writerKeys
    .filter((k) => CONSENT_TEXTS[k].displayed && !rendered.has(sentenceOf(k)))
    .map(
      (k) =>
        `the provider click on this screen is written as '${k}' (displayed: true) and this screen ` +
        'never renders that sentence — the document would claim a disclosure that did not happen',
    );
}

describe('every screen that opens a federated sign-in is classified (#5739)', () => {
  function discoverSignInSurfaces(): string[] {
    return ['App.tsx', ...walk('components')]
      .filter((rel) => OPENS_FEDERATED_SIGNIN.test(stripComments(read(rel))))
      .sort();
  }
  const surfaces = discoverSignInSurfaces();
  const entries = Object.entries(SIGN_IN_SURFACES);

  it('the discovery found the sign-in surfaces at all', () => {
    expect(surfaces.length).toBeGreaterThan(15);
    expect(surfaces).toContain('components/shared/SocialSignInButtons.tsx');
    expect(surfaces).toContain('components/pages/SubscribePage.tsx');
    // The listener's own keys have to exist, or every rule below is vacuous.
    expect(AUTH_LISTENER_KEYS.length, 'App.tsx no longer stores an authentication formula').toBeGreaterThan(0);
  });

  it('no sign-in surface is missing a classification', () => {
    expect(
      surfaces.filter((p) => !(p in SIGN_IN_SURFACES)),
      'a new screen with a provider button must say what it shows before the listener writes',
    ).toEqual([]);
  });

  it('no classification is stale', () => {
    expect(
      Object.keys(SIGN_IN_SURFACES).filter((p) => !surfaces.includes(p)),
      'this file no longer opens a federated sign-in — delete its entry',
    ).toEqual([]);
  });

  it.each(entries)('%s: no screen claims a disclosure it did not make', (file) => {
    expect(falseProofViolations(read(file), AUTH_LISTENER_KEYS), file).toEqual([]);
  });

  it.each(entries.filter(([, v]) => v.consent === 'self'))(
    '%s really does write the provider branch itself',
    (file) => {
      // The discriminator, mechanical rather than declared: only an
      // `authentication` act describes a provider click, so a file claiming to
      // cover its own social branch has to store one.
      const acts = proofKeysIn(read(file)).map((k) => CONSENT_TEXTS[k].act);
      expect(acts, `${file} stores no authentication formula — its provider click is App.tsx's`)
        .toContain('authentication');
      expect(VERDICTS[file]?.verdict, `${file} must also carry a 'shown' verdict above`).toBe('shown');
    },
  );

  it.each(entries.filter(([, v]) => v.consent === 'email-branch-only'))(
    '%s shows its own branch and leaves the provider branch to the listener',
    (file) => {
      const src = read(file);
      expect(renderedKeysIn(src).length, `${file} renders no notice — classify it as 'none'`)
        .toBeGreaterThan(0);
      expect(
        proofKeysIn(src).map((k) => CONSENT_TEXTS[k].act),
        `${file} now stores an authentication formula — reclassify it as 'self'`,
      ).not.toContain('authentication');
    },
  );

  it.each(entries.filter(([, v]) => v.consent === 'none'))(
    '%s shows nothing, and stores nothing either',
    (file) => {
      // Both halves matter. Showing nothing is a declared gap; STORING something
      // while showing nothing on a file the VERDICTS table cannot see would be
      // the original defect, reached through the blind spot instead of the door.
      const src = read(file);
      expect(renderedKeysIn(src), `${file} now renders a notice — reclassify it`).toEqual([]);
      expect(
        proofKeysIn(src).filter((k) => CONSENT_TEXTS[k].displayed),
        `${file} stores a displayed formula and shows nothing`,
      ).toEqual([]);
    },
  );

  it('counts the silent screens instead of leaving them to be discovered', () => {
    // Not a threshold to be tuned: the list IS the report. It went from
    // "invisible" to five, and a sixth has to be added here on the day it ships.
    const silent = entries.filter(([, v]) => v.consent === 'none').map(([f]) => f);
    expect(silent.sort()).toEqual(
      [
        'components/calculator/CalculatorPaywall.tsx',
        'components/pages/JournalistDashboardPage.tsx',
        'components/pages/SubscribePage.tsx',
        'components/pages/UserProfile.tsx',
        'components/shared/AiChatbot.tsx',
      ].sort(),
    );
  });

  /**
   * The rule driven in both directions, because the failing half cannot be
   * sampled: the repo would have to contain the defect for that, and this is
   * what keeps it out. Sources, not files, for the same reason as the block at
   * the bottom of this file.
   */
  describe('the rule fails on the shape it exists to catch', () => {
    const silent = '<div><SocialSignInButtons locale={locale} /></div>';
    const withNotice = `<div><SocialSignInButtons locale={locale} />
      <ConsentNotice consentKey="communicationsSignIn" locale={locale} /></div>`;

    it('passes a silent screen while the listener stores a displayed:false formula', () => {
      // The position this repo is in, and the one it may stay in: a gap, stated.
      expect(falseProofViolations(silent, ['signInAutoSubscribe'])).toEqual([]);
      expect(falseProofViolations(silent, ['chatbotSignIn'])).toEqual([]);
    });

    it('fails a silent screen the moment that formula claims to have been shown', () => {
      // Somebody flips `displayed` without touching any screen. Every assertion
      // in this file was green through that change until now.
      expect(falseProofViolations(silent, ['communicationsSignIn']).join('\n'))
        .toMatch(/never renders that sentence/);
    });

    it('passes the screen that does render the sentence being stored', () => {
      expect(falseProofViolations(withNotice, ['communicationsSignIn'])).toEqual([]);
    });

    it('is not satisfied by a notice that only exists in a comment', () => {
      expect(
        falseProofViolations(
          `{/* <ConsentNotice consentKey="communicationsSignIn" /> */}${silent}`,
          ['communicationsSignIn'],
        ).join('\n'),
      ).toMatch(/never renders that sentence/);
    });

    it('compares the sentence and not the key, like every other rule here', () => {
      // `communicationsSignInEmail` is byte-identical to `communicationsSignIn`
      // in all four locales; a screen rendering either has shown both.
      expect(falseProofViolations(withNotice, ['communicationsSignInEmail'])).toEqual([]);
      expect(falseProofViolations(withNotice, ['communicationsOptIn']).join('\n'))
        .toMatch(/never renders that sentence/);
    });
  });
});

describe('ConsentNotice renders the bytes that get stored', () => {
  it.each(DISPLAYED_KEYS.flatMap((key) => CONSENT_LOCALES.map((l) => [key, l] as const)))(
    '%s in %s: the rendered text equals the stored text, character for character',
    (key, locale) => {
      const { container, unmount } = render(<ConsentNotice consentKey={key} locale={locale} />);
      const stored = consentProof(key, 'email_checkbox', locale).consentText;
      expect(container.textContent).toBe(stored);
      expect(stored).toBe(consentDisplayText(key, locale));
      unmount();
    },
  );

  it('links the channel list without altering a character of the formula', () => {
    const { container, unmount } = render(
      <ConsentNotice consentKey="communicationsOptIn" locale="it" />,
    );
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe(CONSENT_PAGE_PATH);
    expect(link?.textContent).toBe(CONSENT_PAGE_LABEL);
    expect(container.textContent).toBe(CONSENT_TEXTS.communicationsOptIn.text);
    unmount();
  });

  it('falls back to Italian rather than rendering nothing for an unknown locale', () => {
    const { container, unmount } = render(
      <ConsentNotice consentKey="communicationsOptIn" locale="pt-BR" />,
    );
    expect(container.textContent).toBe(CONSENT_TEXTS.communicationsOptIn.text);
    unmount();
  });
});

describe('what the displayed formulas may and may not say', () => {
  const displayed = DISPLAYED_KEYS.map((k) => CONSENT_TEXTS[k]);

  it('states no cadence, in any locale', () => {
    // The rule the whole design turns on (#5679): a frequency inside a consent
    // formula cannot change without collecting consent again. "settimanale"
    // was in the popup formula while the weekly workflow ran daily and a
    // separate brief shipped twice a day.
    const CADENCE_WORDS =
      /\b(settimanal\w*|quotidian\w*|giornalier\w*|mensil\w*|weekly|dail(y|ies)|monthly|wöchentlich\w*|täglich\w*|monatlich\w*|hebdomadaire\w*|quotidien\w*|mensuel\w*)\b/i;
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(
          proof.texts?.[locale],
          `${proof.id}/${locale} names a cadence — the cadence belongs on ${CONSENT_PAGE_LABEL}`,
        ).not.toMatch(CADENCE_WORDS);
      }
    }
  });

  it('names the channel list, so the missing cadence is findable', () => {
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(proof.texts?.[locale], `${proof.id}/${locale}`).toContain(CONSENT_PAGE_LABEL);
      }
    }
  });

  it('says where the controller is named, and the page says who it is', () => {
    /**
     * art. 19 nLPD, and the point of #5675: the recipient of an unwanted email
     * must be able to tell who to write to. Until #5765 the formula carried the
     * name and the address itself; it now carries the QUESTION and the address
     * of the page that answers it, because a ~700-character paragraph at the
     * moment of deciding is read by nobody.
     *
     * That is a relocation only if the page really carries it, so the second
     * half is asserted here and not assumed. Deleting the controller section
     * from the page fails this test, which is the only thing standing between
     * "the disclosure moved" and "the disclosure went".
     */
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(proof.texts?.[locale], `${proof.id}/${locale} must ask the controller question`)
          .toMatch(/chi tratta i dati|who processes the data|wer die Daten bearbeitet|qui traite les données/);
        expect(proof.texts?.[locale], `${proof.id}/${locale}`).toContain(CONSENT_PAGE_LABEL);
      }
    }
    // Read as text, never imported — see the note on the plugin assertion below.
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    expect(plugin, 'the page must print the controller identity').toMatch(/DATA_CONTROLLER_FOOTER_LINE\[locale\]/);
    expect(plugin, '…from the single source, so it cannot drift from the mail footers')
      .toMatch(/from '\.\.\/functions\/src\/lib\/dataControllerIdentity\.js'/);
    expect(plugin, 'and it must link the full privacy notice').toMatch(/PRIVACY_PATH\[locale\]/);
  });

  it('no longer names the job-alert channel — and that closes a path, on purpose', () => {
    /**
     * THE COST OF THE SHORT FORMULA, ASSERTED SO IT CANNOT BE A SURPRISE.
     *
     * `consentNamesJobAlerts` (functions/src/jobAlertBackfillCore.js) matches
     * "avvisi di lavoro" / "job alert" / "Stellenbenachrichtigung" /
     * "alertes d'emploi" — the CHANNEL, never "offerte di lavoro", which names
     * the content of a page. Between #5712 and #5765 the displayed formula
     * enumerated the categories, so it contained those words, so a checkbox
     * gate could satisfy `hasAffirmativeJobAlertConsent` and open a job alert.
     *
     * #5765 moved the categories to `/comunicazioni/`. No displayed formula
     * names the channel any more, and that path is fail-closed again. Stated
     * here rather than discovered in a funnel report: it is a consequence of an
     * owner decision about the wording, and re-opening it means naming the
     * channel in the sentence — which is a wording decision, not a code one.
     *
     * The assertion is two-directional on purpose. It fails if a formula
     * quietly starts naming the channel again (that would re-open alert
     * creation for people who agreed to a one-line notice), and it fails if
     * `consentNamesJobAlerts` stops recognising the phrases at all, which would
     * make the check vacuous.
     */
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(
          consentNamesJobAlerts(proof.texts?.[locale]),
          `${proof.id}/${locale} names the job-alert channel — that re-opens automatic alert creation, see #5765`,
        ).toBe(false);
      }
    }
    expect(consentNamesJobAlerts('ricevo gli avvisi di lavoro'), 'the matcher itself has rotted').toBe(true);
    // The category is still LIVE and still described — on the page, where the
    // formula now sends the reader.
    expect(hasLiveChannel('jobs')).toBe(true);
    expect(read('build-plugins/communicationsPagePlugin.ts')).toContain('Avvisi di lavoro');
  });

  /**
   * THE TEST THAT USED TO FORBID THIS, TURNED AROUND (#5759).
   *
   * It read "says nothing that would let third-party advertising in" and it
   * matched `/pubblicit|advertis|werb|…/` against every displayed formula,
   * refusing any wording that admitted the channel. That was right while the
   * decision was open: naming advertising in a formula authorises
   * `blast-publisher-ads.mjs` against people who never agreed to it, and the
   * choice was the owner's (#5712).
   *
   * The owner made it on 2026-08-13 (#5764 §3): advertising IS named, as its
   * own category, and the compensating control is a switch. So the assertion
   * has to change direction — a guard that still forbade the wording would now
   * be defending a decision nobody holds, and it would fail the moment somebody
   * implemented the one that was taken.
   *
   * It demands BOTH halves, and that pairing is the substance of it. Named
   * without a switch is a disclosure that took a right away; a switch without
   * the naming is a control over something nobody was told about. Either alone
   * is worse than the null category they replaced, so neither can be shipped
   * alone.
   *
   * The word is checked on the PAGE and not in the formula, because that is
   * where #5765 put every category: a "name it" that re-inflated the one-line
   * sentence would undo the shortening the owner asked for and tell the reader
   * nothing the page does not already say.
   */
  describe('third-party advertising is named where the categories live, and can be switched off (#5759)', () => {
    const ADVERTISING =
      /\b(pubblicit\w*|inserzionist\w*|sponsor\w*|advertis\w*|werb\w*|publicitaire\w*)\b/i;
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    const controller = read('components/preferences/SubscriptionPreferencesController.tsx');
    const matcher = read('services/publisherBlastMatch.mjs');

    it('gives publisher-blast a consent category of its own', () => {
      const blast = COMMUNICATION_CHANNELS.find((c) => c.id === 'publisher-blast');
      expect(blast?.consentCategory, 'the owner decided on 2026-08-13 — see #5764 §3').toBe(
        'advertising',
      );
      // A category and not a nearest fit. Filing it under editorial is the
      // shortcut that produced the 6.308 unrequested job alerts (#5705), and it
      // would be invisible here if the assertion were merely `not.toBeNull()`.
      expect(blast?.consentCategory).not.toBe('editorial');
      expect(CONSENT_CATEGORIES).toContain('advertising');
    });

    it('names it on the page, in all four locales', () => {
      // The page heads a section per category and the formula points at the
      // page, so this heading IS the naming the owner's decision calls for.
      for (const heading of [
        'Pubblicità di terzi',
        'Third-party advertising',
        'Werbung Dritter',
        'Publicité de tiers',
      ]) {
        expect(plugin, `/comunicazioni/ must name advertising as "${heading}"`).toContain(heading);
      }
      expect(plugin, 'and the section needs its own note, or "opt-out" is never stated to the reader')
        .toMatch(/CATEGORY_NOTE/);
    });

    it('keeps the one-line formula short — the naming lives on the page, not in the sentence', () => {
      // The other half of "name it": #5765 shortened these to one line on the
      // owner's instruction, so satisfying #5759 by growing them again would
      // trade one owner decision for another.
      for (const proof of displayed) {
        for (const locale of CONSENT_LOCALES) {
          expect(
            proof.texts?.[locale],
            `${proof.id}/${locale} should point at the page, not enumerate the category`,
          ).not.toMatch(ADVERTISING);
          expect(proof.texts?.[locale]).toContain(CONSENT_PAGE_LABEL);
        }
      }
    });

    it('gives it a switch in the preference centre, in both modes', () => {
      // Source-level, the convention tests/preference-center-coverage.test.ts
      // already uses for this component: its Firestore paths cannot render
      // without mocking the SDK.
      expect(controller, 'the card').toContain('adsTitle');
      expect(controller, 'the auth-mode writer').toContain('authSetAdvertisingOptOut');
      expect(controller, 'the token-mode writer').toContain('setAdvertisingEnabled');
      expect(controller, 'the handler behind the toggle').toContain('handleToggleAds');
      expect(controller).toContain(ADVERTISING_OPT_OUT_FIELD);
    });

    it('has the sender read the field the centre writes', () => {
      // Two deploy units, no import shape between them: without this the switch
      // is decorative and nothing else fails. Same reasoning as the digest's
      // `savedJobsDigest?.optedOut === true` check.
      expect(matcher).toContain(ADVERTISING_OPT_OUT_FIELD);
      expect(MATCHER_OPT_OUT_FIELD, 'the two spellings of the field must agree').toBe(
        ADVERTISING_OPT_OUT_FIELD,
      );
      expect(MATCHER_ADVERTISING_FROM, 'the two spellings of the naming date must agree').toBe(
        ADVERTISING_NAMED_FROM_PAGE_VERSION,
      );
    });

    it('anchors the naming date to a page revision that was really published', () => {
      // `ADVERTISING_NAMED_FROM_PAGE_VERSION` stopped deciding who may be
      // blasted on 2026-08-14 and became the date the page began naming the
      // category. A typo in it is still not cosmetic — it is now the number
      // that reports how many recipients were never told — so it must name a
      // revision that really shipped.
      expect(Object.keys(COMMUNICATIONS_PAGE_REVISIONS)).toContain(
        ADVERTISING_NAMED_FROM_PAGE_VERSION,
      );
      /**
       * …and it may not run ahead of the page: a naming date above the current
       * version would report people as untold whose sentence names advertising.
       *
       * ASKED THROUGH THE SENDER'S OWN COMPARISON, and not with `<=` on the two
       * strings (#5739, reviewer nit on #5777). `advertisingDisclosureWasShown`
       * compares on (date, revision) for a stated reason — `2026-08-13.10` is
       * not below `2026-08-13.2` — and a lexicographic compare here agrees with
       * it for nine revisions and then stops agreeing, on the one day the
       * difference exists. A test that decides the same question by a different
       * rule than the code is not a check on the code; it is a second
       * implementation, and the day they part company this one passes.
       *
       * It is asked of the SENTENCE a gate stores today rather than of the bare
       * identifier, because that string is what the sender will actually read
       * off a subscriber's document, in whichever locale the person signed up.
       */
      for (const locale of CONSENT_LOCALES) {
        expect(
          advertisingDisclosureWasShown({
            consent_text: consentDisplayText('communicationsOptIn', locale),
          }),
          `a consent collected today in ${locale} must be reported as told`,
        ).toBe(true);
      }
    });

    /**
     * THE SHAPES NO FIXTURE IN THIS REPO HAS, driven one by one (#5764).
     *
     * Every defect in the four issues before this one was a case the guard's
     * population did not contain, so "the suite is green" said nothing about
     * it. The three below are the ones this change creates, and none of them
     * can be sampled from the repo: they are documents, not files.
     */
    describe('the audience filter, driven with documents this repo does not contain', () => {
      const NAMED = `Iscrivo il mio indirizzo alle comunicazioni di Frontaliere Ticino. Cosa ricevo: ${CONSENT_PAGE_LABEL} (versione ${ADVERTISING_NAMED_FROM_PAGE_VERSION}).`;
      const OLD = NAMED.replace(ADVERTISING_NAMED_FROM_PAGE_VERSION, '2026-08-13.1');
      const ad = { title: 'Fisioterapista', category: 'health', locations: [] };
      const base = {
        job_search_query: 'Fisioterapista',
        status: 'confirmed',
        confirmed_at: '2026-08-13T12:00:00.000Z',
      };
      // minScore 0, so only a consent rule can decide who is dropped — with a
      // control in every case proving the matcher would otherwise take them.
      const audience = (rows: Array<Record<string, unknown>>) =>
        matchSubscribersForAd(ad, rows, { minScore: 0 }).map((r: { email: string }) => r.email);

      it('drops a subscriber who switched advertising off, and keeps the identical one who did not', () => {
        expect(
          audience([
            { email: 'off@example.com', ...base, consent_text: NAMED, [ADVERTISING_OPT_OUT_FIELD]: true },
            { email: 'on@example.com', ...base, consent_text: NAMED },
          ]),
        ).toEqual(['on@example.com']);
      });

      it('reads only an explicit `true` as off — the consent is an opt-out', () => {
        // `false` and absent are the SAME answer here and a different record:
        // the centre writes `false` after somebody looked at the switch and
        // left it on, which is evidence, and evidence must not change the send.
        expect(
          audience([
            { email: 'explicit-yes@example.com', ...base, consent_text: NAMED, [ADVERTISING_OPT_OUT_FIELD]: false },
            { email: 'never-asked@example.com', ...base, consent_text: NAMED },
          ]).sort(),
        ).toEqual(['explicit-yes@example.com', 'never-asked@example.com']);
      });

      /**
       * THE OWNER'S DECISION OF 2026-08-14, WHICH IS THIS BLOCK REVERSED.
       *
       * Until that day the three shapes below were dropped: a proof naming an
       * older page version, no `consent_text` at all, a text with no version in
       * it. Between them they were the whole list (8.505 of 8.605 documents had
       * no `consent_text`, measured 2026-08-12), which is what the owner was
       * told before answering — advertising must reach all of them.
       *
       * The assertion is inverted rather than deleted, and that is the point of
       * it. A missing test would leave the reach looking like the absence of a
       * check; a test that spells out "these four are recipients" makes it a
       * decision with a date on it, and the next person to consider tightening
       * it has to change a line that says so.
       */
      it('reaches the subscriber whose proof predates the page that named advertising', () => {
        expect(
          audience([
            { email: 'old-proof@example.com', ...base, consent_text: OLD },
            { email: 'no-proof-at-all@example.com', ...base },
            { email: 'unparseable@example.com', ...base, consent_text: 'Accetto le comunicazioni.' },
            { email: 'new-proof@example.com', ...base, consent_text: NAMED },
          ]).sort(),
        ).toEqual([
          'new-proof@example.com',
          'no-proof-at-all@example.com',
          'old-proof@example.com',
          'unparseable@example.com',
        ]);
        // …and the same four, seen through the predicate that still asks the
        // question the send no longer asks. Three of them were never told, and
        // the send log is where that shows up (scripts/blast-publisher-ads.mjs).
        expect(advertisingDisclosureWasShown({ consent_text: NAMED })).toBe(true);
        expect(advertisingDisclosureWasShown({ consent_text: OLD })).toBe(false);
        expect(advertisingDisclosureWasShown({})).toBe(false);
        expect(advertisingDisclosureWasShown({ consent_text: 'Accetto le comunicazioni.' })).toBe(false);
      });

      it('covers everybody, whatever the stored version says — including versions that do not exist', () => {
        // The gate is not "a wider floor", it is no floor: a version from
        // before the site existed and a malformed one answer the same as
        // today's. Written out because "returns true" is exactly the shape a
        // reader mistakes for a stub.
        for (const text of [
          `(versione ${ADVERTISING_NAMED_FROM_PAGE_VERSION})`,
          '(versione 2026-08-12.9)',
          '(versione 1999-01-01.1)',
          '(versione banana)',
          '',
        ]) {
          expect(consentCoversAdvertising({ consent_text: text }), text || '(empty)').toBe(true);
        }
        expect(consentCoversAdvertising({})).toBe(true);
        expect(consentCoversAdvertising(undefined)).toBe(true);
      });

      it('compares revisions numerically, so .10 is not below .2', () => {
        // A lexicographic compare would read `2026-08-13.10` as older than
        // `2026-08-13.2`. It no longer decides a send, but it still decides the
        // reported cohort, and a wrong count is what would be used to argue the
        // decision was cheaper than it was.
        expect(advertisingDisclosureWasShown({ consent_text: `(versione 2026-08-13.10)` })).toBe(true);
        expect(advertisingDisclosureWasShown({ consent_text: `(versione 2026-08-14.1)` })).toBe(true);
        expect(advertisingDisclosureWasShown({ consent_text: `(versione 2026-08-12.9)` })).toBe(false);
        expect(advertisingDisclosureWasShown({})).toBe(false);
        // The wrong answer, pinned as a literal so nobody can read the two
        // assertions above as belt-and-braces: on strings, `.10` really does
        // sort below `.2`, and the comparison is a `>=` on that pair.
        // This is the shape the assertion in the sibling test used to be
        // written in (#5739).
        expect('2026-08-13.10' < '2026-08-13.2').toBe(true);
      });
    });

    /**
     * A channel with NO category, told apart from one with an explicit `null`
     * — and answered the same way, which is the point.
     *
     * The page partitions the registry into "under a heading" and "covered by
     * no consent we collect". Before this change the second half was
     * `consentCategory === null`, so a channel that simply omitted the field
     * would have matched neither side and disappeared from the page — the
     * registry's whole failure mode, reached by a missing key instead of a
     * missing entry. Not sampleable: no such channel exists here, and the type
     * would reject one. These are plain objects.
     */
    it('treats an absent category, a null one and an unknown one all as uncovered', () => {
      expect(isUncoveredChannel({}), 'absent').toBe(true);
      expect(isUncoveredChannel({ consentCategory: null }), 'explicitly null').toBe(true);
      expect(isUncoveredChannel({ consentCategory: 'promo' as never }), 'unknown value').toBe(true);
      for (const cat of CONSENT_CATEGORIES) {
        expect(isUncoveredChannel({ consentCategory: cat }), cat).toBe(false);
      }
    });

    it('keeps the "covered by no consent" section although nothing is in it today', () => {
      // It emptied out when advertising got a category, and deleting it with
      // its last occupant would remove the only place the shape above can
      // surface. The page renders it conditionally, so an empty section costs
      // the reader nothing and a missing one costs the next channel everything.
      expect(COMMUNICATION_CHANNELS.filter(isUncoveredChannel), 'empty today').toEqual([]);
      expect(plugin).toContain('UNCONSENTED_HEADING');
      expect(plugin).toMatch(/COMMUNICATION_CHANNELS\.filter\(isUncoveredChannel\)/);
    });
  });
});

/**
 * THE SECOND OWNER DECISION OF 2026-08-14: what the consent has to NAME.
 *
 * The owner wants to be able to communicate subscriber data to third parties
 * for advertising and commercial purposes, and to transfer it with the business
 * if the site is sold. Under the nLPD a consent covers the purposes it names,
 * so "being able to" is a text problem before it is a code problem — and the
 * text lives on `/comunicazioni/`, because #5765 put every category there and
 * the one-line formula points at it.
 *
 * The three claims below are the ones a reader would have to find on the page
 * their stored proof names. They are asserted per LOCALE, not once: a consent
 * in a language the reader does not speak is not a consent, and the register's
 * own history here is the popup that SHOWED German and STORED Italian.
 *
 * Asserted against the plugin SOURCE rather than a render, for the reason
 * stated at the top of this file: importing a build plugin pulls ~12 files
 * under data/ and public/assets/ at module scope, which is green in CI and red
 * in a sparse worktree. The render-side guard is that the constants must be
 * referenced by `renderBody`, checked below — a locale table nobody renders is
 * exactly the shape this whole file exists to refuse.
 */
describe('the page names the recipients, the profiling and the business transfer (owner decision 2026-08-14)', () => {
  const plugin = read('build-plugins/communicationsPagePlugin.ts');
  /**
   * The same file with the comments taken out, and every NEGATIVE assertion is
   * made against this one.
   *
   * A comment is not the page. The block above `CATEGORY_NOTE` quotes the
   * exempting sentence it replaced — deliberately, so the next reader knows why
   * the wording is what it is — and a "the page must not say X" check run over
   * the raw source would fail on the explanation of why the page no longer says
   * it. That is the shape where a guard teaches people to delete their reasons.
   */
  const pluginCode = stripComments(plugin);
  const body = plugin.slice(plugin.indexOf('function renderBody('), plugin.indexOf('function homeUrl('));

  it('heads a recipients-and-purposes section, in all four locales', () => {
    for (const heading of [
      'A chi possono essere comunicati i tuoi dati, e per quali finalità',
      'Who your data may be shared with, and for what purposes',
      'An wen Ihre Daten weitergegeben werden können, und zu welchen Zwecken',
      'À qui vos données peuvent être communiquées, et à quelles fins',
    ]) {
      expect(plugin, `/comunicazioni/ must head "${heading}"`).toContain(heading);
    }
  });

  /**
   * (a) communication to third parties for advertising and marketing.
   *
   * By CATEGORY — "inserzionisti, agenzie e altri partner commerciali" — and
   * that is the load-bearing part, not a stylistic one: a text that named the
   * advertisers we have today would stop covering the ones we do not have yet,
   * which is the exact thing the owner asked to be able to do.
   */
  it('names third parties for advertising and marketing purposes, as categories', () => {
    for (const claim of [
      'inserzionisti, agenzie e altri partner commerciali',
      'advertisers, agencies and other commercial partners',
      'Inserenten, Agenturen und andere Geschäftspartner',
      'annonceurs, agences et autres partenaires commerciaux',
    ]) {
      expect(plugin).toContain(claim);
    }
    // …and no advertiser is named anywhere on the page, which is the same
    // property the category headings are built on (#5759).
    expect(pluginCode).not.toMatch(/\b(AdSense|DoubleClick|Criteo|Sovrn|Media\.net)\b/);
  });

  /** (b) profiling for commercial purposes — only what this repo actually does. */
  it('declares the profiling it really performs, and refuses the part it does not', () => {
    for (const claim of [
      'Profilazione a fini commerciali.',
      'Profiling for commercial purposes.',
      'Profilbildung zu kommerziellen Zwecken.',
      'Profilage à des fins commerciales.',
    ]) {
      expect(plugin).toContain(claim);
    }
    // The two halves that make it a description and not a formula. What is
    // declared is what `services/publisherBlastMatch.mjs`,
    // `functions/src/lib/engagementScore.js` and `services/newsletter-priority.mjs`
    // do — declared interests plus open/click behaviour — and what is denied is
    // denied because no code buys third-party data or takes automated decisions
    // with legal effect. A borrowed privacy paragraph would have claimed both
    // ways round and been evidence of nothing.
    expect(plugin).toContain('su quali link clicchi');
    expect(plugin).toContain('Non compriamo dati su di te da terzi');
    expect(plugin).toContain('decisioni automatizzate con effetti giuridici o economici');
  });

  /** (c) business transfer — the scenario the owner raised first. */
  it('states the transfer of data on a sale, merger or transfer of the business', () => {
    for (const claim of [
      'ceduto, conferito o fuso in un’altra azienda',
      'sold, contributed or merged into another company',
      'verkauft, eingebracht oder mit einem anderen Unternehmen fusioniert',
      'cédé, apporté ou fusionné dans une autre entreprise',
    ]) {
      expect(plugin, 'the business-transfer case has to be explicit, not implied').toContain(claim);
    }
  });

  it('carries NO omnibus clause — a catch-all does not extend a consent, it only reads as if it did', () => {
    /**
     * The rule this guards is not a style preference. A consent is valid for
     * DETERMINATE purposes; a clause reaching at "any other future purpose" is
     * inoperative on precisely the purposes it did not name, so it adds nothing
     * except the impression of cover — and the impression is what would stop
     * somebody writing the specific clause they actually needed.
     *
     * Driven against the shapes it exists to catch, in the four languages the
     * page ships, so the assertion is a rule rather than a spelling.
     */
    const OMNIBUS =
      /(qualunque|qualsiasi) altra finalit|per (ogni|qualsiasi) (altro )?scopo|any other purpose|for any purpose|jeden anderen Zweck|jeglichen? weiteren Zweck|toute autre finalit/i;
    expect(pluginCode, 'an omnibus purpose clause has appeared on the page').not.toMatch(OMNIBUS);
    // The guard itself, exercised — otherwise "no match" would also be what a
    // rotted regex returns.
    for (const bad of [
      'e per qualunque altra finalità futura',
      'and for any other purpose we may decide',
      'sowie für jeden anderen Zweck',
      'et pour toute autre finalité ultérieure',
    ]) {
      expect(bad, `the omnibus matcher no longer catches "${bad}"`).toMatch(OMNIBUS);
    }
  });

  it('says the consent can be withdrawn, and by which route', () => {
    // Naming the purposes without the way out would be the #5684 shape on the
    // page instead of in an email: a disclosure that takes and gives nothing.
    for (const claim of [
      'Puoi revocare il consenso in qualsiasi momento',
      'You can withdraw your consent at any time',
      'Sie können Ihre Einwilligung jederzeit',
      'Vous pouvez retirer votre consentement à tout moment',
    ]) {
      expect(plugin).toContain(claim);
    }
    // The routes have to exist on the page that states them.
    expect(plugin).toMatch(/PREFERENCES_PATH\[locale\]/);
    expect(plugin).toContain('DATA_CONTROLLER_FOOTER_LINE');
  });

  it('renders all of it — the tables are not declared and left orphaned', () => {
    // The failure this catches is the one the register has met before: copy
    // that exists in the file, satisfies a `toContain`, and never reaches a
    // screen. `renderBody` is the only path to the emitted HTML.
    for (const constant of ['SHARING_HEADING', 'SHARING_INTRO', 'SHARING_ITEMS', 'REVOCATION_TEXT']) {
      expect(body, `${constant} is declared but never rendered`).toContain(`${constant}[locale]`);
    }
    // Inside the existing controller section, extended rather than duplicated:
    // a second "who processes your data" block would let the two disagree.
    expect(body).toMatch(/id="titolare"[\s\S]*SHARING_HEADING\[locale\][\s\S]*REVOCATION_TEXT\[locale\]/);
    expect(body.match(/CONTROLLER_HEADING\[locale\]/g) ?? [], 'one controller section, not two').toHaveLength(1);
  });

  it('no longer tells subscribers from before the naming that they are exempt', () => {
    /**
     * The page half of the FIRST decision of 2026-08-14. `CATEGORY_NOTE`
     * carried, in four locales, "chi si è iscritto prima del 13 agosto 2026 non
     * lo riceve" — a description of the version filter that
     * `consentCoversAdvertising` applied at the time. The filter is gone, so
     * the sentence had to go with it in the same change: a page that tells a
     * reader they are exempt while the sender mails them is worse than one that
     * admits the reach, and it is the first thing a complaint would quote.
     */
    for (const gone of [
      'non lo riceve',
      'do not receive it',
      'erhält ihn nicht',
      'ne le reçoivent pas',
    ]) {
      expect(pluginCode, `the page still claims an exemption: "${gone}"`).not.toContain(gone);
    }
    for (const said of [
      'Vale per tutte le persone iscritte',
      'It applies to everyone who is subscribed',
      'Sie gilt für alle angemeldeten Personen',
      'Elle s’applique à toutes les personnes inscrites',
    ]) {
      expect(plugin, 'and it has to say the reach positively, not merely stop denying it').toContain(said);
    }
    // The registry's own row said the same thing and had to be corrected with it.
    const blast = COMMUNICATION_CHANNELS.find((c) => c.id === 'publisher-blast');
    for (const locale of CONSENT_LOCALES) {
      expect(blast?.cadence[locale], `publisher-blast cadence/${locale}`).not.toMatch(
        /dopo il 13 agosto|after 13 August|nach dem 13\. August|après le 13 août/,
      );
    }
  });
});

describe('the channel list the formula points at cannot under-report what we send', () => {
  /**
   * Discovery rule copied from tests/no-channel-mails-unconfirmed.test.ts:
   * `sendEmailCascade` is the only way mail leaves this repo, so importing it
   * is what makes a script a sender.
   */
  function discoverSenders(): string[] {
    return readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => `scripts/${e.name}`)
      .filter((rel) => /sendEmailCascade/.test(stripComments(read(rel))));
  }

  const senders = discoverSenders();

  it('found the senders at all', () => {
    expect(senders.length).toBeGreaterThan(8);
    expect(senders).toContain('scripts/send-daily-brief.mjs');
  });

  it('every sender is either a listed channel or a declared non-channel', () => {
    const declared = new Set([
      ...COMMUNICATION_CHANNELS.map((c) => c.sender),
      ...Object.keys(NON_SUBSCRIBER_SENDERS),
    ]);
    const undeclared = senders.filter((s) => !declared.has(s));
    expect(
      undeclared,
      'a new sender must appear on /comunicazioni/ or be declared as not a subscriber channel',
    ).toEqual([]);
  });

  it('no channel names a sender or workflow that no longer exists', () => {
    for (const c of COMMUNICATION_CHANNELS) {
      expect(existsSync(path.join(ROOT, c.sender)), `${c.id}: ${c.sender}`).toBe(true);
      expect(existsSync(path.join(ROOT, c.workflow)), `${c.id}: ${c.workflow}`).toBe(true);
      expect(statSync(path.join(ROOT, c.sender)).size).toBeGreaterThan(0);
    }
  });

  it('every declared cron is the cron the workflow actually carries', () => {
    // The mechanism that keeps the human sentence honest: a schedule change
    // that leaves `cadence` alone fails here, on the page's own source.
    for (const c of COMMUNICATION_CHANNELS) {
      if (!c.cron) continue;
      const wf = read(c.workflow);
      expect(
        wf.includes(`cron: '${c.cron}'`),
        `${c.id}: ${c.workflow} no longer schedules '${c.cron}' — update the cadence sentence too`,
      ).toBe(true);
    }
  });

  it('declares, for every channel, whether it actually ships', () => {
    for (const c of COMMUNICATION_CHANNELS) {
      expect(['live', 'suspended'], `${c.id}.status`).toContain(c.status);
    }
  });

  /**
   * The half that a file CAN carry.
   *
   * A workflow disabled through the Actions API (`disabled_manually`) changes
   * nothing on disk — that is exactly how the daily brief went off on
   * 2026-08-12 while its cron, its sender and every check above stayed intact,
   * and the page kept promising a bulletin twice a day. So the suspension is
   * declared in the registry and anchored to a marker in the workflow file,
   * and the two must agree BOTH WAYS: a marker with no `suspended` is a
   * channel the page still advertises, and a `suspended` with no marker is a
   * claim resting on nothing a reviewer of that workflow would ever see.
   */
  it('pairs every suspended channel with the marker in its workflow, in both directions', () => {
    for (const c of COMMUNICATION_CHANNELS) {
      const marked = read(c.workflow).includes(SUSPENDED_WORKFLOW_MARKER);
      expect(
        marked,
        `${c.id}: status is '${c.status}' but ${c.workflow} ${marked ? 'carries' : 'does not carry'} "${SUSPENDED_WORKFLOW_MARKER}"`,
      ).toBe(c.status === 'suspended');
    }
  });

  it('makes a suspended channel say so, in all four locales, where the cadence would be', () => {
    // The cadence line is what a reader takes as the promise. On a channel
    // that is off it has to read as a suspension and not as a schedule.
    const SAYS_SUSPENDED: Record<(typeof CONSENT_LOCALES)[number], RegExp> = {
      it: /sospes/i,
      en: /suspend/i,
      de: /ausgesetzt/i,
      fr: /suspend/i,
    };
    for (const c of COMMUNICATION_CHANNELS.filter((x) => x.status === 'suspended')) {
      for (const locale of CONSENT_LOCALES) {
        expect(
          c.cadence[locale],
          `${c.id}/${locale}: a suspended channel must not publish a cadence that reads like a promise`,
        ).toMatch(SAYS_SUSPENDED[locale]);
      }
    }
  });

  it('renders that status on the page rather than only in the registry', () => {
    // Read as text, never imported: importing a build plugin pulls ~12 files
    // under data/ and public/assets/ at module scope, which is green in CI and
    // red in a sparse worktree. Same reason the assertions above scan source.
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    expect(plugin, 'the row must branch on status or a dead channel still looks live')
      .toMatch(/channel\.status === 'suspended'/);
    expect(plugin, 'and it must print a label saying so').toMatch(/SUSPENDED_LABEL/);
  });

  /**
   * The category-level version of the same question. Consent is asked for a
   * CATEGORY, so a category behind which nothing ships is a request to agree to
   * mail that does not come.
   *
   * Since #5765 the categories are named on the PAGE rather than in the
   * sentence, which changes where the wrong claim would appear and not whether
   * it is wrong: `/comunicazioni/` heads a section per category, and a heading
   * over an empty category tells a reader they are agreeing to something.
   */
  it('leaves no consent category the page names standing empty', () => {
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    for (const category of CONSENT_CATEGORIES) {
      expect(plugin, `the page must still head a section for '${category}'`)
        .toMatch(new RegExp(`\\b${category}:\\s*\\{`));
      expect(
        COMMUNICATION_CHANNELS.some((c) => c.consentCategory === category),
        `'${category}' has no channel at all — renderBody drops a category with no rows, so the ` +
          'heading would vanish silently rather than fail anything',
      ).toBe(true);
    }
  });

  /**
   * The three categories that must have something LIVE behind them, enumerated
   * and not computed — and `advertising` deliberately absent from the list.
   *
   * The rule is about over-promising: a heading a reader takes as "mail I will
   * get" over a category that ships nothing is a request to agree to something
   * that does not come. `advertising` is the one place that reasoning inverts.
   * Its only channel is suspended, and it is named precisely so that the
   * disclosure exists BEFORE the channel could run (#5759) — the reverse of
   * over-promising, and the safe direction for a consent text.
   *
   * What keeps that from being a hole is the row itself: `renderChannel` prints
   * `SUSPENDED_LABEL` from `status`, so the section a reader lands on says, in
   * their language, that nothing is being sent. Asserted here, because without
   * it "advertising is exempt" would just mean "advertising is unchecked".
   */
  it('keeps a live channel under every category that promises mail', () => {
    for (const category of ['editorial', 'jobs', 'service'] as const) {
      expect(
        hasLiveChannel(category),
        `no live channel remains under '${category}' — the page must stop offering it`,
      ).toBe(true);
    }
  });

  it('says on the page that the advertising category ships nothing today', () => {
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    expect(hasLiveChannel('advertising'), 'still suspended — turning it on is an Actions-API act').toBe(false);
    for (const c of COMMUNICATION_CHANNELS.filter((ch) => ch.consentCategory === 'advertising')) {
      expect(c.status, `${c.id} would ship under a category with no live channel assertion`).toBe(
        'suspended',
      );
    }
    expect(plugin, 'the suspended badge is what makes the exemption above safe')
      .toMatch(/SUSPENDED_LABEL\[locale\]/);
  });

  it('stops the formula promising what only a suspended channel carried', () => {
    /**
     * The two items the editorial clause used to name — the live rate and the
     * border traffic — came from the daily brief alone. The weekly newsletter,
     * the only editorial channel still live, carries neither.
     *
     * Guarded on the status rather than pinned unconditionally, so this reads
     * the right way round when the channel returns: switching it back on makes
     * these phrases legitimate again, and putting them back is then a version
     * bump, which is the correct price for widening what people agreed to.
     */
    const brief = COMMUNICATION_CHANNELS.find((c) => c.id === 'daily-brief');
    if (brief?.status !== 'suspended') return;

    const SUSPENDED_ONLY: Record<(typeof CONSENT_LOCALES)[number], readonly string[]> = {
      it: ['cambio CHF/EUR', 'traffico ai valichi'],
      en: ['CHF/EUR exchange rate', 'traffic at the border crossings'],
      de: ['CHF/EUR-Kurs', 'Verkehr an den Grenzübergängen'],
      fr: ['taux CHF/EUR', 'trafic aux postes-frontière'],
    };
    const displayedEntries = Object.values(CONSENT_TEXTS).filter((p) => p.displayed);
    expect(displayedEntries.length, 'nothing to check means the guard has rotted').toBeGreaterThan(0);

    for (const proof of displayedEntries) {
      for (const locale of CONSENT_LOCALES) {
        for (const phrase of SUSPENDED_ONLY[locale]) {
          expect(
            proof.texts?.[locale],
            `${proof.id}/${locale} promises "${phrase}", which only the suspended daily brief delivered`,
          ).not.toContain(phrase);
        }
      }
    }
  });

  /**
   * The same promise, made by the UI instead of by the formula.
   *
   * Found in review on this PR: the preferences page — the very page the
   * formula sends people to in order to choose — described the newsletter
   * toggle as "cambio CHF/EUR, novità fiscali, traffico alle dogane e nuovi
   * annunci di lavoro" in all four locales. Two of those were daily-brief
   * content, and the fourth was the JOB ALERTS category, which is a separate
   * consent and a separate toggle three rows further down the same screen.
   *
   * A consent formula corrected while the screen next to it keeps the old
   * claim has not fixed the thing that misleads people, so the guard covers
   * the copy too. `CHF/EUR` is the discriminator because it is the one token
   * that survives translation unchanged in all four locales.
   */
  it('keeps the suspended channel’s content out of the live preferences copy', () => {
    const brief = COMMUNICATION_CHANNELS.find((c) => c.id === 'daily-brief');
    if (brief?.status !== 'suspended') return;

    const src = read('components/preferences/SubscriptionPreferencesController.tsx');
    const descriptions = [...src.matchAll(/newsletterDesc:\s*\n?\s*'([^']*)'/g)].map((m) => m[1]);
    expect(descriptions.length, 'newsletterDesc strings not found — the regex has rotted').toBe(4);

    for (const desc of descriptions) {
      expect(desc, 'the newsletter toggle must not promise the suspended brief’s content')
        .not.toMatch(/CHF\/EUR/i);
      expect(desc, 'nor border traffic, which no live channel emails')
        .not.toMatch(/dogan|valich|border traffic|Grenzverkehr|douane/i);
    }
  });

  it('describes every channel in all four locales', () => {
    for (const c of COMMUNICATION_CHANNELS) {
      for (const locale of CONSENT_LOCALES) {
        expect(c.name[locale]?.length, `${c.id}.name.${locale}`).toBeGreaterThan(2);
        expect(c.what[locale]?.length, `${c.id}.what.${locale}`).toBeGreaterThan(20);
        expect(c.cadence[locale]?.length, `${c.id}.cadence.${locale}`).toBeGreaterThan(15);
      }
    }
  });

  it('the page the formula names is the page the router resolves', () => {
    // A formula pointing at a 404 would be worse than one pointing nowhere.
    expect(`${CONSENT_PAGE_LABEL}`).toContain(COMMUNICATIONS_PAGE_PATH.it.replace(/\/$/, ''));
    const router = read('services/router.ts');
    for (const locale of CONSENT_LOCALES) {
      expect(router, `router.ts must resolve ${COMMUNICATIONS_PAGE_PATH[locale]}`)
        .toContain(`'${COMMUNICATIONS_PAGE_PATH[locale]}'`);
    }
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    expect(plugin, 'the page must be generated from the channel registry, not written')
      .toMatch(/from '\.\.\/services\/communicationChannels'/);
    expect(plugin).toMatch(/COMMUNICATION_CHANNELS/);
  });
});

describe('the page the formula points at cannot change without saying so (#5765)', () => {
  /**
   * WHY A VERSION, AND WHY IT IS NOT ENOUGH ON ITS OWN.
   *
   * The formula is now one line plus a link, so most of what a person was told
   * lives on `/comunicazioni/`. A stored `consent_text` naming that page and
   * nothing more would be evidence pointing at content free to change
   * afterwards — the page is GENERATED from a registry that changes whenever a
   * cron or a channel does. The formula therefore embeds
   * `COMMUNICATIONS_PAGE_VERSION`, and this block is what stops that identifier
   * from being a label somebody forgot to move.
   *
   * The fingerprint covers the page's MATERIAL content: the channel rows a
   * reader acts on, the template that turns them into prose, and the controller
   * identity printed at the bottom (which lives in functions/ and so is invisible
   * to a hash of this repo's page sources alone). Comments are stripped: a
   * rewritten explanation is not a changed disclosure, and a version that
   * churned on prose edits would be bumped mechanically and mean nothing.
   *
   * It is deliberately over-eager on the other side — restructuring the HTML
   * bumps it. That direction is safe: an unnecessary version is a version, a
   * missing one is a broken proof.
   */
  function communicationsPageFingerprint(): string {
    const material = JSON.stringify({
      channels: COMMUNICATION_CHANNELS.map((c) => ({
        id: c.id,
        status: c.status,
        consentCategory: c.consentCategory,
        name: c.name,
        what: c.what,
        cadence: c.cadence,
      })),
      controller: [DATA_CONTROLLER_NAME, DATA_CONTROLLER_EMAIL],
      // Read as text rather than imported: importing a build plugin pulls ~12
      // files under data/ and public/assets/ at module scope, green in CI and
      // red in a sparse worktree. Same reason as the assertions above.
      template: stripComments(read('build-plugins/communicationsPagePlugin.ts'))
        .replace(/\s+/g, ' ')
        .trim(),
    });
    return createHash('sha256').update(material).digest('hex').slice(0, 16);
  }

  /**
   * The versions that have been PUBLISHED, pinned literally.
   *
   * A version that shipped describes what a real subscriber was pointed at, so
   * its fingerprint may never be edited to fit new content — that would rewrite
   * the meaning of every `consent_text` naming it. Changing the page means
   * ADDING a row here and in the registry, not amending one.
   */
  const PUBLISHED_REVISIONS: Record<string, string> = {
    '2026-08-13.1': '28803e543beb58e2',
    // #5759 — the advertising section, its note, and the residual section
    // emptying out. `2026-08-13.1` above is untouched: a subscriber was really
    // pointed at it, and rewriting its fingerprint would rewrite what their
    // stored sentence means.
    '2026-08-13.2': '4c6226e23619772a',
    // #5760 — the BreadcrumbList JSON-LD. Backfilled here on 2026-08-14: it was
    // added to the registry and not to this table, which left the version that
    // was live for a day unpinned, i.e. free to be edited into agreement with
    // whatever the page said next. That is the one thing this table exists to
    // stop, and a version becomes eligible for it the moment it ships.
    '2026-08-13.3': '0d6e0b9159efb394',
    // Owner decisions of 2026-08-14: the advertising note stops telling early
    // subscribers they are exempt (the filter behind that sentence was
    // removed), and "Chi tratta i tuoi dati" gains the recipients, profiling
    // and business-transfer disclosures.
    '2026-08-14.1': '28c22f25c931e7ab',
  };

  it('matches the current page against the fingerprint of the current version', () => {
    expect(
      COMMUNICATIONS_PAGE_REVISIONS[COMMUNICATIONS_PAGE_VERSION],
      `/comunicazioni/ changed and COMMUNICATIONS_PAGE_VERSION did not. Add a new version with the ` +
        `fingerprint below to COMMUNICATIONS_PAGE_REVISIONS and to PUBLISHED_REVISIONS here, point ` +
        `COMMUNICATIONS_PAGE_VERSION at it, then bump the consent formulas (they interpolate it) and ` +
        `their pins in tests/newsletter-consent-proof.test.ts`,
    ).toBe(communicationsPageFingerprint());
  });

  it('never rewrites the fingerprint of a version that already shipped', () => {
    for (const [version, fingerprint] of Object.entries(PUBLISHED_REVISIONS)) {
      expect(
        COMMUNICATIONS_PAGE_REVISIONS[version],
        `${version} already shipped — its fingerprint records what a subscriber was pointed at. ` +
          'Add a NEW version instead of editing this one.',
      ).toBe(fingerprint);
    }
  });

  it('carries the version inside the stored sentence, in every locale', () => {
    // Not beside it, in a sibling field a call site has to remember: inside, so
    // the proof is self-contained and `consentProof` cannot omit it.
    for (const key of DISPLAYED_KEYS) {
      for (const locale of CONSENT_LOCALES) {
        expect(consentDisplayText(key, locale), `${key}/${locale} must name the page version`)
          .toContain(COMMUNICATIONS_PAGE_VERSION);
      }
      expect(consentProof(key, 'email_submit', 'de').consentText).toContain(COMMUNICATIONS_PAGE_VERSION);
    }
  });

  it('prints that version on the page, so the reader can compare it with their own proof', () => {
    const plugin = read('build-plugins/communicationsPagePlugin.ts');
    expect(plugin, 'a version named in a proof and absent from the page is a reference, not a receipt')
      .toMatch(/COMMUNICATIONS_PAGE_VERSION/);
    expect(plugin).toMatch(/VERSION_LABEL\[locale\]/);
  });

  it('keeps the notice short enough to be read where it is shown', () => {
    // The measurable half of "accorciato a una riga più il link". The formula
    // was ~700 characters at the moment a person decides whether to proceed;
    // a cap is what stops it growing back one clause at a time.
    for (const key of DISPLAYED_KEYS) {
      for (const locale of CONSENT_LOCALES) {
        expect(consentDisplayText(key, locale).length, `${key}/${locale} is no longer one line`)
          .toBeLessThan(260);
      }
    }
  });
});

describe('the guard itself fails on the shapes it exists to catch', () => {
  /**
   * #5764's lesson, applied: the four issues before this one were defects no
   * fixture sampled, and one survived three issues written to close it. A rule
   * only ever run against a repo where the defect is already absent proves
   * nothing about the rule.
   *
   * So every rule in `consentGateViolations` is run once against a source that
   * breaks it. These sources are strings, not files: the defective shapes must
   * not exist in the repo, which is precisely why they cannot be sampled from it.
   */
  const gateSource = (
    notices: readonly string[],
    proofs: readonly string[] = ['communicationsSignIn', 'communicationsSignInEmail'],
  ) => `
    import ConsentNotice from '@/components/shared/ConsentNotice';
    import { consentProof } from '@/services/consentTexts';
    const Gate = () => (
      <div>
        ${notices.map((k) => `<ConsentNotice consentKey="${k}" locale={locale} />`).join('\n        ')}
      </div>
    );
    const save = () => upsertNewsletterSubscriber(db, {
      email,
      ${proofs.map((k) => `...consentProof('${k}', 'email_submit', locale),`).join('\n      ')}
    });
  `;

  it('fails a gate that renders two notices — the #5765 defect itself', () => {
    const problems = consentGateViolations(
      gateSource(['communicationsSignIn', 'communicationsOptIn']),
      1,
    );
    expect(problems.join('\n')).toMatch(/renders 2 <ConsentNotice> but declares 1/);
    expect(problems.join('\n')).toMatch(/different consent sentences/);
  });

  it('fails JobBoard’s exact old shape: two gate surfaces, four notices', () => {
    const problems = consentGateViolations(
      gateSource([
        'communicationsSignIn',
        'communicationsOptIn',
        'communicationsSignIn',
        'communicationsOptIn',
      ]),
      2,
    );
    expect(problems.join('\n')).toMatch(/renders 4 <ConsentNotice> but declares 2/);
  });

  it('passes an access gate with ONE notice covering both of its acts', () => {
    // The shape this PR ships. One notice, two entries stored, same sentence.
    expect(consentGateViolations(gateSource(['communicationsSignIn']), 1)).toEqual([]);
  });

  it('passes a gate with only the email branch', () => {
    expect(
      consentGateViolations(gateSource(['communicationsOptIn'], ['communicationsOptIn']), 1),
    ).toEqual([]);
  });

  it('passes a gate with only the social branch', () => {
    // The other half of the pair above, and not symmetric with it by accident:
    // a screen whose only way through is a provider button stores ONE entry,
    // `act: 'authentication'`, and shows the same sentence a two-branch gate
    // shows. Missing from this block until #5739, which is why the rule that
    // one notice may cover two acts had never been exercised on the case where
    // there is only one.
    expect(
      consentGateViolations(gateSource(['communicationsSignIn'], ['communicationsSignIn']), 1),
    ).toEqual([]);
  });

  it('lets a deliberately silent call site stay silent, and refuses one that boasts', () => {
    /**
     * The `recorded-not-shown` verdict, driven both ways (#5739).
     *
     * The passing case is the position App.tsx and `services/authService.ts`
     * hold today: formulas stored, nothing on screen, `displayed: false` saying
     * so. That has to keep passing, or the rule would push those call sites
     * into rendering something — and the only sentence they could render is one
     * they do not store.
     *
     * The failing case is the one that never appears in the repo, because this
     * assertion is what keeps it out: the same silent file, storing a formula
     * that claims it was read.
     */
    const silentSite = `
      import { consentProof } from '@/services/consentTexts';
      const save = () => upsertNewsletterSubscriber(db, {
        email,
        ...consentProof('signInAutoSubscribe', 'social_signin'),
      });
    `;
    expect(recordedNotShownViolations(silentSite)).toEqual([]);
    expect(
      recordedNotShownViolations(silentSite.replace('signInAutoSubscribe', 'communicationsSignIn')),
    ).toEqual(['communicationsSignIn']);
  });

  it('fails a gate whose notice contradicts the document it writes', () => {
    // The social-only access gate that shows the newsletter wording: one notice,
    // right count, and still a person reading one sentence while another is kept.
    const problems = consentGateViolations(
      gateSource(['communicationsOptIn'], ['communicationsSignIn']),
      1,
    );
    expect(problems.join('\n')).toMatch(/no <ConsentNotice> here renders that exact sentence/);
    expect(problems.join('\n')).toMatch(/stores no formula with that sentence/);
  });

  it('fails a gate that renders nothing at all', () => {
    expect(consentGateViolations(gateSource([]), 1).join('\n'))
      .toMatch(/renders 0 <ConsentNotice> but declares 1/);
  });

  it('is not satisfied by a notice that only exists in a comment', () => {
    const src = `
      import { consentProof } from '@/services/consentTexts';
      /* we used to render <ConsentNotice consentKey="communicationsSignIn" /> here */
      const save = () => upsertNewsletterSubscriber(db, { ...consentProof('communicationsSignIn', 'google_oauth', locale) });
    `;
    expect(consentGateViolations(src, 1).join('\n')).toMatch(/renders 0 <ConsentNotice>/);
  });

  it('sees two notices on screen when a gate renders two, and one when it renders one', () => {
    // The source scan above reasons about JSX text. This is the same claim at
    // the other end — what a visitor's screen actually carries — so neither
    // half can be green while the other is wrong.
    const two = render(
      <div>
        <ConsentNotice consentKey="communicationsSignIn" locale="it" />
        <ConsentNotice consentKey="communicationsOptIn" locale="it" />
      </div>,
    );
    const shown = [...two.container.querySelectorAll('[data-consent-key]')];
    expect(shown).toHaveLength(2);
    expect(new Set(shown.map((n) => n.textContent)).size, 'two different sentences, one screen').toBe(2);
    two.unmount();

    const one = render(<ConsentNotice consentKey="communicationsSignIn" locale="it" />);
    expect(one.container.querySelectorAll('[data-consent-key]')).toHaveLength(1);
    one.unmount();
  });

  it('shows the same characters to whichever branch of an access gate the visitor takes', () => {
    // The property that lets one notice stand for two acts. If these ever
    // diverge, the single notice becomes a lie for one of the two branches.
    for (const locale of CONSENT_LOCALES) {
      expect(consentDisplayText('communicationsSignInEmail', locale))
        .toBe(consentDisplayText('communicationsSignIn', locale));
    }
    expect(CONSENT_TEXTS.communicationsSignIn.act).toBe('authentication');
    expect(CONSENT_TEXTS.communicationsSignInEmail.act).toBe('typed_email_submit');
  });
});
