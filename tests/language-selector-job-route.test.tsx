import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import LanguageSelector from '@/components/shared/LanguageSelector';

const {
  setLocaleMock,
  trackSettingsChangeMock,
  ensureJobSlugMapLoadedMock,
  updatePathForLocaleMock,
} = vi.hoisted(() => ({
  setLocaleMock: vi.fn(),
  trackSettingsChangeMock: vi.fn(),
  ensureJobSlugMapLoadedMock: vi.fn(async () => {}),
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
}));

vi.mock('@/services/router', () => ({
  ensureJobSlugMapLoaded: ensureJobSlugMapLoadedMock,
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
    ensureJobSlugMapLoadedMock.mockClear();
    updatePathForLocaleMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads the job slug map before rewriting the current route for the new locale', async () => {
    render(<LanguageSelector />);

    fireEvent.click(screen.getByRole('button', { name: /Lingua/ }));
    fireEvent.click(screen.getByRole('option', { name: /English/ }));

    await waitFor(() => {
      expect(ensureJobSlugMapLoadedMock).toHaveBeenCalledTimes(1);
      expect(setLocaleMock).toHaveBeenCalledWith('en');
      expect(updatePathForLocaleMock).toHaveBeenCalledWith('en');
    });
  });
});
