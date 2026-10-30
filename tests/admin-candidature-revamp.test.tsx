import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  user: { uid: 'owner', getIdToken: async () => 'owner-token' }, services: vi.fn(), orders: vi.fn(), queue: vi.fn(), fetchService: vi.fn(), checkout: vi.fn(), ensureAuth: vi.fn(), analytics: vi.fn(),
}));
vi.mock('@/services/authService', () => ({ useAuth: () => ({ user: mocks.user, loading: false }), signInWithCustomAuthToken: vi.fn() }));
vi.mock('@/components/admin/lib/AdminNavigationContext', () => ({ useAdminNavigation: () => ({ locationKey: 'test' }) }));
vi.mock('@/components/admin/lib/adminNavigation', () => ({ replaceAdminQuery: (updates: Record<string, string | null>) => {
  const url = new URL(window.location.href);
  Object.entries(updates).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  window.history.replaceState(null, '', url.pathname + url.search);
} }));
vi.mock('@/components/admin/ui/AdminConfirmDialog', () => ({ useAdminConfirm: () => ({ requestConfirmation: vi.fn() }) }));
vi.mock('@/services/assistedApplicationExperiment', () => ({ normalizeAssistedApplicationLayoutVariant: () => null, trackAssistedApplicationEvent: vi.fn() }));
vi.mock('@/services/i18n', () => ({ useLocale: () => ['it'], useTranslation: () => ({ t: (key: string) => key }), getLocale: () => 'it' }));
vi.mock('@/services/analyticsProxy', () => ({ Analytics: { trackApplicationConciergeView: mocks.analytics } }));
vi.mock('@/services/profileFirestore', () => ({ loadEnrichmentProfileFields: vi.fn() }));
vi.mock('@/services/assistedApplicationCheckout', () => ({ ensureAssistedApplicationAuth: mocks.ensureAuth }));
vi.mock('@/services/applicationConciergeCheckout', () => ({ createApplicationConciergeCheckout: mocks.checkout }));
vi.mock('@/services/applicationConciergeService', () => ({
  fetchApplicationConciergeAdminData: mocks.services, createApplicationConciergeProposal: vi.fn(),
  fetchApplicationConciergeService: mocks.fetchService, recoverApplicationConciergePaymentSession: vi.fn(),
  openApplicationConciergeChildReview: vi.fn(), acceptApplicationConciergeProposal: vi.fn(), declineApplicationConciergeProposal: vi.fn(),
  recordApplicationConciergeConsent: vi.fn(), saveApplicationConciergeProfile: vi.fn(), getCandidateVisibleApplicationConciergeProposals: (rows: any[]) => rows.filter(row => row.status !== 'retracted'),
}));
vi.mock('@/services/assistedApplicationAdminService', () => ({
  fetchApplicationConciergeAssistedOrders: mocks.orders, fetchAssistedApplicationAdminData: mocks.queue,
  ASSISTED_APPLICATION_ADMIN_STATUSES: ['awaiting_upload', 'ready_for_manual_submission', 'in_progress', 'submitted', 'blocked', 'refunded'],
  fetchAssistedApplicationCandidateView: vi.fn(), updateAssistedApplicationStatus: vi.fn(), refundAssistedApplication: vi.fn(),
  runAutomationAdminAction: vi.fn(), uploadAssistedApplicationCv: vi.fn(),
}));
vi.mock('@/services/applicationConciergeNavigation', () => ({ conciergeServiceHref: () => '/candidate-test/', conciergeProposalJobHref: vi.fn() }));

import ApplicationConciergeAdmin from '@/components/pages/ApplicationConciergeAdmin';
import AssistedApplicationAdmin from '@/components/pages/AssistedApplicationAdmin';

