import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ApplicationConciergeProposal, ApplicationConciergeService } from '../services/applicationConciergeService';
import translations from '../services/locales/it-core';

vi.mock('@/services/i18n', () => ({
  getLocale: () => 'it', useLocale: () => ['it'],
  useTranslation: () => ({ t: (key: string) => translations[key] || key }),
}));
vi.mock('@/services/authService', () => ({ signInWithCustomAuthToken: vi.fn() }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/services/assistedApplicationCheckout', () => ({ ensureAssistedApplicationAuth: vi.fn() }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: vi.fn() }));
vi.mock('@/services/analyticsProxy', () => ({ Analytics: { trackApplicationConciergeView: vi.fn() } }));
vi.mock('@/components/community/SumUpPaymentWidget', () => ({ default: () => null }));
vi.mock('@/components/community/ResidenceLocationInput', () => ({ default: () => null }));
vi.mock('@/components/community/AssistedApplicationLegalLinks', () => ({ AssistedApplicationLegalLinks: () => null }));

import ApplicationConciergePortal from '../components/community/ApplicationConciergePortal';

afterEach(cleanup);

const proposal: ApplicationConciergeProposal = {
  proposalId: 'proposal-test', jobId: 'job-test', jobUrl: 'https://example.test/job/',
  companyId: 'company-test', companyName: 'Azienda test', jobTitle: 'Posizione test',
  status: 'accepted', childApplicationId: 'child-test',
};
const service: ApplicationConciergeService = {
  serviceId: 'service-test', serviceStatus: 'active', paymentStatus: 'paid', renewal: false,
  acceptedPositionsCount: 1, remainingPositions: 9, maxPositions: 10,
  hasCv: true, hasConsent: true, proposals: [],
};

describe('candidate proposal status with the shared progress helper', () => {
  it.each([
    [{ status: 'declined', withdrawnAt: new Date().toISOString(), childApplicationState: 'withdrawn' }, 'Ritirata'],
    [{ status: 'declined' }, 'Rifiutata'],
  ] satisfies Array<[Partial<ApplicationConciergeProposal>, string]>)('distinguishes the persisted decision %s', (overrides, label) => {
    const snapshot = { ...service, acceptedPositionsCount: 0, remainingPositions: 10, proposals: [{ ...proposal, ...overrides }] };
    render(<ApplicationConciergePortal serviceId={snapshot.serviceId} previewService={snapshot} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText(label)).toBeInTheDocument();
    expect(card.queryByRole('button', { name: translations['jobBoard.concierge.accept'] })).not.toBeInTheDocument();
    expect(card.queryByRole('link', { name: translations['jobBoard.concierge.openChild'] })).not.toBeInTheDocument();
    expect(screen.getByText('0/10')).toBeInTheDocument();
  });

  it('keeps the existing child link for an accepted queued application without another accept action', () => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, childApplicationState: 'submitting' }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText('In coda d’invio')).toBeInTheDocument();
    expect(card.getByRole('link', { name: translations['jobBoard.concierge.openChild'] })).toHaveAttribute('href', expect.stringContaining('application_concierge_application_id=child-test'));
    expect(card.queryByRole('button', { name: translations['jobBoard.concierge.accept'] })).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });

  it.each([
    [{ childSendState: 'sent' }, 'Inviata'],
    [{ childEmployerResponse: { category: 'interview_invite', receivedAt: Date.now(), needsReply: true } }, 'Invito a colloquio'],
  ] satisfies Array<[Partial<ApplicationConciergeProposal>, string]>)('keeps confirmed submission or employer replies visible despite a conflicting withdrawal %s', (evidence, label) => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, status: 'declined', withdrawnAt: new Date().toISOString(), childApplicationState: 'withdrawn', ...evidence }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText(label)).toBeInTheDocument();
    expect(card.queryByText('Ritirata')).not.toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    expect(card.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });
});
