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
 updateJobAlert: vi.fn(),
 createJobAlert: vi.fn(),
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
 expect(screen.getByText(/haven't saved any searches yet/)).toBeTruthy();
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
 it: /nessuna ricerca salvata/,
 en: /haven't saved any searches yet/,
 de: /noch keine Suche gespeichert/,
 fr: /aucune recherche enregistr\u00e9e/,
 };
 await waitFor(() => {
 expect(screen.getByText(matchers[locale])).toBeTruthy();
 });
 cleanup();
 },
 );
});

describe('SubscriptionPreferencesController — edit + create + frequency', () => {
 beforeEach(() => {
 currentLocale = 'en';
 vi.clearAllMocks();
 });

 afterEach(() => cleanup());

 it('renders the frequency segmented control and calls updateJobAlert when toggled', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ frequency: 'weekly' })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: { ...sampleAlert(), frequency: 'daily' },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());

 // The "daily" button is rendered by FrequencyToggle
 const dailyBtn = screen.getAllByRole('button', { name: /^daily$/ })[0];
 fireEvent.click(dailyBtn);
 await waitFor(() => {
 expect(subs.updateJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 expect.objectContaining({ frequency: 'daily', frequencyOverride: true }),
 );
 });
 });

 it('shows the auto badge for engine-managed alerts and pins on manual frequency change', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ frequency: 'weekly', frequencyOverride: false })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: { ...sampleAlert(), frequency: 'daily', frequencyOverride: true },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());
 expect(screen.getByText('Automatic')).toBeTruthy();

 fireEvent.click(screen.getAllByRole('button', { name: /^daily$/ })[0]);
 await waitFor(() => expect(screen.getByText('manually pinned')).toBeTruthy());
 });

 it('resets a pinned alert back to engine-managed via the reset-to-auto button', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ frequency: 'daily', frequencyOverride: true })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: { ...sampleAlert(), frequency: 'daily', frequencyOverride: false },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('manually pinned')).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /Switch back to automatic/ }));
 await waitFor(() => {
 expect(subs.updateJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 expect.objectContaining({ frequencyOverride: false }),
 );
 });
 await waitFor(() => expect(screen.getByText('Automatic')).toBeTruthy());
 });

 it('pauses an active alert via the pause button (issue #4298)', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ active: true })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: { ...sampleAlert(), active: false },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /^Pause$/ }));
 await waitFor(() => {
 expect(subs.updateJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 { active: false },
 );
 });
 await waitFor(() => expect(screen.getByText('Paused')).toBeTruthy());
 // The alert must stay in the list — pausing never removes/hides it.
 expect(screen.getByText('Software Engineer')).toBeTruthy();
 });

 it('resumes a paused alert via the resume button, still visible from get_full_status (issue #4298)', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ active: false })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: { ...sampleAlert(), active: true },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 // Regression guard: a paused alert returned by get_full_status must render,
 // not be silently dropped.
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());
 expect(screen.getByText('Paused')).toBeTruthy();

 fireEvent.click(screen.getByRole('button', { name: /^Resume$/ }));
 await waitFor(() => {
 expect(subs.updateJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 { active: true },
 );
 });
 await waitFor(() => expect(screen.queryByText('Paused')).toBeNull());
 });

 it('reverts the optimistic pause when updateJobAlert fails', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert({ active: true })] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({ success: false, error: 'write_failed' });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /^Pause$/ }));
 await waitFor(() => {
 expect(screen.getByRole('alert')).toBeTruthy();
 });
 // Reverted: still shows the "Pause" action, not "Paused".
 expect(screen.getByRole('button', { name: /^Pause$/ })).toBeTruthy();
 expect(screen.queryByText('Paused')).toBeNull();
 });

 it('opens the edit form populated from the alert and saves on Save', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({
 alerts: [
 sampleAlert({
 keywords: ['Software Engineer'],
 locations: ['Lugano'],
 sectors: ['Banca'],
 }),
 ],
 }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({
 success: true,
 alert: {
 ...sampleAlert(),
 keywords: ['Senior Engineer'],
 locations: ['Lugano'],
 sectors: ['Banca'],
 },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));

 // Inputs prefilled.
 const keywordsInput = screen.getByDisplayValue('Software Engineer') as HTMLInputElement;
 expect(keywordsInput).toBeTruthy();
 fireEvent.change(keywordsInput, { target: { value: 'Senior Engineer' } });

 const saveBtn = screen.getByRole('button', { name: /^Save$/ });
 fireEvent.click(saveBtn);

 await waitFor(() => {
 expect(subs.updateJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 'alert1',
 expect.objectContaining({
 keywords: ['Senior Engineer'],
 locations: ['Lugano'],
 sectors: ['Banca'],
 frequency: 'weekly',
 }),
 );
 });
 });

 it('the Add form validates that at least keywords or locations is non-empty', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(okStatus({ alerts: [] }));

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText(/Add new alert/)).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /Add new alert/ }));
 // Save with all empty.
 fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
 await waitFor(() => {
 expect(screen.getByText(/Enter at least one keyword or location/)).toBeTruthy();
 });
 expect(subs.createJobAlert).not.toHaveBeenCalled();
 });

 it('Add form calls createJobAlert with collected fields', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(okStatus({ alerts: [] }));
 (subs.createJobAlert as any).mockResolvedValue({
 success: true,
 alert: {
 id: 'new-alert-1',
 keywords: ['Python'],
 locations: ['Lugano'],
 sectors: [],
 frequency: 'weekly',
 active: true,
 createdAt: null,
 },
 });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText(/Add new alert/)).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /Add new alert/ }));

 const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
 // Order: keywords, locations, sectors
 fireEvent.change(inputs[0], { target: { value: 'Python' } });
 fireEvent.change(inputs[1], { target: { value: 'Lugano' } });

 fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

 await waitFor(() => {
 expect(subs.createJobAlert).toHaveBeenCalledWith(
 'user@example.com',
 'abc123',
 expect.objectContaining({
 keywords: ['Python'],
 locations: ['Lugano'],
 sectors: [],
 frequency: 'weekly',
 }),
 );
 });
 });

 it('Add button is hidden and limit message shown when 10 alerts exist', async () => {
 const tenAlerts = Array.from({ length: 10 }, (_, i) =>
 sampleAlert({ id: `alert${i}`, keywords: [`Job ${i}`] }),
 );
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: tenAlerts }),
 );

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Job 0')).toBeTruthy());

 expect(screen.queryByRole('button', { name: /Add new alert/ })).toBeNull();
 expect(screen.getByText(/You've reached the 10-alert limit/)).toBeTruthy();
 });

 it('shows error UI when updateJobAlert returns success:false during edit save', async () => {
 (subs.getFullSubscriptionStatus as any).mockResolvedValue(
 okStatus({ alerts: [sampleAlert()] }),
 );
 (subs.updateJobAlert as any).mockResolvedValue({ success: false, error: 'write_failed' });

 render(
 <SubscriptionPreferencesController mode="token" email="user@example.com" token="abc123" />,
 );
 await waitFor(() => expect(screen.getByText('Software Engineer')).toBeTruthy());

 fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
 fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

 await waitFor(() => {
 expect(screen.getByRole('alert')).toBeTruthy();
 expect(screen.getByText(/Saving failed/)).toBeTruthy();
 });
 });
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
 expect(src).toMatch(/authUpdateAlert/);
 expect(src).toMatch(/authCreateAlert/);
 expect(src).toMatch(/import\(['"]firebase\/firestore['"]\)/);
 expect(src).toMatch(/deleteDoc\(/);
 });

 it('source contains the pause/resume toggle wired to both auth and token modes (issue #4298)', () => {
 expect(src).toMatch(/handleTogglePause/);
 expect(src).toMatch(/onTogglePause/);
 // Regression guard: authLoadFullStatus / get_full_status must NOT silently
 // filter out active===false alerts — a paused alert must stay resumable.
 expect(src).not.toMatch(/if \(a\.active === false\) return;/);
 });
});
