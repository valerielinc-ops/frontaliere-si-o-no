/**
 * FeatureSurvey micro-survey coverage.
 *
 * Verifies the engagement gate (time + page views), the 90-day dismiss
 * cooldown, that showing the survey captures a single `feature_survey_impression`,
 * and that a submit captures `feature_survey_response` to PostHog (and GA via
 * Analytics) with the stable, locale-independent option id.
 */

import React from 'react';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import FeatureSurvey from '@/components/community/FeatureSurvey';
import { captureEvent } from '@/services/posthog';
import { Analytics } from '@/services/analytics';
import { isLikelyBot } from '@/services/botPatterns';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'it' as const,
  }),
}));

vi.mock('@/services/posthog', () => ({
  captureEvent: vi.fn(),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackEvent: vi.fn(),
    trackUIInteraction: vi.fn(),
  },
}));

vi.mock('@/services/botPatterns', () => ({
  isLikelyBot: vi.fn(() => false),
}));

// Popup queue: grant the slot immediately so visibility depends only on the
// component's own engagement gate, which is what we're testing.
vi.mock('@/services/popupQueue', () => ({
  requestSlot: vi.fn(() => true),
  releaseSlot: vi.fn(),
  isActive: vi.fn(() => true),
  subscribe: (listener: () => void) => {
    listener();
    return () => {};
  },
  POPUP_PRIORITY: { NEWSLETTER: 20 },
}));

const captureMock = vi.mocked(captureEvent);
const trackEventMock = vi.mocked(Analytics.trackEvent);
const isBotMock = vi.mocked(isLikelyBot);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  captureMock.mockClear();
  trackEventMock.mockClear();
  isBotMock.mockReturnValue(false);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe('FeatureSurvey engagement gate', () => {
  it('stays hidden before the time threshold elapses', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1'); // → 2 page views on mount
    await act(async () => {
      render(<FeatureSurvey />);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('appears after time + page-view thresholds are met', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('never shows for bots', async () => {
    isBotMock.mockReturnValue(true);
    sessionStorage.setItem('feature_survey_pageviews', '5');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('respects the 90-day dismiss cooldown', async () => {
    localStorage.setItem('feature_survey_dismissed', String(Date.now()));
    sessionStorage.setItem('feature_survey_pageviews', '5');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FeatureSurvey impression', () => {
  it('captures a single impression once the survey is shown', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });

    const impressions = captureMock.mock.calls.filter(([name]) => name === 'feature_survey_impression');
    expect(impressions).toHaveLength(1);
    expect(impressions[0][1]).toMatchObject({ page: expect.any(String) });
    expect(trackEventMock).toHaveBeenCalledWith('feature_survey_impression', expect.any(Object));
  });

  it('does not fire an impression before the engagement gate is met', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    // No timer advance → survey not shown yet.
    expect(captureMock).not.toHaveBeenCalledWith('feature_survey_impression', expect.anything());
  });
});

describe('FeatureSurvey submission', () => {
  it('captures the stable option id to PostHog and GA, then sets the cooldown', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });

    // Pick a feature chip (label key === stable id mapping via t()).
    fireEvent.click(screen.getByText('survey.feature.option.traffic_alerts'));
    fireEvent.click(screen.getByText('survey.feature.submit'));

    const responseCall = captureMock.mock.calls.find(([name]) => name === 'feature_survey_response');
    expect(responseCall).toBeDefined();
    expect(responseCall![1]).toMatchObject({ feature: 'traffic_alerts' });
    expect(trackEventMock).toHaveBeenCalledWith('feature_survey_response', expect.objectContaining({ feature: 'traffic_alerts' }));
    expect(localStorage.getItem('feature_survey_dismissed')).not.toBeNull();
  });

  it('includes free-text detail when "other" is chosen', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });

    fireEvent.click(screen.getByText('survey.feature.option.other'));
    fireEvent.change(screen.getByPlaceholderText('survey.feature.otherPlaceholder'), {
      target: { value: 'PDF export of payslips' },
    });
    fireEvent.click(screen.getByText('survey.feature.submit'));

    const responseCall = captureMock.mock.calls.find(([name]) => name === 'feature_survey_response');
    expect(responseCall).toBeDefined();
    expect(responseCall![1]).toMatchObject({ feature: 'other', detail: 'PDF export of payslips' });
  });

  it('does not submit when no feature is selected', async () => {
    sessionStorage.setItem('feature_survey_pageviews', '1');
    await act(async () => {
      render(<FeatureSurvey />);
    });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });

    fireEvent.click(screen.getByText('survey.feature.submit'));
    expect(captureMock).not.toHaveBeenCalledWith('feature_survey_response', expect.anything());
  });
});
