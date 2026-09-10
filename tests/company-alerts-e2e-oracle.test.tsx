/**
 * CompanyAlert independent oracle, scope E.
 *
 * These tests are intentionally not a copy of the implementation probes. The
 * inputs and expected outcomes are declared in the E artifacts and then
 * exercised through the public UI, matching, email-template, consent, intent,
 * and delivery seams. All transports are fake and all timestamps are relative
 * to the test clock.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { baseCompanySlug, canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { companyFollowMountPlaceholder } from '../build-plugins/shared/companyFollowMountPlaceholder';
import { companyFilterSlugFromPath, shouldReloadForCompanyFilter } from '@/components/community/CompanyFollowMount';
import CompanyFollowButton from '@/components/community/CompanyFollowButton';
import JobBoardFilterAlertCta from '@/components/community/JobBoardFilterAlertCta';
import JobDetailAlertPrompt from '@/components/community/JobDetailAlertPrompt';
import {
  buildAlertProfile,
  scoreJobForAlert,
} from '@/services/jobAlertMatching.mjs';
import { companyAlertKey } from '@/services/jobAlertService';
import {
  buildCompanyAlertEmail,
  companyHubUrl,
} from '@/services/companyAlertEmail.mjs';
import { confirmNewsletterSubscription } from '@/services/newsletterSubscribers';
import { flushPendingCompanyFollows, readPendingCompanyFollows, savePendingCompanyFollow } from '@/services/companyFollowIntent';
import { isImmediateCompanyAlert } from '../scripts/lib/company-alert-routing.mjs';
import {
  buildRecipientSections,
  groupAlertsByRecipient,
  selectNewlyPublishedJobs,
} from '../scripts/send-company-alerts.mjs';
import {
  CONTROLLED_EMAIL,
  CONTROLLED_LOCALE,
  CONTROLLED_USER_ID,
  EXPECTED_CANONICAL_KEYS,
  MATCHING_EXPECTATIONS,
  WINDOW_MS,
  hoursAhead,
  hoursAgo,
  makeAlert,
  makeJob,
} from './__fixtures__/company-alerts-e-oracle';

const oracleStats = {
  passed: 0,
  total: 0,
  failedIds: [] as string[],
};

function check(
  id: string,
  actual: unknown,
  expected: unknown,
  errors: unknown[],
): void {
  oracleStats.total += 1;
  try {
    expect(actual, id).toEqual(expected);
    oracleStats.passed += 1;
  } catch (error) {
    oracleStats.failedIds.push(id);
    errors.push(error);
  }
}

function recordUnexpected(id: string, error: unknown, errors: unknown[]): void {
  oracleStats.total += 1;
  oracleStats.failedIds.push(id);
  errors.push(error);
}

function finish(errors: unknown[]): void {
  if (errors.length === 0) return;
  const first = errors[0];
  throw first instanceof Error ? first : new Error(String(first));
}

function companyProfile(company: string): ReturnType<typeof buildAlertProfile> {
  return buildAlertProfile(
    {
      keywords: [],
      locations: [],
      sectors: [],
      contractTypes: [],
      cantonFilter: null,
      specificCompanyKey: canonicalCompanyProfileSlug(company),
    },
    null,
    {},
  );
}

function normalizeFlushOutcome(outcome: unknown) {
  if (Array.isArray(outcome)) {
    return {
      created: outcome,
      failed: [],
      pending: readPendingCompanyFollows().length,
    };
  }
  const value = outcome as { created?: unknown[]; failed?: unknown[]; pending?: number };
  return {
    created: Array.isArray(value?.created) ? value.created : [],
    failed: Array.isArray(value?.failed) ? value.failed : [],
    pending: Number(value?.pending || 0),
  };
}

function makeSerializedTransactionDb(initialData: Record<string, unknown>) {
  const state = {
    exists: true,
    data: { ...initialData },
  };
  let tail = Promise.resolve();

  const db = {
    state,
    runTransaction(callback: (tx: {
      get: (ref: unknown) => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
      update: (ref: unknown, patch: Record<string, unknown>) => void;
    }) => Promise<unknown>) {
      const previous = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => { release = resolve; });
      return previous.then(async () => {
        const updates: Record<string, unknown>[] = [];
        const tx = {
          get: async () => ({
            exists: state.exists,
            data: () => ({ ...state.data }),
          }),
          update: (_ref: unknown, patch: Record<string, unknown>) => {
            updates.push(patch);
          },
        };
        try {
          const result = await callback(tx);
          for (const patch of updates) state.data = { ...state.data, ...patch };
          return result;
        } finally {
          release();
        }
      });
    },
  };
  return db;
}

async function senderApi(): Promise<Record<string, any>> {
  return await import('../scripts/send-company-alerts.mjs') as Record<string, any>;
}

async function dedupApi(): Promise<Record<string, any>> {
  return await import('../scripts/lib/alert-sent-jobs.mjs') as Record<string, any>;
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

afterAll(() => {
  const failed = oracleStats.failedIds.length > 0
    ? ' ids=' + oracleStats.failedIds.join(',')
    : '';
  console.log(
    '[company-alert-oracle] assertions='
      + oracleStats.passed + '/' + oracleStats.total
      + ' failed=' + oracleStats.failedIds.length
      + failed,
  );
});

describe('E oracle: public company identity and hydrated CTA', () => {
  it('E-POS-01: exposes one canonical public-company mount and the history guard', () => {
    const errors: unknown[] = [];
    check('E-POS-01-acme-key', canonicalCompanyProfileSlug('ACME'), EXPECTED_CANONICAL_KEYS.acme, errors);
    check('E-POS-01-migros-key', canonicalCompanyProfileSlug('Migros Ticino'), EXPECTED_CANONICAL_KEYS.migros, errors);
    check('E-POS-01-guess-key', canonicalCompanyProfileSlug('Guess Ticino'), EXPECTED_CANONICAL_KEYS.guess, errors);
    check('E-POS-01-base-slug-remains-distinct', baseCompanySlug('Migros Ticino'), 'migros-ticino', errors);

    const mount = companyFollowMountPlaceholder({
      company: 'Migros Ticino',
      companyKey: EXPECTED_CANONICAL_KEYS.migros,
      locale: CONTROLLED_LOCALE,
      surface: 'employer_profile',
    });
    check('E-POS-01-mount-has-company-identity', /data-company="Migros Ticino"/.test(mount), true, errors);
    check('E-POS-01-mount-has-company-key', /data-company-key="migros"/.test(mount), true, errors);
    check('E-POS-01-empty-company-emits-no-mount', companyFollowMountPlaceholder({
      company: '',
      companyKey: null,
      locale: CONTROLLED_LOCALE,
      surface: 'employer_profile',
    }), '', errors);

    check('E-NEG-11-private-filter-parses-as-company-filter-only-when-public',
      companyFilterSlugFromPath('/azienda-acme/'), 'acme', errors);
    check('E-NEG-11-history-guard-reloads-different-mounted-company',
      shouldReloadForCompanyFilter('/azienda-migros/', new Set(['acme'])), true, errors);
    check('E-NEG-11-history-guard-keeps-same-mounted-company',
      shouldReloadForCompanyFilter('/azienda-acme/', new Set(['acme'])), false, errors);
    finish(errors);
  });

  it('E-NEG-01: matches exact canonical companies, aliases, and casing only', () => {
    const errors: unknown[] = [];
    for (const fixture of MATCHING_EXPECTATIONS) {
      const actual = scoreJobForAlert(
        {
          id: 'matching-' + fixture.label,
          title: 'Ruolo controllato',
          company: fixture.job,
          canton: 'TI',
        },
        companyProfile(fixture.alert),
      ) > 0;
      check('E-NEG-01-' + fixture.label, actual, fixture.expected, errors);
    }
    finish(errors);
  });

  it('E-POS-02: a hydrated company popup is visible before any subscription', async () => {
    const errors: unknown[] = [];
    const module = await import('@/components/community/CompanyFollowCta');
    const Popup = (module as { CompanyFollowPopup?: ComponentType<any> }).CompanyFollowPopup;
    check('E-POS-02-popup-export', typeof Popup, 'function', errors);
    if (typeof Popup !== 'function') {
      finish(errors);
      return;
    }

    const onShown = vi.fn();
    const subscribe = vi.fn(async () => {
      throw new Error('subscribe must be owned by the inline CTA after acceptance');
    });
    const captureEmail = vi.fn(async () => {});
    const key = companyAlertKey('Acme');

    vi.useFakeTimers();
    render(
      <>
        <div data-company-follow-inline={key}>
          <CompanyFollowButton
            company="Acme"
            companyKey={key}
            userId={null}
            email={null}
            locale={CONTROLLED_LOCALE}
            subscribe={subscribe as never}
            captureEmail={captureEmail}
          />
        </div>
        <Popup
          company="Acme"
          companyKey={key}
          locale={CONTROLLED_LOCALE}
          surface="company_follow_profile"
          userId={null}
          email={null}
          authLoading={false}
          onShown={onShown}
        />
      </>,
    );

    check('E-POS-02-no-popup-before-eligibility-delay',
      screen.queryByRole('dialog') !== null, false, errors);
    check('E-POS-03-no-subscription-on-mount', subscribe.mock.calls.length, 0, errors);
    await act(async () => {
      vi.advanceTimersByTime(899);
    });
    check('E-NEG-11-no-subscription-before-popup-visible', subscribe.mock.calls.length, 0, errors);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    check('E-POS-02-popup-visible-after-delay',
      screen.queryByRole('dialog') !== null, true, errors);
    check('E-POS-02-impression-after-visibility', onShown.mock.calls.length, 1, errors);
    // Oracle correction: BottomPromptShell publishes the shared slot with a
    // colon. The previous hyphen selector expected an attribute value that
    // production never emits, so it rejected the correct shared-slot contract.
    check('E-POS-02-shared-popup-slot',
      document.querySelector('[data-bottom-prompt="company-follow-prompt:' + key + '"]') !== null,
      true,
      errors);

    const dialog = screen.queryByRole('dialog');
    if (dialog) {
      // Adversarial fixture: an unlabeled secondary control must not steal the
      // acceptance click merely because it renders first in the dialog.
      const secondary = document.createElement('button');
      secondary.type = 'button';
      secondary.textContent = 'Controllo secondario';
      dialog.prepend(secondary);
    }
    const accept = dialog
      ? within(dialog).queryByRole('button', { name: 'Segui Acme' })
      : null;
    check('E-POS-03-popup-keeps-inline-acceptance', Boolean(accept), true, errors);
    if (accept) {
      // Oracle correction: the label and the input both match the old
      // queryByLabelText(/azienda|company/i), so waitFor timed out on an
      // ambiguous query even though the capture form had opened correctly;
      // the stable input id is the unambiguous public seam for this form.
      await act(async () => {
        fireEvent.click(accept);
      });
      check('E-POS-03-popup-accept-does-not-write-alert', subscribe.mock.calls.length, 0, errors);
      check('E-POS-03-popup-accept-opens-capture',
        document.querySelector('#company-follow-email') !== null,
        true,
        errors);
    }
    finish(errors);
  });

  it('E-POS-03: anonymous CTA parks intent and creates no active alert before confirmation', async () => {
    const errors: unknown[] = [];
    let newsletterStatus = 'none';
    const persistedAlerts: unknown[] = [];
    const captureEmail = vi.fn(async () => {
      newsletterStatus = 'pending';
    });
    const subscribe = vi.fn(async () => {
      persistedAlerts.push({ active: true });
      return { id: 'unexpected-active-alert' } as never;
    });

    render(
      <CompanyFollowButton
        company="Acme"
        companyKey={EXPECTED_CANONICAL_KEYS.acme}
        userId={null}
        email={null}
        locale={CONTROLLED_LOCALE}
        subscribe={subscribe as never}
        captureEmail={captureEmail}
      />,
    );
    await waitFor(() => screen.getByRole('button', { name: /Segui questa azienda/i }));
    fireEvent.click(screen.getByRole('button', { name: /Segui questa azienda/i }));
    const emailInput = await screen.findByLabelText(/azienda|company/i);
    fireEvent.change(emailInput, { target: { value: CONTROLLED_EMAIL } });
    await act(async () => {
      fireEvent.submit(emailInput.closest('form') as HTMLFormElement);
    });
    await waitFor(() => {
      if (captureEmail.mock.calls.length !== 1) throw new Error('capture seam was not called');
    });

    check('E-POS-03-newsletter-is-pending', newsletterStatus, 'pending', errors);
    check('E-POS-03-pending-intent-is-persisted', readPendingCompanyFollows().length, 1, errors);
    check('E-POS-03-no-active-alert-before-confirmation', persistedAlerts.length, 0, errors);
    check('E-POS-03-no-direct-subscribe-before-confirmation', subscribe.mock.calls.length, 0, errors);
    finish(errors);
  });

  it('E-POS-04: confirmation then flush creates one immediate canonical alert', async () => {
    const errors: unknown[] = [];
    savePendingCompanyFollow({
      company: 'Acme',
      companyKey: null,
      locale: CONTROLLED_LOCALE,
      sourceJobSlug: 'company-alert-oracle-acme',
      sourceJobUrl: 'https://frontaliereticino.ch/lavoro/company-alert-oracle-acme/',
      sourceJobTitle: 'Ruolo controllato Acme',
      email: CONTROLLED_EMAIL,
    });

    let newsletterStatus = 'pending';
    const persisted: Array<Record<string, unknown>> = [];
    const subscribe = vi.fn(async (
      userId: string,
      email: string,
      company: { name: string; companyKey?: string | null },
      locale: string,
    ) => {
      if (newsletterStatus !== 'confirmed') throw new Error('consent not confirmed');
      const record = {
        id: 'alert-created-once',
        userId,
        email,
        locale,
        active: true,
        frequency: 'immediate',
        specificCompanyKey: companyAlertKey(company.name, company.companyKey || undefined),
        consentPurpose: 'companyFollow',
      };
      persisted.push(record);
      return record as never;
    });

    check('E-POS-04-no-record-while-pending', persisted.length, 0, errors);
    newsletterStatus = 'confirmed';
    const first = normalizeFlushOutcome(
      await flushPendingCompanyFollows(CONTROLLED_USER_ID, CONTROLLED_EMAIL, subscribe as never),
    );
    const second = normalizeFlushOutcome(
      await flushPendingCompanyFollows(CONTROLLED_USER_ID, CONTROLLED_EMAIL, subscribe as never),
    );
    check('E-POS-04-one-created-alert', first.created.length, 1, errors);
    check('E-POS-04-one-persisted-record', persisted.length, 1, errors);
    check('E-POS-04-immediate-frequency', persisted[0]?.frequency, 'immediate', errors);
    check('E-POS-04-canonical-pin', persisted[0]?.specificCompanyKey, EXPECTED_CANONICAL_KEYS.acme, errors);
    check('E-POS-04-purpose-scoped-consent', persisted[0]?.consentPurpose, 'companyFollow', errors);
    check('E-POS-04-second-flush-creates-none', second.created.length, 0, errors);
    check('E-POS-04-second-flush-does-not-call-write', subscribe.mock.calls.length, 1, errors);
    check('E-POS-04-intent-is-consumed-on-success', readPendingCompanyFollows().length, 0, errors);
    check('E-POS-04-confirmation-state-was-required', newsletterStatus, 'confirmed', errors);
    finish(errors);
  });

  it('E-NEG-02: newsletter-only confirmation returns an explicit follow-up marker', async () => {
    const errors: unknown[] = [];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        authToken: 'fixture-auth-token',
        companyFollowFollowup: {
          required: true,
          sourcePath: '/aziende/acme/',
          newsletterActive: true,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await confirmNewsletterSubscription(CONTROLLED_EMAIL, 'fixture-confirmation-token');
    check('E-NEG-02-confirmation-succeeds', result.success, true, errors);
    check('E-NEG-02-followup-marker-required',
      Boolean((result as { companyFollowFollowup?: { required?: boolean } }).companyFollowFollowup?.required),
      true,
      errors);
    check('E-NEG-02-followup-marker-path',
      (result as { companyFollowFollowup?: { sourcePath?: string } }).companyFollowFollowup?.sourcePath,
      '/aziende/acme/',
      errors);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0] || '');
    check('E-NEG-02-no-email-or-token-in-request-url',
      requestUrl.includes(CONTROLLED_EMAIL) || requestUrl.includes('fixture-confirmation-token'),
      false,
      errors);
    finish(errors);
  });
});

describe('E oracle: sender, matching, provider, and writeback', () => {
  it('E-POS-05/E-POS-06: one new matching offer becomes one pertinent fake email', async () => {
    const errors: unknown[] = [];
    const now = Date.now();
    const alert = makeAlert('acme-follow', 'Acme', EXPECTED_CANONICAL_KEYS.acme);
    const goodJob = makeJob('acme-job-new', 'ACME', now, 1, {
      url: 'https://example.test/lavoro/acme-job-new/',
    });
    const wrongJob = makeJob('acme-holdings-job', 'Acme Holdings', now, 1, {
      url: 'https://example.test/lavoro/acme-holdings-job/',
    });
    const selected = selectNewlyPublishedJobs([goodJob, wrongJob], now, WINDOW_MS);
    check('E-POS-05-firstSeen-window-counts-fresh-input', selected.length, 2, errors);

    const sections = buildRecipientSections([alert], selected, now);
    check('E-POS-05-only-canonical-company-match',
      sections.flatMap((section) => section.jobs.map((job) => job.id)),
      ['acme-job-new'],
      errors);

    const renderedInput = sections.map((section) => ({
      alertId: section.alert.id,
      companyName: 'Acme',
      companySlug: EXPECTED_CANONICAL_KEYS.acme,
      jobs: section.jobs,
      unsubscribeUrl: 'https://example.test/disiscrivi-alert/acme/',
    }));
    const email = buildCompanyAlertEmail({
      sections: renderedInput,
      email: CONTROLLED_EMAIL,
      locale: CONTROLLED_LOCALE,
      manageUrl: 'https://example.test/aziende-seguite/',
      unsubscribeAllUrl: 'https://example.test/disiscrivi-alert/',
      wrapUrl: (url: string) => url,
      wrapJobUrl: (url: string) => url,
      baseUrl: 'https://example.test',
      now,
    });
    const captured: Array<{ to: string; subject: string; html: string }> = [];
    const fakeProvider = {
      async send(message: { to: string; subject: string; html: string }) {
        captured.push(message);
        return { provider: 'fixture-provider', messageId: 'fixture-accepted-1' };
      },
    };
    await fakeProvider.send({ to: CONTROLLED_EMAIL, subject: email.subject, html: email.html });
    check('E-POS-06-one-email-captured', captured.length, 1, errors);
    check('E-POS-06-pertinent-job-link',
      captured[0]?.html.includes('acme-job-new/'),
      true,
      errors);
    check('E-NEG-01-wrong-job-link-absent',
      captured[0]?.html.includes('acme-holdings-job/'),
      false,
      errors);
    check('E-POS-06-rendered-section-count', email.sections.length, 1, errors);
    check('E-POS-06-company-hub-uses-canonical-key',
      companyHubUrl(EXPECTED_CANONICAL_KEYS.acme, CONTROLLED_LOCALE, 'https://example.test'),
      'https://example.test/aziende/acme/',
      errors);
    finish(errors);
  });

  it('E-NEG-04: fresh but expired or closed offers are never selected or rendered', async () => {
    const errors: unknown[] = [];
    const now = Date.now();
    const open = makeJob('open-job', 'Acme', now, 1, {
      expiresAt: hoursAhead(now, 12),
      status: 'open',
    });
    const expired = makeJob('expired-job', 'Acme', now, 1, {
      expiresAt: hoursAgo(now, 1),
      status: 'expired',
    });
    const closed = makeJob('closed-job', 'Acme', now, 1, {
      status: 'closed',
    });
    check('E-NEG-04-selection-excludes-expired-and-closed',
      selectNewlyPublishedJobs([open, expired, closed], now, WINDOW_MS).map((job) => job.id),
      ['open-job'],
      errors);
    const alert = makeAlert('acme-expiry-check', 'Acme', EXPECTED_CANONICAL_KEYS.acme);
    check('E-NEG-04-render-excludes-expired',
      buildRecipientSections([alert], [expired], now).length,
      0,
      errors);
    check('E-NEG-04-render-excludes-closed',
      buildRecipientSections([alert], [closed], now).length,
      0,
      errors);
    finish(errors);
  });

  it('E-NEG-03: paused, unsubscribed, and non-immediate alerts never send', () => {
    const errors: unknown[] = [];
    const alerts = [
      makeAlert('active-immediate', 'Acme', EXPECTED_CANONICAL_KEYS.acme),
      makeAlert('paused-immediate', 'Acme', EXPECTED_CANONICAL_KEYS.acme, { paused: true }),
      makeAlert('inactive-immediate', 'Acme', EXPECTED_CANONICAL_KEYS.acme, { active: false }),
      makeAlert('weekly-company', 'Acme', EXPECTED_CANONICAL_KEYS.acme, { frequency: 'weekly' }),
    ];
    check('E-NEG-03-immediate-routing-only-live-alert',
      alerts.filter(isImmediateCompanyAlert).map((alert) => alert.id),
      ['active-immediate'],
      errors);
    check('E-NEG-03-paused-is-not-a-frequency',
      isImmediateCompanyAlert({ specificCompanyKey: EXPECTED_CANONICAL_KEYS.acme, frequency: 'paused' }),
      false,
      errors);
    check('E-NEG-03-unsubscribe-does-not-reactivate',
      isImmediateCompanyAlert({
        specificCompanyKey: EXPECTED_CANONICAL_KEYS.acme,
        frequency: 'immediate',
        active: false,
        paused: false,
      }),
      false,
      errors);
    finish(errors);
  });

  it('E-POS-08: unfollow deactivates the alert and blocks later delivery', async () => {
    const errors: unknown[] = [];
    const now = Date.now();
    const persisted = makeAlert(
      'unfollow-alert',
      'Acme',
      EXPECTED_CANONICAL_KEYS.acme,
      { active: true },
    );
    const lookup = vi.fn(async () => persisted) as never;
    const unfollow = vi.fn(async () => {
      persisted.active = false;
    }) as never;

    render(
      <CompanyFollowButton
        company="Acme"
        companyKey={EXPECTED_CANONICAL_KEYS.acme}
        userId={CONTROLLED_USER_ID}
        email={CONTROLLED_EMAIL}
        locale={CONTROLLED_LOCALE}
        lookup={lookup}
        unfollow={unfollow}
      />,
    );
    await waitFor(() => screen.getByRole('button', { name: /Stai seguendo questa azienda/i }));
    check('E-POS-08-active-before-unfollow', persisted.active, true, errors);
    fireEvent.click(screen.getByRole('button', { name: /Stai seguendo questa azienda/i }));
    await waitFor(() => {
      if (unfollow.mock.calls.length !== 1) throw new Error('unfollow seam was not called');
    });
    check('E-POS-08-unfollow-called-with-controlled-recipient',
      unfollow.mock.calls[0]?.slice(0, 2),
      [CONTROLLED_EMAIL, 'unfollow-alert'],
      errors);
    check('E-POS-08-active-false-persisted', persisted.active, false, errors);
    const laterJob = makeJob('after-unfollow-job', 'ACME', now, 1);
    const laterSections = buildRecipientSections(
      [persisted].filter(isImmediateCompanyAlert),
      [laterJob],
      now,
    );
    check('E-POS-08-no-later-sections-after-unfollow', laterSections.length, 0, errors);
    finish(errors);
  });

  it('E-NEG-05: unknown consent and suppression states defer with a reason', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    const classify = api.classifyRecipientConsent;
    check('E-NEG-05-consent-classifier-export', typeof classify, 'function', errors);
    if (typeof classify !== 'function') {
      finish(errors);
      return;
    }
    const activeJobAlert = { exists: true, data: { status: 'active', active: true } };
    const cases = [
      {
        id: 'missing-newsletter',
        newsletter: { exists: false },
        expected: { action: 'defer', reason: 'consent-document-missing' },
      },
      {
        id: 'pending-newsletter',
        newsletter: { exists: true, data: { status: 'pending', active: true } },
        expected: { action: 'defer', reason: 'newsletter-consent-status-unknown' },
      },
      {
        id: 'malformed-newsletter',
        newsletter: { exists: true, data: null },
        expected: { action: 'defer', reason: 'consent-document-malformed' },
      },
      {
        id: 'unknown-job-alert',
        newsletter: { exists: true, data: { status: 'confirmed', active: true } },
        jobAlert: { exists: true, data: { status: 'mystery', active: true } },
        expected: { action: 'defer', reason: 'job-alert-consent-status-unknown' },
      },
      {
        id: 'known-sendable',
        newsletter: { exists: true, data: { status: 'confirmed', active: true } },
        jobAlert: activeJobAlert,
        expected: { action: 'send', reason: 'consent-known-ok' },
      },
      {
        id: 'cross-channel-stop',
        newsletter: { exists: true, data: { status: 'unsubscribed', active: true } },
        jobAlert: activeJobAlert,
        expected: { action: 'suppress', reason: 'newsletter-cross-channel-stop' },
      },
    ];
    for (const fixture of cases) {
      check(
        'E-NEG-05-' + fixture.id,
        classify(fixture.newsletter, fixture.jobAlert || activeJobAlert),
        fixture.expected,
        errors,
      );
    }
    finish(errors);
  });

  it('E-NEG-06/E-NEG-08: provider ACK, failure, and ambiguous outcomes stay distinct', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    const accepted = {
      sent: [{ to: CONTROLLED_EMAIL, provider: 'fixture-provider', messageId: 'fixture-accepted-1' }],
      failed: [],
    };
    const emptyAck = {
      sent: [{ to: CONTROLLED_EMAIL, status: 200, body: {} }],
      failed: [],
    };
    check('E-NEG-08-explicit-ack-function', typeof api.hasExplicitProviderAcceptance, 'function', errors);
    if (typeof api.hasExplicitProviderAcceptance === 'function') {
      check('E-NEG-08-empty-200-is-not-ack',
        api.hasExplicitProviderAcceptance(emptyAck.sent[0]),
        false,
        errors);
      check('E-POS-07-explicit-provider-ack',
        api.hasExplicitProviderAcceptance(accepted.sent[0]),
        true,
        errors);
    }
    check('E-NEG-08-outcome-classifier-function', typeof api.classifyProviderOutcomes, 'function', errors);
    if (typeof api.classifyProviderOutcomes === 'function') {
      const classified = api.classifyProviderOutcomes(emptyAck);
      check('E-NEG-08-empty-200-is-ambiguous',
        [classified.sent.length, classified.failed.length, classified.failed[0]?.ambiguousDelivery],
        [0, 1, true],
        errors);
    }
    check('E-NEG-08-outcome-for-email-function', typeof api.deliveryOutcomeForEmail, 'function', errors);
    if (typeof api.deliveryOutcomeForEmail === 'function') {
      const ambiguous = api.deliveryOutcomeForEmail(
        { to: CONTROLLED_EMAIL },
        { sent: [], failed: [{ to: CONTROLLED_EMAIL, ambiguousDelivery: true }] },
      );
      check('E-NEG-08-ambiguous-outcome',
        ambiguous.outcome,
        'ambiguous',
        errors);
    }
    check('E-NEG-08-ambiguous-not-persistable',
      typeof api.selectPersistableSends === 'function'
        ? api.selectPersistableSends(
          [{ to: CONTROLLED_EMAIL }],
          [{ to: CONTROLLED_EMAIL, ambiguousDelivery: true }],
        ).length
        : null,
      0,
      errors);
    finish(errors);
  });

  it('E-NEG-13: a provider 2xx without an id is ambiguous and terminal', async () => {
    const errors: unknown[] = [];
    const envKeys = [
      'MAILJET_API_KEY',
      'MAILJET_SECRET_KEY',
      'MAILGUN_API_KEY',
      'MAILGUN_DOMAIN',
      'MAILTRAP_API_TOKEN',
      'MAILEROO_API_KEY',
      'MAILEROO_ACCOUNT_API_KEY',
      'RESEND_API_KEY',
      'CF_API_TOKEN',
      'CF_ACCOUNT_ID',
      'CLOUDFLARE_EMAIL_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'CF_EMAIL_API_TOKEN',
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const realFetch = globalThis.fetch;
    const preEnvironmentCascade = await import('../functions/src/emailCascade.js');
    let mailgunSends = 0;
    let mailjetSends = 0;
    const response = (json: Record<string, unknown>) => ({
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    });

    try {
      for (const key of envKeys) delete process.env[key];
      Object.assign(process.env, {
        MAILGUN_API_KEY: 'oracle-mailgun-key',
        MAILGUN_DOMAIN: 'oracle.example.test',
        MAILJET_API_KEY: 'oracle-mailjet-key',
        MAILJET_SECRET_KEY: 'oracle-mailjet-secret',
      });
      globalThis.fetch = vi.fn(async (url: unknown, options?: { method?: string }) => {
        const target = String(url);
        if (target.includes('mailgun.net') && options?.method === 'POST') {
          mailgunSends += 1;
          return response({});
        }
        if (target.includes('mailjet.com') && options?.method === 'POST') {
          mailjetSends += 1;
          return response({ Messages: [{ To: [{ MessageID: 'unexpected-fallback-id' }] }] });
        }
        return response({});
      }) as typeof globalThis.fetch;

      // The module may have been imported by another test before this env
      // setup. Force the cascade under test to observe this test's provider
      // contract from a fresh module graph rather than a cached module.
      vi.resetModules();
      const { sendEmailCascade } = await import('../functions/src/emailCascade.js');
      check('E-NEG-13-provider-import-is-isolated',
        sendEmailCascade === preEnvironmentCascade.sendEmailCascade,
        false,
        errors);
      const result = await sendEmailCascade([{
        payload: {
          from: 'Company Alert Oracle <company-alert-oracle@example.test>',
          to: [CONTROLLED_EMAIL],
          subject: 'C6-bis oracle fixture',
          html: '<p>C6-bis oracle fixture</p>',
        },
        recipient: { email: CONTROLLED_EMAIL },
        meta: {},
      }], { delayMs: 0 });

      // C6-bis is now a live contract on this base: #8152 is closed and its
      // fix is present through merged #8153. These remain ordinary assertions;
      // an expected-failure marker would misrepresent the current code.
      check('E-NEG-13-2xx-without-id-not-accepted', result.accepted.length, 0, errors);
      check('E-NEG-13-2xx-without-id-is-ambiguous',
        [result.ambiguous.length, result.failed.length, mailjetSends],
        [1, 0, 0],
        errors);
      check('E-NEG-13-no-synthetic-id-in-accepted',
        [result.accepted.some((item: { messageId?: unknown }) => /^mg-\d+$/.test(String(item.messageId))),
          result.ambiguous[0]?.messageId ?? null, mailgunSends],
        [false, null, 1],
        errors);
    } finally {
      globalThis.fetch = realFetch;
      for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key];
      }
    }
    finish(errors);
  });

  it('E-NEG-06/E-NEG-08: accepted writeback and an uncertain retry are durable decisions', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    const dedup = await dedupApi();
    const job = makeJob('writeback-job', 'Acme', Date.now(), 1);
    const plan = api.planDeliveryWriteback;
    check('E-POS-07-writeback-planner-export', typeof plan, 'function', errors);
    check('E-NEG-06-ledger-filter-export', typeof dedup.filterUnsentJobs, 'function', errors);
    if (typeof plan !== 'function' || typeof dedup.filterUnsentJobs !== 'function') {
      finish(errors);
      return;
    }
    const accepted = plan(
      { sentJobIds: {}, deliveryLedger: {} },
      [job],
      'accepted',
      Date.now(),
      { provider: 'fixture-provider', messageId: 'fixture-accepted-1' },
    );
    check('E-POS-07-accepted-enters-sent-map',
      Number.isFinite(accepted.sentJobIds?.[job.id as string]),
      true,
      errors);
    check('E-POS-07-accepted-clears-ledger-entry',
      accepted.deliveryLedger?.[job.id as string],
      undefined,
      errors);

    const ambiguous = plan(
      { sentJobIds: {}, deliveryLedger: {} },
      [job],
      'ambiguous',
      Date.now(),
      { provider: 'fixture-provider', messageId: 'fixture-uncertain-1', reason: 'response-lost' },
    );
    check('E-NEG-08-ambiguous-persists',
      ambiguous.deliveryLedger?.[job.id as string]?.state,
      'ambiguous',
      errors);
    check('E-NEG-08-ambiguous-not-in-sent-map',
      ambiguous.sentJobIds?.[job.id as string],
      undefined,
      errors);
    check('E-NEG-06-claimed-interruption-blocks-retry',
      dedup.filterUnsentJobs(
        [job],
        {},
        Date.now(),
        30 * 24 * 60 * 60 * 1000,
        { [job.id as string]: { state: 'claimed', at: Date.now() } },
      ).length,
      0,
      errors);
    check('E-NEG-08-ambiguous-retry-blocks',
      dedup.filterUnsentJobs(
        [job],
        {},
        Date.now(),
        30 * 24 * 60 * 60 * 1000,
        ambiguous.deliveryLedger,
      ).length,
      0,
      errors);
    finish(errors);
  });

  it('E-NEG-06: an orphaned old claim is recoverable', async () => {
    const errors: unknown[] = [];
    const dedup = await dedupApi();
    const job = makeJob('stale-claim-job', 'Acme', Date.now(), 1);
    const now = Date.now();
    check('E-NEG-06-ledger-retry-guard-export',
      typeof dedup.deliveryEntryBlocksRetry,
      'function',
      errors);
    if (typeof dedup.deliveryEntryBlocksRetry !== 'function') {
      finish(errors);
      return;
    }
    check('E-NEG-06-stale-claim-is-recoverable',
      dedup.filterUnsentJobs(
        [job],
        {},
        now,
        30 * 24 * 60 * 60 * 1000,
        { [job.id as string]: { state: 'claimed', at: now - 2 * 30 * 24 * 60 * 60 * 1000 } },
      ).length,
      1,
      errors);
    finish(errors);
  });

  it('E-NEG-07: two concurrent runs claim one recipient/job pair once', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    const claim = api.claimRecipientSections;
    check('E-NEG-07-claim-function', typeof claim, 'function', errors);
    if (typeof claim !== 'function') {
      finish(errors);
      return;
    }
    const now = Date.now();
    const alert = makeAlert('concurrent-alert', 'Acme', EXPECTED_CANONICAL_KEYS.acme);
    const job = makeJob('concurrent-job', 'ACME', now, 1);
    const section = buildRecipientSections([alert], [job], now)[0];
    check('E-NEG-07-section-is-built', Boolean(section), true, errors);
    if (!section) {
      finish(errors);
      return;
    }
    const db = makeSerializedTransactionDb({
      ...alert,
      deliveryLedger: {},
      sentJobIds: {},
    });
    const [first, second] = await Promise.all([
      claim(db, [section], now, 'fixture-run-a'),
      claim(db, [section], now, 'fixture-run-b'),
    ]);
    check('E-NEG-07-one-winner-one-loser',
      [first.length, second.length].sort((a: number, b: number) => a - b),
      [0, 1],
      errors);
    check('E-NEG-07-one-provider-call-would-follow',
      first.length + second.length,
      1,
      errors);
    check('E-NEG-07-claim-is-persisted',
      (db.state.data.deliveryLedger as Record<string, any>)?.['concurrent-job']?.state,
      'claimed',
      errors);
    finish(errors);
  });

  it('E-NEG-09: id-less jobs are quarantined and never enter an idempotent send', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    const dedup = await dedupApi();
    const quarantine = api.companyAlertJobQuarantines;
    const jobIdentityReason = dedup.jobIdentityQuarantineReason;
    check('E-NEG-09-job-identity-quarantine-export', typeof jobIdentityReason, 'function', errors);
    if (typeof jobIdentityReason === 'function') {
      check('E-NEG-09-idless-reason',
        jobIdentityReason(makeJob(null, 'Acme', Date.now(), 1)),
        'missing-stable-job-identity',
        errors);
    }
    check('E-NEG-09-quarantine-list-export', typeof quarantine, 'function', errors);
    if (typeof quarantine === 'function') {
      const alert = makeAlert('idless-alert', 'Acme', EXPECTED_CANONICAL_KEYS.acme);
      const result = quarantine(alert, [makeJob(null, 'Acme', Date.now(), 1)]);
      check('E-NEG-09-quarantine-count', result.length, 1, errors);
      check('E-NEG-09-quarantine-reason', result[0]?.reason, 'missing-stable-job-identity', errors);
    }
    check('E-NEG-09-idless-filter-export', typeof dedup.filterUnsentJobs, 'function', errors);
    if (typeof dedup.filterUnsentJobs === 'function') {
      check('E-NEG-09-idless-filtered-out',
        dedup.filterUnsentJobs(
          [makeJob(null, 'Acme', Date.now(), 1)],
          {},
          Date.now(),
        ).length,
        0,
        errors);
    }
    finish(errors);
  });

  it('E-NEG-10: cap overflow remains a visible, ordered backlog', async () => {
    const errors: unknown[] = [];
    const api = await senderApi();
    check('E-NEG-10-cap-export', typeof api.PER_RUN_CAP, 'number', errors);
    check('E-NEG-10-cap-value', api.PER_RUN_CAP, 300, errors);
    check('E-NEG-10-backlog-sort-export', typeof api.sortCompanyAlertRecipients, 'function', errors);
    check('E-NEG-10-deferred-plan-export', typeof api.planDeferredDeliveryWrites, 'function', errors);
    if (typeof api.sortCompanyAlertRecipients === 'function') {
      const backlog = makeAlert(
        'backlog-alert',
        'Acme',
        EXPECTED_CANONICAL_KEYS.acme,
        { deliveryLedger: { 'backlog-job': { state: 'deferred', at: Date.now() } } },
      );
      const fresh = { ...makeAlert('fresh-alert', 'Acme', EXPECTED_CANONICAL_KEYS.acme), email: 'fresh@example.test' };
      const byRecipient = groupAlertsByRecipient([
        { ...backlog, email: 'backlog@example.test' },
        fresh,
      ]);
      check('E-NEG-10-backlog-first',
        api.sortCompanyAlertRecipients(byRecipient),
        ['backlog@example.test', 'fresh@example.test'],
        errors);
    }
    if (typeof api.planDeferredDeliveryWrites === 'function') {
      const job = makeJob('cap-job', 'Acme', Date.now(), 1);
      const alert = makeAlert('cap-alert', 'Acme', EXPECTED_CANONICAL_KEYS.acme);
      const writes = api.planDeferredDeliveryWrites(
        [{ alert, jobs: [job] }],
        Date.now(),
        'per-run-cap',
      );
      check('E-NEG-10-one-deferred-write', writes.length, 1, errors);
      check('E-NEG-10-deferred-reason', writes[0]?.reason, 'per-run-cap', errors);
    }
    finish(errors);
  });

  it('E-NEG-02: a failed intent flush is observable and retryable', async () => {
    const errors: unknown[] = [];
    savePendingCompanyFollow({
      company: 'Acme',
      companyKey: EXPECTED_CANONICAL_KEYS.acme,
      locale: CONTROLLED_LOCALE,
      sourceJobSlug: 'company-alert-oracle-acme',
      sourceJobUrl: 'https://frontaliereticino.ch/lavoro/company-alert-oracle-acme/',
      sourceJobTitle: 'Ruolo controllato Acme',
      email: CONTROLLED_EMAIL,
    });
    const outcome = normalizeFlushOutcome(
      await flushPendingCompanyFollows(
        CONTROLLED_USER_ID,
        CONTROLLED_EMAIL,
        vi.fn(async () => {
          throw new Error('permission denied by fixture');
        }) as never,
      ),
    );
    check('E-NEG-02-failed-flush-count', outcome.failed.length, 1, errors);
    check('E-NEG-02-failed-flush-pending-count', outcome.pending, 1, errors);
    check('E-NEG-02-failed-flush-queue-retained', readPendingCompanyFollows().length, 1, errors);
    check('E-NEG-02-failed-flush-no-created-alert', outcome.created.length, 0, errors);
    finish(errors);
  });
});

describe('E oracle: regressions outside company alerts', () => {
  it('E-NEG-12: category popup remains visible and creates only after acceptance', async () => {
    const errors: unknown[] = [];
    const subscribe = vi.fn(async () => ({
      id: 'category-alert',
      userId: CONTROLLED_USER_ID,
      email: CONTROLLED_EMAIL,
      keywords: ['Tecnologia'],
      locations: [],
      contractTypes: [],
      sectors: [],
      frequency: 'weekly',
      locale: CONTROLLED_LOCALE,
      active: true,
      createdAt: new Date(),
      lastMatchedAt: null,
      matchCount: 0,
    }));
    render(
      <JobDetailAlertPrompt
        category="Tecnologia"
        userId={CONTROLLED_USER_ID}
        email={CONTROLLED_EMAIL}
        locale={CONTROLLED_LOCALE}
        cantonCode="TI"
        onClose={vi.fn()}
        onAccepted={vi.fn()}
        onDismissed={vi.fn()}
        onErrored={vi.fn()}
        onManage={vi.fn()}
        subscribe={subscribe as never}
      />,
    );
    check('E-NEG-12-category-dialog-visible', screen.queryByRole('dialog') !== null, true, errors);
    check('E-NEG-12-category-not-auto-subscribed', subscribe.mock.calls.length, 0, errors);
    fireEvent.click(screen.getByText(/Sì, attiva/));
    await waitFor(() => {
      if (subscribe.mock.calls.length !== 1) throw new Error('category acceptance did not call subscribe');
    });
    check('E-NEG-12-category-subscribes-on-accept', subscribe.mock.calls.length, 1, errors);
    finish(errors);
  });

  it('E-NEG-12: existing category CTA remains separate and weekly', async () => {
    const errors: unknown[] = [];
    const subscribe = vi.fn(async () => ({ id: 'category-cta-alert' })) as never;
    render(
      <JobBoardFilterAlertCta
        userId={CONTROLLED_USER_ID}
        email={CONTROLLED_EMAIL}
        locale={CONTROLLED_LOCALE}
        keywordLabel="Tecnologia"
        cantonCode="TI"
        onSubscribed={vi.fn()}
        onErrored={vi.fn()}
        subscribe={subscribe}
      />,
    );
    check('E-NEG-12-category-cta-visible',
      screen.queryByText(/Avvisami per questa ricerca/) !== null,
      true,
      errors);
    fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    await waitFor(() => {
      if (subscribe.mock.calls.length !== 1) throw new Error('category CTA did not call subscribe');
    });
    check('E-NEG-12-category-cta-is-one-call', subscribe.mock.calls.length, 1, errors);
    check('E-NEG-12-category-cta-does-not-use-immediate',
      subscribe.mock.calls[0]?.[3],
      CONTROLLED_LOCALE,
      errors);
    finish(errors);
  });

  it('E-NEG-11: public popup inputs use the shared canonical link shape', () => {
    const errors: unknown[] = [];
    check('E-NEG-11-canonical-company-link',
      companyHubUrl(companyAlertKey('Guess Ticino'), 'it', 'https://example.test'),
      'https://example.test/aziende/guess-europe-sagl/',
      errors);
    check('E-NEG-11-no-trailing-slash-variant',
      companyHubUrl(companyAlertKey('Guess Ticino'), 'it', 'https://example.test').endsWith('/'),
      true,
      errors);
    finish(errors);
  });
});
