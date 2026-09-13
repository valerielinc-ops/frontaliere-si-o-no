import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authUser: null as {
    uid: string;
    email: string;
    providerData: Array<{ providerId: string }>;
  } | null,
  upsertNewsletterSubscriber: vi.fn(),
  requestConfirmationEmail: vi.fn(),
  signStabioDossoPetition: vi.fn(),
  trackPageView: vi.fn(),
  trackUIInteraction: vi.fn(),
}));

const AUTH_USER = {
  uid: 'auth-user-1',
  email: 'worker@example.com',
  providerData: [{ providerId: 'google.com' }],
};

vi.mock('@/services/analyticsProxy', () => ({
  Analytics: {
    trackPageView: (...args: unknown[]) => mocks.trackPageView(...args),
    trackUIInteraction: (...args: unknown[]) => mocks.trackUIInteraction(...args),
  },
}));

vi.mock('@/components/shared/ConsentNotice', () => ({ default: () => <span>consent notice</span> }));
vi.mock('@/components/shared/SocialSignInButtons', () => ({ default: () => null }));
vi.mock('@/components/shared/EmailInput', () => ({
  validateEmailStrict: () => ({ valid: true }),
}));
vi.mock('@/services/authService', () => ({
  useAuth: () => ({
    user: mocks.authUser,
    loading: false,
  }),
  getAuthEmail: (user: { email?: string } | null) => user?.email || '',
  getUserDisplayName: (user: { email?: string } | null) => user?.email || 'Worker',
}));
vi.mock('@/services/newsletterSubscribers', () => ({
  upsertNewsletterSubscriber: (...args: unknown[]) => mocks.upsertNewsletterSubscriber(...args),
  requestConfirmationEmail: (...args: unknown[]) => mocks.requestConfirmationEmail(...args),
}));
vi.mock('@/services/consentTexts', () => ({
  consentProof: () => ({
    consentText: 'Formula di consenso',
    consentTextVersion: '2026-08-20.1',
    consentTextDisplayed: true,
    consentAct: 'authentication',
    consentMethod: 'google_oauth',
    consentUserAgent: null,
  }),
}));
vi.mock('@/services/firebase', () => ({ app: {} }));
vi.mock('firebase/firestore', () => ({ getFirestore: vi.fn(() => ({})) }));
vi.mock('@/services/petition', () => ({
  signStabioDossoPetition: (...args: unknown[]) => mocks.signStabioDossoPetition(...args),
}));
vi.mock('@/services/petitionRoute', () => ({
  buildStabioDossoPetitionPath: () => '/petizione-dosso-stabio/',
}));
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    locale: 'it',
    t: (key: string) => ({
      'petition.hero.title': 'Petizione',
      'petition.form.title': 'Firma la richiesta',
      'petition.form.subtitle': 'Una firma per account.',
      'petition.form.accountNotice': 'Accedi per firmare.',
      'petition.form.checkboxIntro': 'Conferma le comunicazioni:',
      'petition.form.signedAs': 'Accesso effettuato come',
      'petition.form.signCta': 'Invia la mia firma',
      'petition.form.signing': 'Registrazione della firma…',
      'petition.form.emailLabel': 'Email',
      'petition.form.emailHint': 'Riceverai un link.',
      'petition.form.emailCta': 'Invia il link',
      'petition.form.or': 'oppure',
      'petition.form.socialTitle': 'Accedi',
      'petition.form.socialIntro': 'Usa un provider.',
      'petition.form.checkEmailTitle': 'Controlla la tua posta',
      'petition.form.checkEmailBody': 'Apri il link e torna qui per firmare.',
      'petition.form.checkEmailReturn': 'Poi torna qui.',
      'petition.form.backToForm': 'Torna al modulo',
      'petition.form.successTitle': 'Firma registrata',
      'petition.form.successBody': 'La firma è stata registrata.',
      'petition.form.already': 'Avevi già firmato.',
      'petition.form.privacyNote': 'Dati protetti.',
      'petition.form.consentRequired': 'Conferma le comunicazioni.',
      'petition.form.error': 'Errore firma.',
    }[key] || key),
  }),
}));

import { StabioDossoPetitionPage } from '@/components/pages/StabioDossoPetitionPage';

describe('Stabio-Gaggiolo petition signing flow', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.authUser = AUTH_USER;
    mocks.upsertNewsletterSubscriber.mockReset();
    mocks.requestConfirmationEmail.mockReset();
    mocks.signStabioDossoPetition.mockReset();
    mocks.trackPageView.mockReset();
    mocks.trackUIInteraction.mockReset();
  });

  afterEach(() => cleanup());

  it('restarts DOI confirmation for an authenticated address that previously opted out', async () => {
    mocks.upsertNewsletterSubscriber.mockResolvedValue({
      existed: false,
      id: 'worker@example.com',
      status: 'pending',
      optedOut: false,
      hadConfirmationProof: true,
    });

    render(<StabioDossoPetitionPage />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Invia la mia firma' }));

    await waitFor(() => expect(mocks.upsertNewsletterSubscriber).toHaveBeenCalledTimes(1));
    const [, input] = mocks.upsertNewsletterSubscriber.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.reconsent).toBe(true);
    expect(mocks.signStabioDossoPetition).not.toHaveBeenCalled();
    expect(await screen.findByText('Controlla la tua posta')).toBeInTheDocument();
  });

  it('keeps the email DOI path open when a pending re-consent still reports an opt-out', async () => {
    mocks.authUser = null;
    mocks.upsertNewsletterSubscriber.mockResolvedValue({
      existed: true,
      id: 'worker@example.com',
      status: 'pending',
      optedOut: true,
      hadConfirmationProof: true,
    });

    render(<StabioDossoPetitionPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'worker@example.com' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Invia il link' }));

    await waitFor(() => expect(mocks.upsertNewsletterSubscriber).toHaveBeenCalledTimes(1));
    expect(mocks.requestConfirmationEmail).not.toHaveBeenCalled();
    expect(await screen.findByText('Controlla la tua posta')).toBeInTheDocument();
  });

  it('signs directly when the newsletter gate stays confirmed', async () => {
    mocks.upsertNewsletterSubscriber.mockResolvedValue({
      existed: true,
      id: 'worker@example.com',
      status: 'confirmed',
      optedOut: false,
      hadConfirmationProof: true,
    });
    mocks.signStabioDossoPetition.mockResolvedValue({ success: true, signed: true });

    render(<StabioDossoPetitionPage />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Invia la mia firma' }));

    await waitFor(() => expect(mocks.signStabioDossoPetition).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'auth-user-1' }),
      'it',
    ));
    expect(await screen.findByText('Firma registrata')).toBeInTheDocument();
  });
});
