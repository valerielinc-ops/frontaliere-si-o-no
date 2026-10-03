import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewsletterPopup from '@/components/community/NewsletterPopup';

const mocks = vi.hoisted(() => ({
  user: null as null | { email: string | null; providerData?: Array<{ email: string }> },
  eager: vi.fn(), imports: vi.fn(), release: vi.fn(),
}));
vi.mock('@/services/authService', () => ({
  useAuth: () => ({ user: mocks.user, signIn: vi.fn(), signInFacebook: vi.fn() }),
  getAuthEmail: (user: typeof mocks.user) => user?.email || user?.providerData?.[0]?.email || '',
  eagerAuth: mocks.eager, promptOneTap: vi.fn(), cancelOneTap: vi.fn(),
  renderGoogleButtonWithReadiness: async () => false,
  isLinkedInSignInAvailable: async () => false, signInWithLinkedIn: vi.fn(),
}));
vi.mock('@/services/resilientImport', () => ({ resilientImport: mocks.imports }));
vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ locale: 'it', t: (key: string) => key }) }));
vi.mock('@/services/NavigationContext', () => ({ useNavigationOptional: () => null }));
vi.mock('@/services/analytics', () => ({ Analytics: { trackUIInteraction: vi.fn() } }));
vi.mock('@/services/gamificationService', () => ({ unlockAchievement: vi.fn() }));
vi.mock('@/services/modalAdOcclusion', () => ({ observeGoogleAdOverlays: () => () => {} }));
vi.mock('@/services/popupQueue', () => ({
  requestSlot: vi.fn(), releaseSlot: mocks.release, isActive: () => true,
  subscribe: () => () => {}, POPUP_PRIORITY: { NEWSLETTER: 1 },
  canShowPromotionalPrompt: () => true, markSlotShown: vi.fn(),
}));
vi.mock('@/services/newsletterSubscribers', () => ({
  getNewsletterPendingEmail: () => null, upsertNewsletterSubscriber: vi.fn(), markNewsletterSubscribedLocally: vi.fn(),
}));
vi.mock('@/components/shared/EmailInput', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <input aria-label="email" value={value} onChange={(event) => onChange(event.target.value)} />,
  validateEmailStrict: () => true,
}));
vi.mock('@/components/shared/EmailConsentCheckbox', () => ({ default: () => null }));
vi.mock('@/components/shared/TelegramChannelCta', () => ({ default: () => null }));

const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
const originalScrollHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.user = null;
  localStorage.clear(); sessionStorage.clear();
  sessionStorage.setItem('newsletter_pageviews', '2');
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup(); vi.clearAllTimers(); vi.useRealTimers();
  if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
  else Reflect.deleteProperty(window, 'scrollY');
  if (originalScrollHeight) Object.defineProperty(document.documentElement, 'scrollHeight', originalScrollHeight);
  else Reflect.deleteProperty(document.documentElement, 'scrollHeight');
});
const settle = async () => { await act(async () => { await Promise.resolve(); }); };
const show = async () => { await act(async () => { vi.advanceTimersByTime(20_000); }); };

describe('newsletter uses shared auth restoration', () => {
  it('does not directly import Firebase or eagerly request auth for an invisible anonymous popup', async () => {
    render(<NewsletterPopup />);
    await settle();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.imports).not.toHaveBeenCalled();
    expect(mocks.eager).not.toHaveBeenCalled();
    await show();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(mocks.eager).toHaveBeenCalledOnce();
    expect(mocks.imports).not.toHaveBeenCalled();
  });

  it.each([
    { email: 'restored@example.com' },
    { email: null, providerData: [{ email: 'provider@example.com' }] },
  ])('prefills from a restored shared user and suppresses the authenticated popup: %j', async (user) => {
    const { rerender } = render(<NewsletterPopup />);
    await settle();
    mocks.user = user;
    rerender(<NewsletterPopup />);
    await settle();
    await show();
    expect(screen.queryByRole('textbox')).toBeNull();
    // Signing out lets the existing timer/scroll gate show the preserved prefill.
    mocks.user = null;
    rerender(<NewsletterPopup />);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1600 });
    act(() => window.dispatchEvent(new Event('scroll')));
    await settle();
    expect(screen.getByRole('textbox')).toHaveValue(user.email || user.providerData?.[0].email);
    expect(mocks.imports).not.toHaveBeenCalled();
  });

  it('dismisses a visible popup when shared auth reports a successful login', async () => {
    const { rerender } = render(<NewsletterPopup />);
    await settle(); await show();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    mocks.user = { email: 'signed-in@example.com' };
    rerender(<NewsletterPopup />);
    await settle();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mocks.release).toHaveBeenCalledWith('newsletter-popup');
  });
});
