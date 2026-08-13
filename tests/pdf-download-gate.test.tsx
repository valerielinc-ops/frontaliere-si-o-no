import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CONSENT_TEXTS } from '@/services/consentTexts';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import PdfDownloadGate from '@/components/shared/PdfDownloadGate';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';

const authMock = vi.hoisted(() => {
  let currentUser: any = null;
  const listeners = new Set<(u: any) => void>();
  return {
    getUser: () => currentUser,
    setUser: (u: any) => { currentUser = u; listeners.forEach((l) => l(u)); },
    subscribe: (fn: (u: any) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
});

vi.mock('@/services/authService', () => ({
  useAuth: () => {
    const [user, setUser] = React.useState(authMock.getUser());
    React.useEffect(() => authMock.subscribe(setUser), []);
    return { user, signIn: vi.fn(), signInFacebook: vi.fn(), signInEmail: vi.fn(), logout: vi.fn() };
  },
  renderGoogleButtonWithReadiness: vi.fn().mockResolvedValue(undefined),
  isLinkedInSignInAvailable: vi.fn().mockResolvedValue(false),
  signInWithLinkedIn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/firebase', () => ({
  getApp: vi.fn().mockResolvedValue({}),
  getFirestoreLazy: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));

const upsertNewsletterSubscriberMock = vi.fn().mockResolvedValue({ existed: false, id: 'sub-1', status: 'pending' });
const markNewsletterSubscribedLocallyMock = vi.fn();
vi.mock('@/services/newsletterSubscribers', () => ({
  upsertNewsletterSubscriber: (...args: unknown[]) => upsertNewsletterSubscriberMock(...args),
  markNewsletterSubscribedLocally: () => markNewsletterSubscribedLocallyMock(),
}));

function renderGatedAnchor(source = 'self_cert_health_ch', label = 'Questionario svizzero — stato di salute') {
  document.body.innerHTML = '';
  render(<PdfDownloadGate />);
  const anchor = document.createElement('a');
  anchor.href = '/moduli/questionario-salute-svizzero.pdf';
  anchor.download = '';
  anchor.setAttribute('data-pdf-gate', '');
  anchor.setAttribute('data-pdf-gate-source', source);
  anchor.setAttribute('data-pdf-gate-label', label);
  anchor.textContent = 'Scarica';
  document.body.appendChild(anchor);
  return anchor;
}

describe('PdfDownloadGate', () => {
  beforeEach(() => {
    localStorage.clear();
    authMock.setUser(null);
    upsertNewsletterSubscriberMock.mockClear();
    markNewsletterSubscribedLocallyMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('bypasses the gate when already subscribed (localStorage flag)', () => {
    localStorage.setItem(NEWSLETTER_SUBSCRIBED_KEY, 'true');
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('bypasses the gate when a firebase auth session key exists', () => {
    localStorage.setItem('firebase:authUser:abc123', '{}');
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the registration modal with the anchor label on first click', () => {
    const anchor = renderGatedAnchor('self_cert_criminal_record_ch', 'Autocertificazione svizzera — casellario giudiziario');
    fireEvent.click(anchor);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Autocertificazione svizzera — casellario giudiziario/)).toBeInTheDocument();
  });

  it('closes the modal on cancel without granting access', () => {
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(markNewsletterSubscribedLocallyMock).not.toHaveBeenCalled();
  });

  it('rejects submit without a checked consent box', async () => {
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    fireEvent.change(screen.getByLabelText('Email per scaricare il PDF'), { target: { value: 'candidato@aziendaticino.ch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrati e scarica' }));
    expect(await screen.findByText('Spunta il consenso per continuare.')).toBeInTheDocument();
    expect(upsertNewsletterSubscriberMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid email', async () => {
    // A bare-format typo (e.g. missing "@") never reaches JS validation at
    // all: the <input type="email" required> triggers native HTML5
    // constraint validation, which blocks the submit event before
    // handleSubmit ever runs (true in real browsers and in jsdom). Use a
    // syntactically valid but disposable-domain address instead, which
    // passes native validation and is rejected by validateEmailStrict.
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    fireEvent.change(screen.getByLabelText('Email per scaricare il PDF'), { target: { value: 'test@mailinator.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrati e scarica' }));
    expect(await screen.findByText('Inserisci un indirizzo email valido.')).toBeInTheDocument();
    expect(upsertNewsletterSubscriberMock).not.toHaveBeenCalled();
  });

  it('subscribes with the lead_magnet source and grants the download on success', async () => {
    vi.useFakeTimers();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const anchor = renderGatedAnchor('self_cert_health_ch', 'Questionario svizzero — stato di salute');
    fireEvent.click(anchor);
    fireEvent.change(screen.getByLabelText('Email per scaricare il PDF'), { target: { value: 'candidato@aziendaticino.ch' } });
    // The checkbox label is now the register formula itself, rendered by
    // ConsentNotice — the string this gate also STORES (#5712). Matching on it
    // is therefore matching on the consent proof, not on decorative copy.
    fireEvent.click(screen.getByLabelText(/Iscrivo il mio indirizzo alle comunicazioni/));
    fireEvent.click(screen.getByRole('button', { name: 'Registrati e scarica' }));

    await vi.waitFor(() => expect(upsertNewsletterSubscriberMock).toHaveBeenCalledTimes(1));
    const [, input] = upsertNewsletterSubscriberMock.mock.calls[0];
    expect(input.email).toBe('candidato@aziendaticino.ch');
    expect(input.source).toBe('lead_magnet_self_cert_health_ch');
    expect(input.sourceChannel).toBe('lead_magnet');
    expect(input.consentGiven).toBe(true);
    // …and what was ticked is what is kept: same string, same locale.
    expect(input.consentText).toBe(CONSENT_TEXTS.communicationsOptIn.text);
    expect(input.consentTextDisplayed).toBe(true);
    expect(input.consentAct).toBe('typed_email_submit');

    await vi.advanceTimersByTimeAsync(1000);
    expect(markNewsletterSubscribedLocallyMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('grants access immediately when social sign-in completes while pending', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const anchor = renderGatedAnchor();
    fireEvent.click(anchor);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    act(() => { authMock.setUser({ uid: 'u1' }); });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(markNewsletterSubscribedLocallyMock).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
