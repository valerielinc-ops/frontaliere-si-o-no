/**
 * #5684 — the preference centre, measured instead of described.
 *
 * The centre already existed in both modes when this issue was filed; what was
 * missing was any check that it kept covering every channel as channels were
 * added. The failure mode is silent by construction: a new sender ships with
 * its own unsubscribe link, that link works, every existing test stays green,
 * and the only signal that the channel is missing from the centre arrives as a
 * complaint at the provider's abuse desk — which is how this issue was opened.
 *
 * So the deliverable is registries, not prose. Each one is a list a future
 * sender has to be added to, and each assertion below fails while a listed
 * channel has no way out that does not start inside its own email.
 *
 * Deliberately source-level for the client controller (the auth-mode
 * convention already used by tests/subscription-preferences-controller.test.tsx,
 * whose Firestore paths cannot be rendered without mocking the SDK) and
 * behavioural for the email templates, which are pure builders and can simply
 * be called.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildWinbackEmail } from '../services/winbackEmail.mjs';
import { buildDormantWinbackStage1Email } from '../services/dormantWinbackStage1Email.mjs';
import { buildDripEmail } from '../services/newsletter/onboardingDrip.mjs';
import { makePreferencesUrl, PREFERENCES_SLUG } from '../services/newsletterUrls.mjs';
import { DATA_CONTROLLER_EMAIL } from '../functions/src/lib/dataControllerIdentity.js';
import { buildAlertPayload } from '../functions/src/jobAlertBackfillCore.js';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

const CONTROLLER = 'components/preferences/SubscriptionPreferencesController.tsx';
const controllerSrc = read(CONTROLLER);

// ─── Registry 1 — everything that can put a message in a subscriber's inbox ──
//
// `recurring` = sends again, unprompted, to someone who is on a list. Those owe
// the reader the preference centre, because the reader has an ongoing
// relationship to adjust.
//
// `transactional` = sent once, in direct answer to something the reader just
// did (confirm an address, ask for a report). Those owe the reader the
// data-controller identity but NOT a preference link: there is no ongoing
// subscription behind them, and offering "manage your preferences" on a
// double-opt-in confirmation invites the reader to unsubscribe from a list they
// have not joined yet.
//
// `outreach` = cold B2B contact. Not a subscriber channel; it carries its own
// dedicated opt-out (functions/src/outreachUnsubscribe.js) and its recipients
// are not in the preference centre's collections at all.
const SENDERS: Array<{ file: string; kind: 'recurring' | 'transactional' | 'outreach'; what: string }> = [
  { file: 'services/newsletter-template.mjs', kind: 'recurring', what: 'weekly newsletter' },
  { file: 'services/daily-brief-template.mjs', kind: 'recurring', what: 'daily brief' },
  { file: 'scripts/send-job-alerts.mjs', kind: 'recurring', what: 'job alerts' },
  { file: 'functions/src/lib/welcomeEmailTemplate.js', kind: 'recurring', what: 'welcome' },
  { file: 'services/newsletter/onboardingDrip.mjs', kind: 'recurring', what: 'onboarding drip' },
  { file: 'services/winbackEmail.mjs', kind: 'recurring', what: 'win-back / sunset' },
  { file: 'services/dormantWinbackStage1Email.mjs', kind: 'recurring', what: 'dormant win-back stage 1' },
  { file: 'services/companyAlertEmail.mjs', kind: 'recurring', what: 'followed-employer alert' },
  { file: 'scripts/send-saved-jobs-digest.mjs', kind: 'recurring', what: 'saved-jobs digest' },
  { file: 'services/publisherBlastEmail.mjs', kind: 'outreach', what: 'publisher ad blast' },
  { file: 'functions/src/newsletterConfirmationEmail.js', kind: 'transactional', what: 'double opt-in confirmation' },
  { file: 'functions/src/sendCalculatorReport.js', kind: 'transactional', what: 'calculator report' },
];

// A recurring template either builds the preferences URL itself from the
// address it already has, or receives it from its sender. Both are accepted —
// what is not accepted is neither.
const CARRIES_PREFERENCES = /makePreferencesUrl|preferencesUrl|manageUrl/;

// ─── Registry 2 — every recurring channel and the control that stops it ──────
//
// `controlStrings` are literal fragments of the control's own copy in the
// controller source. They are the cheapest available proof that the control is
// rendered rather than merely conceivable, and they break loudly if a channel's
// card is deleted or silently renamed.
//
// `stoppableFromCentre` has no `false` row on purpose. That is the whole
// criterion from the issue — "nessun canale deve essere spegnibile solo dal
// link della propria email" — and a channel added here with no control is a
// failing test, not a documented exception.
const CHANNELS: Array<{ what: string; controlStrings: string[]; sender: string }> = [
  {
    what: 'weekly newsletter',
    controlStrings: ['newsletterTitle', 'toggleNewsletterSubscription', 'authToggleNewsletter'],
    sender: 'scripts/send-newsletter.mjs',
  },
  {
    what: 'daily brief',
    controlStrings: ['briefTitle', 'setDailyBriefFrequency', 'authSetBriefFrequency'],
    sender: 'scripts/send-daily-brief.mjs',
  },
  {
    what: 'job alerts (incl. followed employers)',
    controlStrings: ['alertsTitle', 'handleTogglePause', 'handleDeleteAlert'],
    sender: 'scripts/send-job-alerts.mjs',
  },
  {
    what: 'saved-jobs digest',
    controlStrings: ['digestTitle', 'authSetSavedJobsDigest', 'handleToggleDigest'],
    sender: 'scripts/send-saved-jobs-digest.mjs',
  },
];

describe('#5684 point 1 — every recurring channel has a switch in the preference centre', () => {
  it.each(CHANNELS)('$what is switchable from the centre', ({ controlStrings }) => {
    for (const fragment of controlStrings) {
      expect(controllerSrc).toContain(fragment);
    }
  });

  it('each channel card ships copy in all four locales', () => {
    // STRINGS is a Record<Locale, SectionStrings>, so a key present four times
    // is a key translated everywhere. A key added to `it` alone would not
    // typecheck, but a key added to the interface and then left out of the
    // rendered card would — this pins the rendered side.
    for (const key of ['newsletterTitle', 'briefTitle', 'alertsTitle', 'digestTitle']) {
      const occurrences = controllerSrc.split(`${key}:`).length - 1;
      // once in the interface declaration + once per locale
      expect(occurrences, `${key} should be declared once and translated ${LOCALES.length}×`).toBe(
        LOCALES.length + 1,
      );
    }
  });

  it('the saved-jobs digest opt-out is no longer writable only by its own email link', () => {
    // Before this issue, `users/{uid}.savedJobsDigest.optedOut` had exactly one
    // writer: functions/src/savedJobsDigestUnsubscribe.js, reachable only from
    // the link inside the digest. Someone who deleted the message had no way to
    // stop the channel from anywhere on the site.
    expect(read('functions/src/savedJobsDigestUnsubscribe.js')).toContain('savedJobsDigest');
    expect(controllerSrc).toContain('savedJobsDigest');
    expect(controllerSrc).toMatch(/optedOut:\s*!enabled/);
  });

  it('the digest sender still reads the flag the centre writes', () => {
    // The two halves are in different languages and different deploy units, so
    // nothing but a test connects them. If the sender's gate moves, the switch
    // in the centre becomes decorative without failing anything else.
    expect(read('scripts/send-saved-jobs-digest.mjs')).toContain('savedJobsDigest?.optedOut === true');
  });
});

describe('#5684 point 2 — what "off" means is stated, and the all-off case is reachable', () => {
  it('the centre states that each switch is channel-scoped, in all four locales', () => {
    // The issue's complaint is precise: `off` on the daily brief is documented
    // in the code as "a channel-level opt-out that leaves the other channels
    // alone", and a reader who set it believing they had unsubscribed from
    // everything kept receiving the rest. The scoping is now on screen.
    expect(controllerSrc.split('scopeNote:').length - 1).toBe(LOCALES.length + 1);
  });

  it('offers a single action that stops every channel', () => {
    // Without this, telling the reader "each switch covers its own channel" is
    // an accurate sentence that leaves them worse off: they now know the four
    // switches are separate and still have no way to say "none of it".
    expect(controllerSrc.split('stopAll:').length - 1).toBe(LOCALES.length + 1);
    expect(controllerSrc).toContain('handleStopAll');
  });

  it('stop-all pauses job alerts instead of deleting them', () => {
    // The delete primitive in this component is a hard delete (deleteDoc /
    // .delete()), with no tombstone. Silencing the mailbox must not also
    // destroy the reader's saved searches — pausing stops every send and is
    // reversible.
    const stopAll = controllerSrc.slice(controllerSrc.indexOf('const handleStopAll'));
    const body = stopAll.slice(0, stopAll.indexOf('\n const handleTogglePause'));
    expect(body).toContain('paused: true');
    expect(body).not.toContain('deleteJobAlert');
    expect(body).not.toContain('authDeleteAlert');
  });

  it('the daily brief still describes its own scope on its card', () => {
    // Pre-existing and correct — asserted so a later copy edit cannot quietly
    // remove the one channel-level statement that was already right.
    for (const marker of ['senza toccare newsletter', 'without touching the newsletter']) {
      expect(controllerSrc).toContain(marker);
    }
  });
});

describe('#5684 point 3 — a preference set in the centre survives what comes after', () => {
  it('a job-alert cadence is not reset to daily by a re-triggered backfill', () => {
    // buildAlertPayload's result is merged onto the existing alert doc. It
    // hardcoded `frequency: 'daily'`, so a cadence chosen in the centre was
    // overwritten on any re-trigger — and since the centre also sets
    // `frequencyOverride: true`, which this payload does not carry and merge
    // therefore preserves, jobAlertEngagementTier.mjs then read the pair as a
    // deliberate manual pin and stopped adapting.
    const data = { source_channel: 'web_app', job_slug: 'x', locale: 'it' };
    const chosen = buildAlertPayload('user@example.com', data, {
      active: true,
      frequency: 'weekly',
      frequencyOverride: true,
    });
    expect(chosen.frequency).toBe('weekly');

    // A brand-new alert still defaults to daily — the fix must not change what
    // a first-time backfill produces.
    expect(buildAlertPayload('user@example.com', data, null).frequency).toBe('daily');
  });

  it('a paused followed-employer alert stops the company-alert sender too', () => {
    // `paused` is the centre's pause button, orthogonal to `active` (the
    // soft-delete flag) since #4298. send-job-alerts.mjs has honoured it since
    // then; send-company-alerts.mjs never did, so pausing a followed employer
    // in the centre left its immediate alerts running. The centre renders those
    // rows with the same pause control as any other alert, so the control was
    // visibly present and inert.
    expect(read('scripts/send-company-alerts.mjs')).toContain('a.paused !== true');
    expect(read('scripts/send-job-alerts.mjs')).toContain('a.paused !== true');
  });

  it('a login upsert does not carry any preference-centre field', () => {
    // captureNewsletterSubscriber writes with { merge: true }, so a preference
    // survives a login precisely as long as it is absent from that write. It is
    // absent today — by omission, not by design, which is why this pins it.
    const src = read('services/newsletterSubscribers.ts');
    const start = src.indexOf('const mergedData');
    expect(start).toBeGreaterThan(-1);
    const merged = src.slice(start, src.indexOf('setDoc(', start));
    for (const field of ['daily_brief_frequency_override', 'autologin_enabled', 'savedJobsDigest']) {
      expect(merged, `${field} must stay out of the login upsert`).not.toContain(field);
    }
  });

  it('the master opt-out itself survives a login (the #5672 fix, still in place)', () => {
    // Restated here rather than trusted: this suite is what a reader lands on
    // when asking "does the centre remember?", and the answer has to be
    // complete. The per-path proof lives in newsletter-unsubscribe-integrity.
    const src = read('services/newsletterSubscribers.ts');
    expect(src).toContain('export function isNewsletterOptOutBinding');
    expect(src).toContain('export async function isNewsletterOptedOut');
    for (const p of ['App.tsx', 'services/authService.ts', 'components/community/JobBoard.tsx']) {
      expect(read(p), `${p} must consult the opt-out before auto-subscribing`).toContain(
        'isNewsletterOptedOut',
      );
    }
  });

  it('the digest opt-out is not re-defaulted by a later login', () => {
    // ensureUserProfileDoc writes savedJobsDigest only on first creation. The
    // centre now writes the same key, so the guarantee has a second reason to
    // keep holding — and a second way to be broken.
    expect(read('services/savedJobsService.ts')).toMatch(
      /savedJobsDigest[\s\S]{0,400}?NEVER touched again after creation/,
    );
  });
});

describe('#5684 point 4 — the centre can be found', () => {
  it.each(SENDERS.filter((s) => s.kind === 'recurring'))(
    '$what ($file) carries a link to the preference centre',
    ({ file }) => {
      expect(read(file)).toMatch(CARRIES_PREFERENCES);
    },
  );

  it.each(SENDERS)('$what ($file) names the data controller', ({ file }) => {
    // Landed by #5675 across all twelve senders and left without a test that
    // covered them as a set — the same shape of gap this issue is about.
    expect(read(file)).toContain('dataControllerFooterLine');
  });

  it('the three templates fixed here actually render the link, not just import it', () => {
    // Source-level checks above prove the reference exists; these prove the URL
    // reaches the reader, in both the HTML and the plain-text part.
    const prefsPath = PREFERENCES_SLUG.it;

    const winback = buildWinbackEmail({ email: 'user@example.com', locale: 'it' });
    expect(winback.html).toContain(prefsPath);
    expect(winback.text).toContain(prefsPath);

    const dormant = buildDormantWinbackStage1Email({
      email: 'user@example.com',
      locale: 'it',
      articles: [{ title: 'T', url: '/a/', excerpt: 'E' }],
    });
    expect(dormant.html).toContain(prefsPath);
    expect(dormant.text).toContain(prefsPath);

    const drip = buildDripEmail({
      step: 0,
      locale: 'it',
      unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe',
      preferencesUrl: makePreferencesUrl('user@example.com', 'it', { fallbackUnsigned: true }),
    });
    expect(drip.html).toContain(prefsPath);
  });

  it('the drip omits the link rather than rendering a broken one when the sender passes nothing', () => {
    // buildDripEmail is pure and never sees the address, so it cannot build the
    // URL itself. A missing `preferencesUrl` must degrade to no link, not to
    // `href="undefined"`.
    const drip = buildDripEmail({ step: 0, locale: 'it' });
    expect(drip.html).not.toContain('undefined');
  });

  it('the drip sender passes the preferences URL on both its send paths', () => {
    // Production loop and --test path. The second is how a human previews the
    // email, so a divergence there hides the defect from exactly the person
    // checking for it.
    const src = read('scripts/send-onboarding-drip.mjs');
    expect(src.split('preferencesUrl:').length - 1).toBe(2);
  });

  it.each(LOCALES)('the preferences link is locale-correct for %s', (locale) => {
    const url = makePreferencesUrl('user@example.com', locale, { fallbackUnsigned: true });
    expect(url).toContain(PREFERENCES_SLUG[locale]);
    const built = buildWinbackEmail({ email: 'user@example.com', locale });
    expect(built.html).toContain(PREFERENCES_SLUG[locale]);
  });

  it('the public page offers a way out when the link has no token', () => {
    // The page is HMAC-gated, so without a signed link it rendered "open this
    // page from one of our emails" and nothing else — an instruction addressed
    // to someone who, by hypothesis, deleted the emails. That dead end is the
    // last step before writing to the provider's abuse desk.
    const page = read('components/pages/NewsletterPreferences.tsx');
    expect(page).toContain('invalidHelpSignIn');
    expect(page).toContain('DATA_CONTROLLER_EMAIL');
    expect(page.split('invalidHelpTitle:').length - 1).toBe(LOCALES.length + 1);
    // The contact must be the monitored controller address, never the automated
    // send mailbox — the distinction #5675 exists to make.
    expect(DATA_CONTROLLER_EMAIL).not.toMatch(/^alerts@/);
  });

  it('the authenticated profile renders the centre', () => {
    const profile = read('components/pages/UserProfile.tsx');
    expect(profile).toContain('SubscriptionPreferencesController');
    expect(profile).toMatch(/mode="auth"/);
    // uid, not just the address: the digest control is keyed by it, and the
    // prop was declared and ignored for the component's whole life before this.
    expect(profile).toMatch(/userId=\{user\.uid\}/);
    expect(controllerSrc).toMatch(/^\s*userId,$/m);
  });
});
