/**
 * JobExpiredView — logged-in branch integration test.
 *
 * Verifies the richer 2-column layout for authenticated users landing on an
 * expired job URL: hero card with title/company/expired-at, banner, full
 * description HTML, and at least one sidebar callout. Also exercises a
 * minimal job payload to confirm missing data degrades gracefully.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import JobExpiredView from '@/components/community/JobExpiredView';
import type { ExpiredJob } from '@/hooks/useExpiredJob';

const fullJob: ExpiredJob = {
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
 salaryMin: 80000,
 salaryMax: 95000,
 currency: 'CHF',
 salarySource: 'reported',
 contract: 'full-time',
 postingDateSource: 'reported',
 datePosted: new Date(Date.now() - 2 * 86400000).toISOString(),
};

const minimalJob: ExpiredJob = {
 slug: 'minimal-expired-job',
 title: 'Generic role',
 company: 'Some Co',
};

describe('JobExpiredView (logged-in)', () => {
 afterEach(() => {
  cleanup();
 });

 it('renders full 2-column layout with hero, banner, description and sidebar', () => {
  render(<JobExpiredView job={fullJob} hasAccess />);

  // Expired banner
  expect(screen.getByText(/non è più attiva/i)).toBeInTheDocument();

  // Hero content
  expect(
   screen.getByRole('heading', { level: 1, name: /Software Engineer Frontaliere/i }),
  ).toBeInTheDocument();
  expect(screen.getAllByText(/Acme SA/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Scaduta il/i).length).toBeGreaterThan(0);

  // Description HTML
  expect(screen.getByText(/Ruolo ibrido a Lugano/i)).toBeInTheDocument();

  // At least one sidebar callout visible (snapshot)
  expect(screen.getByText(/Snapshot annuncio/i)).toBeInTheDocument();

  // Advice callout with expired CTA variant
  expect(screen.getByText(/Consiglio candidatura/i)).toBeInTheDocument();
  expect(
   screen.getByRole('button', { name: /Vedi offerte simili attive/i }),
  ).toBeInTheDocument();
 });

 it('renders safely with minimal job data (no crash, banner still visible)', () => {
  render(<JobExpiredView job={minimalJob} hasAccess />);

  // Banner still renders
  expect(screen.getByText(/non è più attiva/i)).toBeInTheDocument();

  // Title still renders
  expect(
   screen.getByRole('heading', { level: 1, name: /Generic role/i }),
  ).toBeInTheDocument();

  // Snapshot callout should be absent (no location, no expiredAt, no crossings)
  expect(screen.queryByText(/Snapshot annuncio/i)).not.toBeInTheDocument();

  // No "Scaduta il" line since no expiredAt
  expect(screen.queryByText(/Scaduta il/i)).not.toBeInTheDocument();
 });

 it('renders available salary, contract, and posting metadata in the standard detail header', () => {
  render(<JobExpiredView job={fullJob} hasAccess />);

  expect(screen.getByText('CHF 80k – 95k')).toBeInTheDocument();
  expect(screen.getAllByText('Tempo pieno').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2 giorni fa/i).length).toBeGreaterThan(0);
 });

 it('places related jobs in the standard full-width three-column section', () => {
  const relatedJobs = Array.from({ length: 4 }, (_, index) => ({
   slug: `related-job-${index}`,
   title: `Related role ${index}`,
   company: 'Acme SA',
   location: 'Lugano',
  }));
  const { container } = render(<JobExpiredView job={fullJob} hasAccess relatedJobs={relatedJobs} />);

  const layout = container.querySelector('[data-expired-layout="authenticated"]');
  const relatedGrid = layout?.querySelector('[data-job-related-grid]');
  expect(relatedGrid).toHaveClass('grid-cols-1', 'md:grid-cols-2', 'lg:grid-cols-3');
  expect(relatedGrid?.querySelectorAll('article')).toHaveLength(4);
  expect(relatedGrid?.closest('article')).toBeNull();
  expect(relatedGrid?.querySelectorAll('[data-job-related-ad]')).toHaveLength(1);
 });
});
