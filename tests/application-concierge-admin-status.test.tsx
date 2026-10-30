import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ApplicationConciergeProposal, ApplicationConciergeService } from '../services/applicationConciergeService';
import translations from '../services/locales/it-core';

const mocks = vi.hoisted(() => ({ fetchServices: vi.fn(), fetchOrders: vi.fn(), user: { uid: 'admin-test' } }));
vi.mock('@/services/authService', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (key: string) => translations[key] || key }) }));
vi.mock('@/components/admin/lib/AdminNavigationContext', () => ({ useAdminNavigation: () => ({ locationKey: 'selected-service' }) }));
vi.mock('@/components/admin/lib/adminNavigation', () => ({ replaceAdminQuery: vi.fn() }));
vi.mock('@/services/applicationConciergeService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/applicationConciergeService')>(),
  fetchApplicationConciergeAdminData: mocks.fetchServices,
}));
vi.mock('@/services/assistedApplicationAdminService', () => ({ fetchApplicationConciergeAssistedOrders: mocks.fetchOrders }));
vi.mock('@/components/pages/AssistedApplicationCandidateEmails', () => ({ default: () => null }));
vi.mock('@/components/pages/AssistedApplicationInbox', () => ({ default: () => null }));
vi.mock('@/components/pages/AssistedApplicationAutomationPanel', () => ({ default: () => null }));

import ApplicationConciergeAdmin from '../components/pages/ApplicationConciergeAdmin';

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

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/?servizio=service-test');
  mocks.fetchOrders.mockResolvedValue([]);
});
afterEach(cleanup);

async function renderProposal(overrides: Partial<ApplicationConciergeProposal>) {
  mocks.fetchServices.mockResolvedValue({ services: [{ ...service, proposals: [{ ...proposal, ...overrides }] }] });
  render(<ApplicationConciergeAdmin />);
  return within((await screen.findByText('Posizione test')).closest('li')!);
}

describe('concierge admin proposal decision and application progress', () => {
  it.each([
    [{ childApplicationState: 'submitting' }, 'In coda d’invio'],
    [{ childApplicationState: 'candidate_review', childSendState: 'sent' }, 'Inviata'],
    [{ childApplicationState: 'needs_candidate_action' }, 'Mancano informazioni'],
    [{ childApplicationState: 'withdrawn' }, 'Ritirata'],
  ] satisfies Array<[Partial<ApplicationConciergeProposal>, string]>)('keeps acceptance separate from actual progress %s', async (overrides, label) => {
    const row = await renderProposal(overrides);
    expect(row.getByText('Decisione proposta:')).toBeInTheDocument();
    expect(row.getByText('Accettata')).toBeInTheDocument();
    expect(row.getByText('Candidatura:')).toBeInTheDocument();
    expect(row.getByText(label)).toBeInTheDocument();
  });

  it.each([
    ['auto_acknowledgement', 'Ricezione confermata'],
    ['interview_invite', 'Invito a colloquio'],
    ['rejection', 'Candidatura non selezionata'],
    ['documents_request', 'Documenti richiesti'],
    ['question', 'Domanda dell’azienda'],
    ['assessment', 'Test da completare'],
    ['offer', 'Offerta ricevuta'],
  ] as const)('shows the employer response category %s', async (category, label) => {
    const row = await renderProposal({ childSubmissionStatus: 'submitted', childEmployerResponse: { category, receivedAt: Date.now(), needsReply: true } });
    expect(row.getByText('Accettata')).toBeInTheDocument();
    expect(row.getByText('Risposta azienda:')).toBeInTheDocument();
    expect(row.getByText(label)).toBeInTheDocument();
    expect(row.queryByText('Inviata')).not.toBeInTheDocument();
  });

  it('does not infer application progress for an unaccepted proposal', async () => {
    const row = await renderProposal({ status: 'proposed', childApplicationState: 'submitting' });
    expect(row.getByText('In attesa del candidato')).toBeInTheDocument();
    expect(row.queryByText('Candidatura:')).not.toBeInTheDocument();
  });

  it('distinguishes a withdrawn application from a declined proposal using the persisted decision', async () => {
    const row = await renderProposal({ status: 'declined', withdrawnAt: new Date().toISOString(), childApplicationState: 'withdrawn' });
    expect(row.getByText('Ritirata dal candidato')).toBeInTheDocument();
    expect(row.queryByText('Rifiutata')).not.toBeInTheDocument();
  });

  it('preserves a declined proposal without withdrawal evidence', async () => {
    const row = await renderProposal({ status: 'declined' });
    expect(row.getByText('Rifiutata')).toBeInTheDocument();
    expect(row.queryByText('Ritirata dal candidato')).not.toBeInTheDocument();
  });
});
