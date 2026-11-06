import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upsertNewsletterSubscriber: vi.fn(),
  markNewsletterSubscribedLocally: vi.fn(),
  unlockAchievement: vi.fn(),
  googleSignIn: vi.fn(),
  linkedInSignIn: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({ name: 'test-db' })),
}));

vi.mock('@/services/newsletterSubscribers', () => ({
  upsertNewsletterSubscriber: mocks.upsertNewsletterSubscriber,
  markNewsletterSubscribedLocally: mocks.markNewsletterSubscribedLocally,
}));

vi.mock('@/services/gamificationService', () => ({
  unlockAchievement: mocks.unlockAchievement,
}));

vi.mock('@/hooks/useCaptureImpression', () => ({
  useCaptureImpression: () => null,
}));

vi.mock('@/hooks/useLinkedInSignInAvailable', () => ({
  useLinkedInSignInAvailable: () => false,
  linkedInPendingClass: () => '',
}));

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    locale: 'it',
    t: (key: string) => key,
  }),
  getCantonI18nParams: () => ({ canton: 'TI' }),
}));

vi.mock('@/services/authService', () => ({
  useAuth: () => ({ user: null, signIn: mocks.googleSignIn }),
  getAuthEmail: () => null,
  renderGoogleButtonWithReadiness: vi.fn(async () => false),
  signInWithLinkedIn: mocks.linkedInSignIn,
}));

vi.mock('@/components/shared/EmailInput', () => ({
  validateEmailStrict: (email: string) => ({ valid: email.includes('@') }),
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <input
      aria-label="digest-email"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('@/components/shared/EmailConsentCheckbox', () => ({
  default: () => <div data-testid="email-consent" />,
}));

import WeeklyDigest from '@/components/community/WeeklyDigest';
import { isNewsletterSubscribedLocally } from '@/services/newsletterCtaState';

const originalStorage = window.localStorage;

function throwingStorage(): Storage {
  const throwStorageError = () => {
    throw new DOMException('storage blocked', 'SecurityError');
  };
  return {
    getItem: throwStorageError,
    setItem: throwStorageError,
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  } as unknown as Storage;
}

function useStorage(storage: Storage): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  useStorage(originalStorage);
  originalStorage.clear();
  mocks.upsertNewsletterSubscriber.mockReset();
  mocks.markNewsletterSubscribedLocally.mockReset();
  mocks.unlockAchievement.mockReset();
  mocks.upsertNewsletterSubscriber.mockResolvedValue({
    status: 'subscribed',
    hadConfirmationProof: true,
  });
});

afterEach(() => {
  cleanup();
  useStorage(originalStorage);
  originalStorage.clear();
});

describe('WeeklyDigest browser storage fallback', () => {
  it('renders when the subscription marker cannot be read', () => {
    useStorage(throwingStorage());

    expect(() => render(<WeeklyDigest />)).not.toThrow();
    expect(screen.getByRole('heading', { name: 'weeklyDigest.title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'weeklyDigest.subscribeBtn' })).toBeTruthy();
  });

  it('keeps a successful subscription successful when the marker cannot be written', async () => {
    useStorage(throwingStorage());
    render(<WeeklyDigest />);

    fireEvent.change(screen.getByRole('textbox', { name: 'digest-email' }), {
      target: { value: 'digest@example.org' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'weeklyDigest.subscribeBtn' }));
    });

    await waitFor(() => {
      expect(screen.getByText('weeklyDigest.subscribed')).toBeTruthy();
    });
    expect(screen.queryByText('newsletter.subscribeError')).toBeNull();
    expect(mocks.upsertNewsletterSubscriber).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared newsletter reader fail-closed when storage cannot be read', () => {
    useStorage(throwingStorage());

    expect(isNewsletterSubscribedLocally()).toBe(false);
  });
});
