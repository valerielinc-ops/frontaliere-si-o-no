import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import JobAlertStickyBanner from '@/components/community/JobAlertStickyBanner';

const { trackJobAlertCtaClick } = vi.hoisted(() => ({
 trackJobAlertCtaClick: vi.fn(),
}));

vi.mock('@/hooks/useJobAlertEligibility', () => ({
 useJobAlertEligibility: () => true,
}));

vi.mock('@/services/analytics', () => ({
 Analytics: {
 trackJobAlertCtaClick,
 trackJobAlertCtaShown: vi.fn(),
 },
}));

vi.mock('@/services/i18n', () => ({
 useTranslation: () => ({
 t: (key: string) => ({
 'jobAlert.stickyBannerText': 'Ti avvisiamo quando escono offerte come queste.',
 'jobAlert.stickyBannerCta': 'Crea alert gratis',
 'jobAlert.stickyBannerAria': 'Invito a iscriversi alle alert lavoro',
 'common.close': 'Chiudi',
 }[key] ?? key),
 }),
}));

vi.mock('@/components/shared/BottomPromptShell', () => ({
 default: ({ children }: { children: ReactNode }) => (
 <div data-testid="bottom-prompt-shell">{children}</div>
 ),
}));

describe('JobAlertStickyBanner', () => {
 beforeEach(() => {
 localStorage.clear();
 trackJobAlertCtaClick.mockClear();
 Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
 Object.defineProperty(window, 'scrollY', { configurable: true, value: 100 });
 Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1000 });
 vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
 callback(0);
 return 1;
 });
 });

 afterEach(() => {
 cleanup();
 vi.restoreAllMocks();
 });

 it('puts the primary CTA on its own full-width touch row on mobile', () => {
 render(<JobAlertStickyBanner />);

 const cta = screen.getByRole('button', { name: 'Crea alert gratis' });
 const close = screen.getByRole('button', { name: 'Chiudi' });

 expect(cta.className).toContain('w-full');
 expect(cta.className).toContain('min-h-[48px]');
 expect(close.className).toContain('absolute');
 expect(close.className).toContain('min-w-[44px]');
 expect(cta.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });

 it('keeps the alert action as the conversion event, not the close control', () => {
 const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
 render(<JobAlertStickyBanner />);

 fireEvent.click(screen.getByRole('button', { name: 'Crea alert gratis' }));

 expect(trackJobAlertCtaClick).toHaveBeenCalledWith('sticky_banner', 'open');
 expect(dispatchSpy.mock.calls.some(([event]) => event.type === 'openJobAlert')).toBe(true);
 });
});
