import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import LanguageSelector from '@/components/shared/LanguageSelector';

const {
  setLocaleMock,
  trackSettingsChangeMock,
  ensureJobSlugMapForPathMock,
  updatePathForLocaleMock,
} = vi.hoisted(() => ({
  setLocaleMock: vi.fn(),
  trackSettingsChangeMock: vi.fn(),
  ensureJobSlugMapForPathMock: vi.fn(async () => {}),
  updatePathForLocaleMock: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
  getLocale: () => 'it',
  setLocale: setLocaleMock,
  onLocaleChange: () => () => {},
  LOCALE_LABELS: {
    it: { flag: '🇮🇹', nativeName: 'Italiano' },
    en: { flag: '🇬🇧', nativeName: 'English' },
    de: { flag: '🇩🇪', nativeName: 'Deutsch' },
    fr: { flag: '🇫🇷', nativeName: 'Français' },
  },
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

vi.mock('@/services/router', () => ({
  ensureJobSlugMapForPath: ensureJobSlugMapForPathMock,
  updatePathForLocale: updatePathForLocaleMock,
}));

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackSettingsChange: trackSettingsChangeMock,
  },
}));

describe('LanguageSelector job-detail locale switch', () => {
  beforeEach(() => {
    setLocaleMock.mockClear();
    trackSettingsChangeMock.mockClear();
    ensureJobSlugMapForPathMock.mockClear();
    updatePathForLocaleMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  // #3526: the selector now ensures only the CURRENT URL's job-slug shard
  // (ensureJobSlugMapForPath) instead of the 1.5 MB br monolith.
  it('loads the current URL job-slug shard before rewriting the route for the new locale', async () => {
    render(<LanguageSelector />);

    fireEvent.click(screen.getByRole('button', { name: /Lingua/ }));
    fireEvent.click(screen.getByRole('option', { name: /English/ }));

    await waitFor(() => {
      expect(ensureJobSlugMapForPathMock).toHaveBeenCalledTimes(1);
      expect(setLocaleMock).toHaveBeenCalledWith('en');
      expect(updatePathForLocaleMock).toHaveBeenCalledWith('en');
    });
  });
});
