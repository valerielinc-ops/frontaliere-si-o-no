/**
 * Offer status is gated behind the auth-gate.
 *
 * Goal: a user who is NOT logged in (auth-gate level) must not see that an offer
 * is "no longer active" (JobExpiredView) or "no longer available / archived"
 * (JobOrphanView). That status is revealed only once the user signs in. The
 * auth gate itself stays fully visible to drive sign-up.
 *
 * Logged-in coverage lives in job-expired-view-logged-in.test.tsx; this file
 * locks the logged-out (gated) behavior for both sibling views.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import JobExpiredView from '@/components/community/JobExpiredView';
import JobOrphanView from '@/components/community/JobOrphanView';
import type { ExpiredJob } from '@/hooks/useExpiredJob';

// Avoid pulling the Google Identity Services script / network in jsdom, while
// keeping the rest of authService (e.g. useAuth, used by JobAlertSection) real.
vi.mock(import('@/services/authService'), async (importOriginal) => ({
 ...(await importOriginal()),
 renderGoogleButton: vi.fn().mockResolvedValue(undefined),
 isLinkedInSignInAvailable: vi.fn().mockResolvedValue(false),
 signInWithLinkedIn: vi.fn().mockResolvedValue(undefined),
 saveAuthJobContext: vi.fn(),
}));

const expiredJob: ExpiredJob = {
 slug: 'demo-expired-job',
 title: 'Software Engineer Frontaliere',
 titleByLocale: { it: 'Software Engineer Frontaliere' },
 company: 'Acme SA',
 companyKey: 'acme-sa',
 location: 'Lugano',
 addressLocality: 'Lugano',
 descriptionByLocale: {
  it: '<p>Ruolo ibrido a Lugano con mansioni di sviluppo frontend.</p>',
 },
 sector: 'IT & Software',
 expiredAt: '2025-11-15T00:00:00.000Z',
};

const markdownHeadingJob: ExpiredJob = {
 ...expiredJob,
 slug: 'demo-markdown-heading-job',
 descriptionByLocale: {
  it: "## addetti/e pulizie presso l'Amministrazione comunale\n<p>Mansioni di pulizia locali comunali.</p>",
 },
};

describe('Offer status gated behind auth (logged-out)', () => {
 afterEach(() => {
  cleanup();
  localStorage.clear();
 });

 it('JobExpiredView hides "no longer active" banner and expiry until sign-in', () => {
  render(<JobExpiredView job={expiredJob} />);

  // Status reveal must be deferred for logged-out visitors.
  expect(screen.queryByText(/non è più attiva/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Scaduta il/i)).not.toBeInTheDocument();

  // The auth gate is still presented to drive sign-up.
  expect(screen.getByRole('region', { name: /come candidarti/i })).toBeInTheDocument();

  // The job title still renders (information scent), just not the dead-status.
  expect(
   screen.getByRole('heading', { level: 1, name: /Software Engineer Frontaliere/i }),
  ).toBeInTheDocument();
 });

 it('JobExpiredView gate teaser strips a leading markdown ATX heading (`## `) instead of printing it literally', () => {
  render(<JobExpiredView job={markdownHeadingJob} />);

  expect(screen.getByText(/addetti\/e pulizie presso l'Amministrazione comunale/i)).toBeInTheDocument();
  expect(screen.queryByText(/##\s*addetti/i)).not.toBeInTheDocument();
 });

 it('JobOrphanView hides "no longer available" banner until sign-in', () => {
  render(<JobOrphanView slug="software-engineer-acme-sa-lugano" />);

  // Status reveal must be deferred for logged-out visitors.
  expect(screen.queryByText(/non è più disponibile/i)).not.toBeInTheDocument();

  // The auth gate is still presented.
  expect(screen.getByRole('region', { name: /come candidarti/i })).toBeInTheDocument();
 });
});
