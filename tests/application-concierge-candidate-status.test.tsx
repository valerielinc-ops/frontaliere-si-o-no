import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it('switches between distinct proposal categories and keeps every status available', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const proposals: ApplicationConciergeProposal[] = [
      { ...proposal, proposalId: 'proposal-offered', jobTitle: 'Offerta da valutare', status: 'proposed', childApplicationId: null },
      { ...proposal, proposalId: 'proposal-needs-info', jobTitle: 'Informazioni richieste', childApplicationState: 'needs_candidate_action' },
      { ...proposal, proposalId: 'proposal-accepted', jobTitle: 'Proposta accettata', childApplicationState: 'accepted' },
      { ...proposal, proposalId: 'proposal-queued', jobTitle: 'Candidatura in coda', childApplicationState: 'submitting' },
      { ...proposal, proposalId: 'proposal-submitted', jobTitle: 'Candidatura inviata', childSendState: 'sent' },
      { ...proposal, proposalId: 'proposal-failed', jobTitle: 'Candidatura fallita', childApplicationState: 'failed' },
      { ...proposal, proposalId: 'proposal-unknown', jobTitle: 'Esito incerto', childApplicationId: 'child-unknown', childApplicationState: undefined },
      { ...proposal, proposalId: 'proposal-declined', jobTitle: 'Proposta rifiutata', status: 'declined', childApplicationId: null },
      { ...proposal, proposalId: 'proposal-retracted', jobTitle: 'Proposta ritirata', status: 'retracted', childApplicationId: null },
    ];
    const snapshot = { ...service, proposals };
    render(<ApplicationConciergePortal serviceId={snapshot.serviceId} previewService={snapshot} locationSearch="" />);

    const categories = screen.getByRole('group', { name: translations['jobBoard.concierge.proposalsTitle'] });
    const expectedStatuses = ['proposed', 'needs_information', 'accepted', 'queued', 'submitted', 'failed', 'unknown', 'declined', 'retracted'] as const;
    expect(within(categories).getAllByRole('button')).toHaveLength(expectedStatuses.length);
    for (const status of expectedStatuses) {
      const label = translations[`jobBoard.concierge.proposalStatus.${status}`];
      expect(within(categories).getByRole('button', { name: new RegExp(label) })).toHaveTextContent('1');
    }

    const offered = within(categories).getByRole('button', { name: new RegExp(translations['jobBoard.concierge.proposalStatus.proposed']) });
    expect(offered).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: translations['jobBoard.concierge.proposalStatus.proposed'] })).toHaveTextContent('Offerta da valutare');

    const queued = within(categories).getByRole('button', { name: new RegExp(translations['jobBoard.concierge.proposalStatus.queued']) });
    fireEvent.click(queued);
    expect(queued).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: translations['jobBoard.concierge.proposalStatus.queued'] })).toHaveTextContent('Candidatura in coda');
    expect(screen.queryByRole('heading', { name: 'Offerta da valutare' })).not.toBeInTheDocument();
  });

  it('keeps the existing child link for an accepted queued application without another accept action', () => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, childApplicationState: 'submitting' }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText('In coda d’invio')).toBeInTheDocument();
    expect(card.getByRole('link', { name: translations['jobBoard.concierge.openChild'] })).toHaveAttribute('href', expect.stringContaining('application_concierge_application_id=child-test'));
    expect(card.queryByRole('button', { name: translations['jobBoard.concierge.accept'] })).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });

  it('keeps a legacy accepted withdrawn child readable without claiming preparation or changing its slot count', () => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, childApplicationState: 'withdrawn' }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getAllByText('Ritirata')).toHaveLength(2);
    expect(card.queryByText(translations['jobBoard.concierge.childPreparing'])).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: translations['jobBoard.concierge.openChild'] })).toHaveAttribute('href', expect.stringContaining('application_concierge_application_id=child-test'));
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });

  it.each(['candidate_review', 'withdrawn'])('uses confirmed sending for the child panel and link despite the flow state %s', (state) => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, childApplicationState: state, childSendState: 'sent' }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText('Inviata')).toBeInTheDocument();
    expect(card.getByText(translations['jobBoard.concierge.childSubmitted'])).toBeInTheDocument();
    expect(card.queryByText('Ritirata')).not.toBeInTheDocument();
    expect(card.queryByText(translations['jobBoard.concierge.childNeedsReview'])).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: translations['jobBoard.concierge.openChild'] })).toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });

  it.each([
    [{ childSendState: 'sent' }, 'Inviata'],
    [{ childEmployerResponse: { category: 'interview_invite', receivedAt: Date.now(), needsReply: true } }, 'Invito a colloquio'],
  ] satisfies Array<[Partial<ApplicationConciergeProposal>, string]>)('keeps confirmed submission or employer replies visible despite a conflicting withdrawal %s', (evidence, label) => {
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [{ ...proposal, status: 'declined', childApplicationId: null, withdrawnAt: new Date().toISOString(), childApplicationState: 'withdrawn', ...evidence }] }} locationSearch="" />);
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText(label)).toBeInTheDocument();
    expect(card.queryByText('Ritirata')).not.toBeInTheDocument();
    expect(card.queryByRole('button')).not.toBeInTheDocument();
    expect(card.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('1/10')).toBeInTheDocument();
  });
});
