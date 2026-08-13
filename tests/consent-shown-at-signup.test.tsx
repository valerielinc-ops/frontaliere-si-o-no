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
  COMMUNICATION_CHANNELS,
  COMMUNICATIONS_PAGE_PATH,
  COMMUNICATIONS_PAGE_REVISIONS,
  COMMUNICATIONS_PAGE_VERSION,
  NON_SUBSCRIBER_SENDERS,
  SUSPENDED_WORKFLOW_MARKER,
  hasLiveChannel,
} from '@/services/communicationChannels';
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
    notices: 1,
    why: 'notice inside the email-capture form',
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
    const src = read(file);
    const displayedStored = proofKeysIn(src).filter((k) => CONSENT_TEXTS[k]?.displayed);
    expect(
      displayedStored,
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

  it('says nothing that would let third-party advertising in', () => {
    // The one decision the code must not take. Naming advertising here would
    // authorise `blast-publisher-ads.mjs` against people who never agreed to
    // it; the channel is listed on the page with no consent category, and the
    // choice stays with the owner (#5712).
    const ADVERTISING =
      /\b(pubblicit\w*|inserzionist\w*|sponsor\w*|advertis\w*|werb\w*|publicitaire\w*)\b/i;
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(proof.texts?.[locale], `${proof.id}/${locale}`).not.toMatch(ADVERTISING);
      }
    }
    expect(
      COMMUNICATION_CHANNELS.find((c) => c.id === 'publisher-blast')?.consentCategory,
      'publisher-blast must stay uncategorised until the owner decides',
    ).toBeNull();
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
    for (const category of ['editorial', 'jobs', 'service'] as const) {
      expect(plugin, `the page must still head a section for '${category}'`)
        .toMatch(new RegExp(`\\b${category}:\\s*\\{`));
      expect(
        hasLiveChannel(category),
        `no live channel remains under '${category}' — the page must stop offering it`,
      ).toBe(true);
    }
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
