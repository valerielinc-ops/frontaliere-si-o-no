/**
 * E3 — ConsultingCTA (calculator results view) tests.
 *
 * Coverage (6 tests):
 *   1. renders with IT copy when locale='it'
 *   2. renders with EN copy when locale='en'
 *   3. IntersectionObserver fires funnel view event exactly once per session
 *   4. click emits trackCtaClick with canonical cta_id + utm params + target_url
 *   5. hidden when the ENABLE_CALCULATOR_CONSULTING_CTA feature flag is false
 *   6. source wiring — ResultsView imports the component and the RC flag has a
 *      default value in services/firebase.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Analytics } from '@/services/analytics';
import { ConsultingCTA } from '@/components/calculator/ConsultingCTA';
import { setLocale, itReady, ensureLocaleLoaded } from '@/services/i18n';

// ─── IntersectionObserver mock ─────────────────────────────────────────────
// JSDOM ships no IntersectionObserver implementation. Tests control entry
// timing by grabbing the latest instance's callback and driving it manually.
type IOCallback = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;

class MockIO {
 static instances: MockIO[] = [];
 callback: IOCallback;
 elements = new Set<Element>();
 disconnected = false;
 constructor(cb: IOCallback) {
  this.callback = cb;
  MockIO.instances.push(this);
 }
 observe(el: Element) { this.elements.add(el); }
 unobserve(el: Element) { this.elements.delete(el); }
 disconnect() { this.disconnected = true; this.elements.clear(); }
 trigger(isIntersecting: boolean) {
  const entries = Array.from(this.elements).map(el => ({ isIntersecting, target: el }));
  this.callback(entries);
 }
}

beforeEach(() => {
 MockIO.instances = [];
 (globalThis as unknown as { IntersectionObserver: typeof MockIO }).IntersectionObserver = MockIO;
 // Reset the Analytics mock counters — Analytics is a global Proxy in tests/setup.tsx
 // so trackCtaClick / trackFunnelStep are stable vi.fn() references across files.
 vi.clearAllMocks();
 // Clear session dedup so each test starts fresh.
 try { sessionStorage.removeItem('consulting_cta_viewed'); } catch { /* ignore */ }
 cleanup();
});

async function loadLocale(locale: 'it' | 'en') {
 // Force-load the calculator chunk so t() returns translated strings. The IT
 // chunk is eagerly merged by the `itReady` promise; EN uses the async
 // ensureLocaleLoaded() entry point that the SPA itself uses.
 await itReady;
 if (locale !== 'it') {
  await ensureLocaleLoaded(locale);
 }
 setLocale(locale);
}

describe('ConsultingCTA — locales', () => {
 it('renders with IT copy when locale=it', async () => {
  await loadLocale('it');
  render(<ConsultingCTA enabledOverride />);
  expect(screen.getByText('Situazione complessa?')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Prenota consulenza/i })).toBeInTheDocument();
  expect(screen.getByText(/30 min di consulenza personalizzata/i)).toBeInTheDocument();
 });

 it('renders with EN copy when locale=en', async () => {
  await loadLocale('en');
  render(<ConsultingCTA enabledOverride />);
  expect(screen.getByText('Complex situation?')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Book consultation/i })).toBeInTheDocument();
  expect(screen.getByText(/30 min of personalized consulting/i)).toBeInTheDocument();
 });
});

describe('ConsultingCTA — analytics', () => {
 it('fires trackFunnelStep("consulting_cta_view", {funnel: "consulting"}) exactly once when the card enters the viewport', async () => {
  await loadLocale('it');
  render(<ConsultingCTA enabledOverride />);

  // An IntersectionObserver must have been created and attached to the card.
  expect(MockIO.instances.length).toBeGreaterThan(0);
  const io = MockIO.instances[MockIO.instances.length - 1];
  io.trigger(true);
  // Second intersection must be ignored (dedup within the component).
  io.trigger(true);

  await waitFor(() => {
   expect(Analytics.trackFunnelStep).toHaveBeenCalledTimes(1);
  });
  expect(Analytics.trackFunnelStep).toHaveBeenCalledWith(
   'consulting_cta_view',
   { funnel: 'consulting' },
  );
 });

 it('click fires trackCtaClick with canonical cta_id + utm params + target_url', async () => {
  await loadLocale('it');
  render(<ConsultingCTA enabledOverride />);

  const link = screen.getByRole('link', { name: /Prenota consulenza/i });
  fireEvent.click(link);

  expect(Analytics.trackCtaClick).toHaveBeenCalledTimes(1);
  expect(Analytics.trackCtaClick).toHaveBeenCalledWith(
   'calculator_consulting_cta',
   expect.objectContaining({
    targetUrl:
     '/consulenza?utm_source=calculator_result&utm_medium=inline_cta&utm_campaign=post_simulation',
    utm_source: 'calculator_result',
    utm_medium: 'inline_cta',
    utm_campaign: 'post_simulation',
   }),
  );
 });
});

describe('ConsultingCTA — feature flag gate', () => {
 it('renders nothing when the flag is explicitly disabled', async () => {
  await loadLocale('it');
  const { container } = render(<ConsultingCTA enabledOverride={false} />);
  expect(container.querySelector('[data-testid="consulting-cta"]')).toBeNull();
 });
});

describe('ConsultingCTA — source wiring', () => {
 it('ResultsView lazy-imports ConsultingCTA and renders it on the results view', () => {
  const path = resolve(__dirname, '..', '..', 'components/calculator/ResultsView.tsx');
  const source = readFileSync(path, 'utf8');
  // The lazy import must be present so the CTA ships in the calculator chunk.
  expect(source).toMatch(/import\(['"]\.\/ConsultingCTA['"]\)/);
  // …and it must be rendered somewhere in the tree.
  expect(source).toMatch(/<ConsultingCTA\b/);
 });

 it('services/firebase.ts declares ENABLE_CALCULATOR_CONSULTING_CTA with default true', () => {
  const path = resolve(__dirname, '..', '..', 'services/firebase.ts');
  const source = readFileSync(path, 'utf8');
  expect(source).toMatch(/ENABLE_CALCULATOR_CONSULTING_CTA:\s*['"]true['"]/);
 });
});
