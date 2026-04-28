import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the service module BEFORE importing the component.
vi.mock('@/services/newsletterSubscribers', () => ({
 getFullSubscriptionStatus: vi.fn(),
 toggleNewsletterSubscription: vi.fn(),
 toggleAutologin: vi.fn(),
 deleteJobAlert: vi.fn(),
}));

// Force a known locale so STRINGS lookup is deterministic.
let currentLocale: 'it' | 'en' | 'de' | 'fr' = 'en';
vi.mock('@/services/i18n', async () => {
 const actual = await vi.importActual<any>('@/services/i18n');
 return {
 ...actual,
 getLocale: () => currentLocale,
 };
});

import SubscriptionPreferencesController from '../components/preferences/SubscriptionPreferencesController';
import * as subs from '@/services/newsletterSubscribers';

const okStatus = (overrides: any = {}) => ({
 success: true,
 email: 'user@example.com',
 newsletter: { subscribed: true, autologinEnabled: true, ...(overrides.newsletter || {}) },
 alerts: overrides.alerts ?? [],
});

const sampleAlert = (overrides: any = {}) => ({
 id: 'alert1',
 keywords: ['Software Engineer'],
 locations: ['Lugano'],
 sectors: [],
 frequency: 'weekly',
 active: true,
 createdAt: 1714300000000,
 ...overrides,
});

describe('SubscriptionPreferencesController — token mode', () => {
 beforeEach(() => {
 currentLocale = 'en';
 vi.clearAllMocks();
 });

 afterEach(() => cleanup());

 it('renders a loading state initially', () => {
 (subs.getFullSubscriptionStatus as any).mockReturnValue(new Promise(() => {})); // never resolves
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 />,
 );
 // Loader2 has aria-hidden; we look for the loading wrapper which uses 'animate-spin'
 expect(document.querySelector('.animate-spin')).not.toBeNull();
 });

 it('shows "no alerts" empty-state when alerts is empty', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(okStatus({ alerts: [] }));
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 />,
 );
 await waitFor(() => {
 expect(screen.getByText(/You have no active job alerts\./)).toBeTruthy();
 });
 });

 it('calls toggleNewsletterSubscription when newsletter toggle is clicked', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(okStatus({ alerts: [] }));
 (subs.toggleNewsletterSubscription as any).mockResolvedValue({ success: true, subscribed: false });
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 />,
 );
 await waitFor(() =>
 expect(screen.getByText(/Newsletter subscription/)).toBeTruthy(),
 );
 // The newsletter toggle is the first toggle button (aria-label = newsletterTitle)
 const toggle = screen.getByRole('button', { name: /Newsletter subscription/ });
 fireEvent.click(toggle);
 await waitFor(() => {
 expect(subs.toggleNewsletterSubscription).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 false,
 );
 });
 });

 it('calls deleteJobAlert when alert delete is confirmed', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert()] }),
 );
 (subs.deleteJobAlert as any).mockResolvedValue({ success: true, alertId: 'alert1' });
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());
 // First click reveals the confirmation prompt; the trash button has aria-label "Delete"
 const triggerBtn = screen.getByRole('button', { name: /^Delete$/ });
 fireEvent.click(triggerBtn);
 // After confirming, the visible "Delete" word changes to a confirm text + a Delete button.
 await waitFor(() => expect(screen.getByText(/Delete this alert\?/)).toBeTruthy());
 // There may be two "Delete" buttons (the now-disabled trigger + the confirm). Pick the
 // one inside the confirmation cluster — the last one in the DOM order.
 const allDeleteBtns = screen.getAllByText(/^Delete$/);
 fireEvent.click(allDeleteBtns[allDeleteBtns.length - 1]);
 await waitFor(() => {
 expect(subs.deleteJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 );
 });
 });

 it('shows error UI when getFullSubscriptionStatus fails', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue({
 success: false,
 error: 'invalid_token',
 });
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 />,
 );
 await waitFor(() => {
 expect(screen.getByRole('alert')).toBeTruthy();
 });
 });

 it.each(['it', 'en', 'de', 'fr'] as const)(
 'renders locale-correct empty alert label for %s',
 async (locale) => {
 currentLocale = locale;
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(okStatus({ alerts: [] }));
 render(
 <SubscriptionPreferencesController
 mode="token"
 email="user@example.com"
 token="abc123"
 locale={locale}
 />,
 );
 const matchers: Record<typeof locale, RegExp> = {
 it: /Non hai alert lavoro attivi\./,
 en: /You have no active job alerts\./,
 de: /Du hast keine aktiven Job-Alerts\./,
 fr: /Tu n\u2019as aucune alerte emploi active\./,
 };
 await waitFor(() => {
 expect(screen.getByText(matchers[locale])).toBeTruthy();
 });
 cleanup();
 },
 );
});

describe('SubscriptionPreferencesController — auth-mode source check', () => {
 // Auth mode reads/writes Firestore directly; mocking the firebase SDK comprehensively
 // is brittle, so we rely on a source-grep to guarantee both code paths exist.
 const sourcePath = path.resolve(
 __dirname,
 '../components/preferences/SubscriptionPreferencesController.tsx',
 );
 const src = fs.readFileSync(sourcePath, 'utf8');

 it('source contains token-mode entry-points', () => {
 expect(src).toMatch(/getFullSubscriptionStatus\(/);
 expect(src).toMatch(/toggleNewsletterSubscription\(/);
 expect(src).toMatch(/deleteJobAlert\(/);
 });

 it('source contains auth-mode Firestore helpers', () => {
 expect(src).toMatch(/authLoadFullStatus/);
 expect(src).toMatch(/authToggleNewsletter/);
 expect(src).toMatch(/authToggleAutologin/);
 expect(src).toMatch(/authDeleteAlert/);
 expect(src).toMatch(/import\(['"]firebase\/firestore['"]\)/);
 expect(src).toMatch(/deleteDoc\(/);
 });
});