const service = (serviceId: string, userId: string, serviceStatus = 'active') => ({
  serviceId, userId, applicantName: userId, customerEmail: `${userId}@example.test`, applicantEmail: `${userId}@example.test`,
  serviceStatus, paymentStatus: serviceStatus === 'awaiting_payment' ? 'pending' : 'paid', checkoutSessionStatus: 'open',
  hasCv: true, hasConsent: true, maxPositions: 10, acceptedPositionsCount: 0, remainingPositions: 10, proposals: [], renewal: false,
});
const order = (parentServiceId: string | null, jobTitle: string) => ({
  parentServiceId, orderId: jobTitle, jobTitle, companyName: 'Azienda test', submissionStatus: 'submitted', paymentStatus: 'paid', hasCv: true,
  candidateEmails: [{ key: 'customer_submitted', status: 'sent', sentAt: '2026-10-29T10:00:00Z', delivered: 1, opens: 2, clicks: 1, bounces: 0, complaints: 0 }],
  automation: { flow: null, draft: null, candidateAlias: 'c-test@candidature.example.test', inbox: [{ receivedAt: 1793270000000, from: 'hr@example.test', subject: 'Invito al colloquio', category: 'interview_invite', summaryIt: 'Il datore propone un colloquio.', forwarded: 'sent' }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/gestione-contenuti-xk9mp2q/servizio-candidature/');
  mocks.services.mockResolvedValue({ services: [service('s1', 'Alice'), service('s0', 'Alice', 'expired'), service('s2', 'Bob', 'awaiting_payment')] });
  mocks.orders.mockResolvedValue([order('s1', 'Posizione Alice'), order('s2', 'Posizione Bob')]);
  mocks.queue.mockResolvedValue({ orders: [order(null, 'Candidatura singola')], pdfRenderer: null });
});
afterEach(cleanup);

describe('admin candidature revamp', () => {
  it('groups periods per user, filters awaiting payment, and opens only the selected user’s orders and mail', async () => {
    render(<ApplicationConciergeAdmin />);
    const alice = await screen.findByRole('button', { name: /Alice.*Apri utente/ });
    expect(screen.getAllByRole('button', { name: /Alice.*Apri utente/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Stato' }), { target: { value: 'awaiting_payment' } });
    expect(screen.queryByRole('button', { name: /Alice.*Apri utente/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Bob.*Apri utente/ }));
    expect(await screen.findByText('Posizione Bob')).toBeInTheDocument();
    expect(screen.queryByText('Posizione Alice')).not.toBeInTheDocument();
    expect(screen.getByText('Conferma invio')).toBeInTheDocument();
    const inbox = screen.getByRole('region', { name: 'Inbox della candidatura' });
    expect(within(inbox).getByText('Invito al colloquio')).toBeInTheDocument();
    expect(within(inbox).getByText('Da: hr@example.test')).toBeInTheDocument();
    expect(screen.queryByText('Nuova posizione proposta')).not.toBeInTheDocument();
    expect(alice).not.toBeInTheDocument();
  });

  it('restores the refunded filter from the URL and opens the refunded user in Italian', async () => {
    mocks.services.mockResolvedValue({ services: [service('s1', 'Alice'), { ...service('s3', 'Carla', 'refunded'), paymentStatus: 'refunded' }] });
    window.history.replaceState(null, '', '/gestione-contenuti-xk9mp2q/servizio-candidature/?stato=refunded');
    render(<ApplicationConciergeAdmin />);
    const carla = await screen.findByRole('button', { name: /Carla.*Apri utente/ });
    expect(screen.getByRole('combobox', { name: 'Stato' })).toHaveValue('refunded');
    expect(screen.getByRole('option', { name: 'Rimborsato (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Alice.*Apri utente/ })).not.toBeInTheDocument();
    fireEvent.click(carla);
    expect(await screen.findByRole('heading', { name: 'Carla' })).toBeInTheDocument();
    expect(screen.getAllByText('Rimborsato')).toHaveLength(2);
    expect(screen.queryByText('refunded')).not.toBeInTheDocument();
    expect(screen.queryByText('Proponi una posizione manualmente')).not.toBeInTheDocument();
  });

  it('restores search and payment filter when returning from a user after a shell remount', async () => {
    const view = render(<ApplicationConciergeAdmin key="list" />);
    await screen.findByRole('button', { name: /Bob.*Apri utente/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Stato' }), { target: { value: 'awaiting_payment' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Cerca utente' }), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /Bob.*Apri utente/ }));
    view.rerender(<ApplicationConciergeAdmin key="detail" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tutti gli utenti' }));
    view.rerender(<ApplicationConciergeAdmin key="back" />);
    await screen.findByRole('button', { name: /Bob.*Apri utente/ });
    expect(screen.getByRole('combobox', { name: 'Stato' })).toHaveValue('awaiting_payment');
    expect(screen.getByRole('searchbox', { name: 'Cerca utente' })).toHaveValue('Bob');
    expect(screen.queryByRole('button', { name: /Alice.*Apri utente/ })).not.toBeInTheDocument();
  });

  it('shows the real candidate portal in preview without fetching a candidate session or restarting payment', async () => {
    // Resolve the real lazy module before exercising preview behavior; the
    // assertion is about read-only preview, not CI module-transform latency.
    await import('@/components/community/ApplicationConciergePortal');
    render(<ApplicationConciergeAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /Bob.*Apri utente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vedi come candidato' }));
    expect(await screen.findByText('jobBoard.concierge.portalTitle')).toBeInTheDocument();
    expect(mocks.fetchService).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.ensureAuth).not.toHaveBeenCalled();
    expect(mocks.analytics).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /jobBoard.concierge.resumePayment/ })).toBeDisabled();
  });

  it('keeps a selected action after the admin shell remounts on a query change', async () => {
    const view = render(<AssistedApplicationAdmin key="before" />);
    await screen.findByText('Candidatura singola');
    fireEvent.change(screen.getByRole('combobox', { name: 'Mostra candidature' }), { target: { value: 'status:submitted' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mostra candidature' }), { target: { value: 'step:done' } });
    expect(new URLSearchParams(window.location.search).get('azione')).toBe('done');
    expect(new URLSearchParams(window.location.search).has('stato')).toBe(false);
    view.rerender(<AssistedApplicationAdmin key="after" />);
    await screen.findByText('Candidatura singola');
    expect(screen.getByRole('combobox', { name: 'Mostra candidature' })).toHaveValue('step:done');
  });

  it('offers one queue filter and keeps inbox visible while automation details start collapsed', async () => {
    render(<AssistedApplicationAdmin />);
    await screen.findByText('Candidatura singola');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Inbox della candidatura' })).toBeVisible();
    const summary = screen.getByText('Azioni e dettagli dell’automazione');
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });
});
