import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CompanyFollowPopup } from '@/components/community/CompanyFollowCta';

const cap = vi.hoisted(() => ({ shown: false, dismissed: false }));
vi.mock('@/services/popupQueue', () => ({ POPUP_PRIORITY: { COMPANY_FOLLOW_PROMPT: 50 }, canShowPromotionalPrompt: () => true, markPromotionalPromptShown: vi.fn() }));
vi.mock('@/services/jobAlertPromptPolicy', () => ({
 canShowJobAlertPrompt: () => !cap.shown && !cap.dismissed,
 markJobAlertPromptShown: () => { cap.shown = true; },
 dismissJobAlertPrompt: () => { cap.dismissed = true; },
}));
vi.mock('@/components/shared/BottomPromptShell', () => ({ default: ({ children, onShown }: any) => { React.useEffect(() => { onShown?.(); }, []); return <aside>{children}</aside>; } }));

beforeEach(() => { vi.useFakeTimers(); cap.shown = false; cap.dismissed = false; localStorage.clear(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function readPage() {
 await act(async () => { vi.advanceTimersByTime(20_000); });
 Object.defineProperty(window, 'scrollY', { configurable: true, value: 200 });
 fireEvent.scroll(window);
}

describe('company follow returns after reading', () => {
 it('waits for reading, opens the canonical follow control, and does not prompt again on another employer', async () => {
  const clicked = vi.fn();
  const { rerender } = render(<><div data-company-follow-inline="demo-company"><button aria-pressed="false" onClick={clicked}>Canonical follow</button></div><CompanyFollowPopup company="Demo company" companyKey="demo-company" locale="it" surface="company_follow_gate" userId={null} email={null} authLoading={false} /></>);
  expect(screen.queryByRole('complementary')).toBeNull();
  await readPage();
  expect(screen.getByRole('complementary')).toBeTruthy();
  const accept = screen.getByRole('complementary').querySelector('button:not([aria-label])')!;
  fireEvent.click(accept);
  expect(clicked).toHaveBeenCalledOnce();
  rerender(<CompanyFollowPopup company="Other company" companyKey="other-company" locale="it" surface="company_follow_gate" userId={null} email={null} authLoading={false} />);
  await act(async () => { vi.advanceTimersByTime(20_000); });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 400 });
  fireEvent.scroll(window);
  expect(screen.queryByRole('complementary')).toBeNull();
 });

 it('does not show a promotional error popup when eligibility lookup fails', async () => {
  render(<CompanyFollowPopup company="Demo company" companyKey="demo-company" locale="it" surface="company_follow_gate" userId="test-user" email="test@example.com" authLoading={false} lookupAlert={vi.fn().mockRejectedValue(new Error('offline'))} />);
  await readPage();
  expect(screen.queryByRole('complementary')).toBeNull();
 });
});
