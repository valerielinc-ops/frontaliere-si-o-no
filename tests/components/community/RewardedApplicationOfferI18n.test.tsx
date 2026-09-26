// @vitest-environment jsdom
/**
 * Every visible string of the rewarded application overlay follows the page
 * locale and names the job the visitor is applying to (the Offerwall's own
 * copy is Google's and cannot). Long titles are shortened, a missing title
 * falls back to the generic copy.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gptProps: null as Record<string, unknown> | null,
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.gptProps = props;
    return <div data-testid="mock-google-rewarded" />;
  },
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
  disposeRewardedWebAd: vi.fn(),
  isRewardedWebAdEligible: () => true,
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
  REWARDED_APPLICATION_ACCESS_TTL_HOURS: 1,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: vi.fn(),
}));
vi.mock('@/services/offerwallClickGate', () => ({
  offerwallGateStatus: () => 'absent',
  releaseHeldOfferwall: vi.fn(),
}));

import RewardedApplicationOffer, {
  REWARDED_OFFER_TITLE_MAX_CHARS,
  shortenRewardedOfferJobTitle,
} from '@/components/community/RewardedApplicationOffer';
import { ensureLocaleLoaded, itReady, setLocale, type Locale } from '@/services/i18n';

const baseProps = {
  jobId: 'job-1',
  companyId: 'company-1',
  companyName: 'EOC',
  jobTitle: 'Physiotherapist',
  onContinue: vi.fn(),
  onUnavailable: vi.fn(),
  onDismiss: vi.fn(),
};

const callGpt = <T extends unknown[]>(name: string, ...args: T) => {
  act(() => {
    (mocks.gptProps?.[name] as ((...callArgs: T) => void) | undefined)?.(...args);
  });
};

const COPY: Record<Exclude<Locale, 'it'>, {
  loading: string;
  redirect: string;
  title: string;
  subtitle: string;
  watch: string;
  playing: string;
  unavailable: string;
  close: string;
  retry: string;
  retryText: RegExp;
  genericLoading: string;
}> = {
  en: {
    loading: 'Opening “Physiotherapist”…',
    redirect: 'Taking you to “Physiotherapist”…',
    title: 'Watch a short video to apply for “Physiotherapist”',
    subtitle: 'Then 1 hour of applying with no videos',
    watch: 'Watch the video',
    playing: 'Video playing…',
    unavailable: 'The video is not available right now.',
    close: 'Close',
    retry: 'Try again',
    retryText: /closed before the end/,
    genericLoading: 'Opening the listing…',
  },
  de: {
    loading: '„Physiotherapist“ wird geöffnet…',
    redirect: 'Wir leiten Sie zu „Physiotherapist“ weiter…',
    title: 'Sehen Sie sich ein kurzes Video an, um sich auf „Physiotherapist“ zu bewerben',
    subtitle: 'Danach 1 Stunde lang ohne Video bewerben',
    watch: 'Video ansehen',
    playing: 'Video wird abgespielt…',
    unavailable: 'Das Video ist momentan nicht verfügbar.',
    close: 'Schließen',
    retry: 'Erneut versuchen',
    retryText: /vor dem Ende geschlossen/,
    genericLoading: 'Stelle wird geöffnet…',
  },
  fr: {
    loading: 'Ouverture de « Physiotherapist »…',
    redirect: 'Nous vous emmenons vers « Physiotherapist »…',
    title: 'Regardez une courte vidéo pour postuler à « Physiotherapist »',
    subtitle: 'Ensuite, 1 heure de candidatures sans vidéo',
    watch: 'Regarder la vidéo',
    playing: 'Vidéo en cours de lecture…',
    unavailable: 'La vidéo n’est pas disponible pour le moment.',
    close: 'Fermer',
    retry: 'Réessayer',
    retryText: /fermée avant la fin/,
    genericLoading: 'Ouverture de l’offre…',
  },
};

beforeAll(async () => {
  await itReady;
  await Promise.all((['en', 'de', 'fr'] as const).map((locale) => ensureLocaleLoaded(locale)));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gptProps = null;
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

afterAll(() => {
  setLocale('it');
});

describe('RewardedApplicationOffer — localized, job-specific copy', () => {
  it.each(['en', 'de', 'fr'] as const)('renders every overlay string in %s with the job title', (locale) => {
    setLocale(locale);
    const copy = COPY[locale];
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...baseProps} onContinue={onContinue} />);

    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent(copy.loading);
    expect(mocks.gptProps?.loadingLabel).toBe(copy.loading);
    expect(mocks.gptProps?.label).toBe(copy.watch);
    expect(mocks.gptProps?.showingLabel).toBe(copy.playing);
    expect(mocks.gptProps?.unavailableLabel).toBe(copy.unavailable);

    callGpt('onReady', { requestId: 1 });
    const card = screen.getByTestId('rewarded-application-opt-in');
    expect(card).toHaveTextContent(copy.title);
    expect(screen.getByTestId('rewarded-application-opt-in-subtitle')).toHaveTextContent(copy.subtitle);
    expect(screen.getByRole('button', { name: copy.close })).toBeInTheDocument();

    // Closed before the reward: localized retry card.
    callGpt('onClosed', false, { requestId: 1 });
    expect(screen.getByTestId('rewarded-application-retry')).toHaveTextContent(copy.retryText);
    expect(screen.getByRole('button', { name: copy.close })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.retry }));

    callGpt('onReady', { requestId: 2 });
    callGpt('onGranted', { requestId: 2 });
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent(copy.redirect);
  });

  it.each(['en', 'de', 'fr'] as const)('falls back to the generic copy in %s without a job title', (locale) => {
    setLocale(locale);
    render(<RewardedApplicationOffer {...baseProps} jobTitle="   " />);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent(COPY[locale].genericLoading);
    expect(screen.getByTestId('rewarded-application-loading').textContent).not.toMatch(/[“„«]/);
  });

  it('shortens a long title with an ellipsis and inserts it verbatim', () => {
    setLocale('it');
    const longTitle = 'Specialista in amministrazione del personale e gestione paghe multicantonali (80-100%)';
    const shortened = shortenRewardedOfferJobTitle(longTitle);
    expect(Array.from(shortened)).toHaveLength(REWARDED_OFFER_TITLE_MAX_CHARS);
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortenRewardedOfferJobTitle('  Infermiere   SUP  ')).toBe('Infermiere SUP');

    render(<RewardedApplicationOffer {...baseProps} jobTitle={longTitle} />);
    const loading = screen.getByTestId('rewarded-application-loading');
    expect(loading).toHaveTextContent(`Apertura di «${shortened}»…`);
    expect(loading.textContent).not.toContain(longTitle);
    cleanup();

    // `$&` is a String.replace pattern: the title must still appear as written.
    render(<RewardedApplicationOffer {...baseProps} jobTitle="Sales $& Marketing" />);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Apertura di «Sales $& Marketing»…');
  });
});
