import JobBridgeView from '@/components/community/JobBridgeView';
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
  vi.restoreAllMocks();
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

 it('does not expose the tail of a long description before access, then reveals it after access', () => {
  const prefix = 'Stage servizio infermieristico a Bellinzona. '.repeat(25);
  const tail = 'Requisiti riservati: iscrizione alla SUPSI';
  const job = { ...expiredJob, descriptionByLocale: { it: `<p>${prefix}${tail}</p>` } };
  const { rerender } = render(<JobExpiredView job={job} hasAccess={false} />);
  expect(screen.queryByText(new RegExp(tail))).not.toBeInTheDocument();
  rerender(<JobExpiredView job={job} hasAccess={true} />);
  expect(screen.getByText(new RegExp(tail))).toBeInTheDocument();
 });

 it.each(['Googlebot', 'Google-InspectionTool/1.0', 'GoogleOther', 'bingbot', 'SemrushBot', 'AhrefsBot'])('shows complete semantic expired content without a gate to %s', (userAgent) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const prefix = 'Descrizione del lavoro in ambito sanitario. '.repeat(20);
  const job = { ...expiredJob, descriptionByLocale: { it: `## Requisiti\n${prefix}\n\n- Laurea SUPSI richiesta` } };
  const { container } = render(<JobExpiredView job={job} hasAccess={false} />);
  expect(container.querySelector('#job-auth-gate')).toBeNull();
  expect(screen.getByText('Laurea SUPSI richiesta')).toBeInTheDocument();
  expect(screen.getByText(/non è più attiva/i)).toBeInTheDocument();
 });

 it('shows the historical body to a crawler without adding a duplicate H1', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Googlebot');
  const seeded = window as unknown as { __STATIC_BODY_HTML__?: string };
  seeded.__STATIC_BODY_HTML__ = '<h1>Original identity</h1><section><h2>Dettagli originali</h2><ul><li>Requisiti storici completi</li></ul></section>';
  try {
   const { container } = render(<JobOrphanView slug="software-engineer-acme-sa-lugano" hasAccess={false} />);
   expect(container.querySelector('#job-auth-gate')).toBeNull();
   expect(container.querySelectorAll('h1')).toHaveLength(1);
   expect(screen.getByText('Requisiti storici completi')).toBeInTheDocument();
   expect(screen.getByText('Requisiti storici completi').closest('details')).toHaveAttribute('open');
  } finally { delete seeded.__STATIC_BODY_HTML__; }
 });

 it('keeps the bridge sign-in block away from SEO crawlers', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('bingbot');
  const { container } = render(<JobBridgeView targetSlug="current-job" jobData={{ title: 'Original vacancy', company: 'Acme SA' }} hasAccess={false} />);
  expect(container.querySelector('#job-auth-gate')).toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: 'Original vacancy' })).toBeInTheDocument();
 });

 it('JobOrphanView hides "no longer available" banner until sign-in', () => {
  render(<JobOrphanView slug="software-engineer-acme-sa-lugano" />);

  // Status reveal must be deferred for logged-out visitors.
  expect(screen.queryByText(/non è più disponibile/i)).not.toBeInTheDocument();

  // The auth gate is still presented.
  expect(screen.getByRole('region', { name: /come candidarti/i })).toBeInTheDocument();
 });
});
