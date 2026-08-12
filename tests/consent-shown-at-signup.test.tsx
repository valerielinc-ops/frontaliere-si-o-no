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
  NON_SUBSCRIBER_SENDERS,
  SUSPENDED_WORKFLOW_MARKER,
  hasLiveChannel,
} from '@/services/communicationChannels';
import { consentNamesJobAlerts } from '../functions/src/jobAlertBackfillCore.js';

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
 * half that mattered: `hooks/useNewsletterState.ts` writes the collection
 * directly with `addDoc`, so it never reaches `captureNewsletterSubscriber`
 * and the `consent-text-required` guard added by #5695 does not run on it. A
 * rule that only looked for the function calls would have declared that file
 * covered.
 */
const CREATES_SUBSCRIBER =
  /(upsert|capture)NewsletterSubscriber\s*\(|(addDoc|setDoc)\(\s*(collection|doc)\([^)]*'newsletter_subscribers'/;

type Verdict =
  /**
   * Renders every displayed formula it stores. The assertion below is per KEY,
   * not per file: a file may store two (a sign-in one and a typed-address one)
   * and must render both, each next to its own control.
   */
  | { verdict: 'shown'; why: string }
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
    why: 'the checkbox label IS the stored string now — this file and SubscriptionCTA are where the show/store divergence was measurable',
  },
  'components/shared/SubscriptionCTA.tsx': {
    verdict: 'shown',
    why: 'same divergence as the popup, same fix',
  },
  'components/shared/PdfDownloadGate.tsx': {
    verdict: 'shown',
    why: 'IT-only gate (its upsert passes locale: it), checkbox label from the register',
  },
  'components/community/OfferwallNewsletterGate.tsx': {
    verdict: 'shown',
    why: 'had its own four-locale table describing only the newsletter; now renders and stores the register formula',
  },
  'components/community/Newsletter.tsx': {
    verdict: 'shown',
    why: 'notice under both the compact footer form and the full page form',
  },
  'components/community/WeeklyDigest.tsx': {
    verdict: 'shown',
    why: 'notice under the subscribe row',
  },
  'components/shared/LeadMagnetCTA.tsx': {
    verdict: 'shown',
    why: 'notice under both guide-for-address forms',
  },
  'components/calculator/MobileCalcLayout.tsx': {
    verdict: 'shown',
    why: 'notice under the analysis-gate email form',
  },
  'components/fisco/TaxCalendar.tsx': {
    verdict: 'shown',
    why: 'two acts, two notices: sign-in above the provider buttons, opt-in under the email form',
  },
  'components/community/JobBoard.tsx': {
    verdict: 'shown',
    why: 'two gate surfaces (modal + inline region), each with both notices',
  },
  'components/community/JobOrphanView.tsx': { verdict: 'shown', why: 'notice under the unlock form' },
  'components/community/JobBridgeView.tsx': { verdict: 'shown', why: 'notice under the unlock form' },
  'components/community/JobExpiredView.tsx': { verdict: 'shown', why: 'notice under the unlock form' },
  'components/community/CompanyFollowButton.tsx': {
    verdict: 'shown',
    why: 'notice inside the email-capture form',
  },
  'components/community/SaveSignInPromptModal.tsx': {
    verdict: 'shown',
    why: 'its own upsert covers the EMAIL branch only, and that branch renders what it stores; the social branch is recorded by App.tsx and is declared there',
  },
  'components/pages/PublisherPublishPage.tsx': {
    verdict: 'shown',
    why: 'gate renders the sign-in notice above the providers and the opt-in notice under the email form, matching its two upserts',
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
  'hooks/useNewsletterState.ts': {
    verdict: 'unreachable',
    why: 'raw addDoc that bypasses captureNewsletterSubscriber and therefore its consent-text guard; App.tsx carries its own copy of this logic and nothing imports the hook',
    issue: '#5712',
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

  it.each(shown)('%s renders every displayed formula it stores', (file) => {
    const src = read(file);
    expect(src, `${file} must import the register`).toMatch(/from '@\/services\/consentTexts'/);
    const stored = proofKeysIn(src);
    expect(stored.length, `${file} passes no consent proof`).toBeGreaterThan(0);

    const rendered = new Set(renderedKeysIn(src));
    for (const key of stored) {
      if (!CONSENT_TEXTS[key]?.displayed) continue;
      expect(
        rendered.has(key),
        `${file} stores '${key}' (displayed: true) but renders no <ConsentNotice consentKey="${key}"> — either render it or store a displayed:false formula`,
      ).toBe(true);
    }
  });

  it.each(shown)('%s renders no notice it does not also store', (file) => {
    // The mirror image, and the one that stops the flag from being bought
    // cheaply: a decorative notice next to a gate that records something else
    // is exactly the show/store divergence this batch removed.
    const src = read(file);
    const stored = new Set(proofKeysIn(src));
    for (const key of renderedKeysIn(src)) {
      expect(
        stored.has(key),
        `${file} renders '${key}' but never stores it — the visitor would read one sentence and the document would keep another`,
      ).toBe(true);
    }
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

  it('the raw addDoc that bypasses the creation guard still writes the register fields', () => {
    // `hooks/useNewsletterState.ts` does not go through
    // `captureNewsletterSubscriber`, so the `consent-text-required` guard
    // added by #5695 never runs on it. Unreachable today, but a document born
    // there would be the 8.506th with no record of what was disclosed.
    const src = stripComments(read('hooks/useNewsletterState.ts'));
    expect(src).toMatch(/consent_text:/);
    expect(src).toMatch(/consent_text_version:/);
    expect(src).toMatch(/consent_text_displayed:/);
    expect(src).toMatch(/consent_act:/);
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

  it('names the data controller at collection time, not only in the privacy notice', () => {
    // art. 19 nLPD, and the point of #5675: the recipient of an unwanted email
    // must be able to tell who to write to without hunting for a policy page.
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(proof.texts?.[locale], `${proof.id}/${locale}`).toContain('Valerie Linc');
        expect(proof.texts?.[locale], `${proof.id}/${locale}`).toContain('@frontaliereticino.ch');
      }
    }
  });

  it('names the job-alert CHANNEL in every locale, in the words the server guard matches', () => {
    // Load-bearing across a boundary with no import shape: `functions/` cannot
    // import the TypeScript register, so the two agree by convention only.
    // Softening these words back to "offerte di lavoro" would silently shut
    // job-alert creation again (`consentNamesJobAlerts` refuses that phrase on
    // purpose — it names the content of a page, not a mailing).
    for (const proof of displayed) {
      for (const locale of CONSENT_LOCALES) {
        expect(
          consentNamesJobAlerts(proof.texts?.[locale]),
          `${proof.id}/${locale} does not name the job-alert channel`,
        ).toBe(true);
      }
    }
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
   * The category-level version of the same question, and the one that matters
   * for the formula rather than the page: consent is asked for a CATEGORY, so
   * a category behind which nothing ships is a request to agree to mail that
   * does not come.
   */
  it('leaves no consent category the formula names standing empty', () => {
    for (const category of ['editorial', 'jobs', 'service'] as const) {
      expect(
        hasLiveChannel(category),
        `no live channel remains under '${category}' — the formula must stop naming it`,
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
