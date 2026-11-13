import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getCandidateVisibleApplicationConciergeProposals, getCandidateVisibleConciergeClarificationTasks, type ApplicationConciergePreProposalCheck, type ApplicationConciergeProposal, type ApplicationConciergeService } from '../services/applicationConciergeService';
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

  it('keeps actionable proposals separate from preliminary qualification checks', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const proposals: ApplicationConciergeProposal[] = [
      { ...proposal, proposalId: 'proposal-offered', jobTitle: 'Offerta da valutare', status: 'proposed', eligibilityStatus: 'compatible', childApplicationId: null },
      { ...proposal, proposalId: 'proposal-clarification', jobTitle: 'Posizione da chiarire', status: 'proposed', eligibilityStatus: 'clarification_required', childApplicationId: null,
        clarificationQuestions: [{ id: 'experience', question: 'Hai esperienza nella gestione di applicazioni?', required: true }] },
      { ...proposal, proposalId: 'proposal-verification', jobTitle: 'Posizione da verificare', status: 'proposed', eligibilityStatus: 'needs_verification', matchScore: 58,
        matchReasons: ['Ruolo compatibile'], childApplicationId: null },
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

    const proposalsHeading = screen.getByRole('heading', { name: translations['jobBoard.concierge.proposalsTitle'] });
    const proposalsPanel = proposalsHeading.closest('section');
    expect(proposalsPanel).not.toBeNull();
    const profileHeading = screen.getByRole('heading', { name: translations['jobBoard.concierge.profileTitle'] });
    expect(proposalsHeading.compareDocumentPosition(profileHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const categories = Array.from(proposalsPanel!.querySelectorAll('details'));
    const expectedStatuses = ['needs_information', 'proposed', 'accepted', 'queued', 'submitted', 'failed', 'unknown', 'declined', 'retracted'] as const;
    expect(categories).toHaveLength(expectedStatuses.length);
    for (const [index, status] of expectedStatuses.entries()) {
      const label = translations[`jobBoard.concierge.proposalStatus.${status}`];
      const summary = categories[index].querySelector('summary');
      expect(summary).toHaveTextContent(label);
      expect(summary).toHaveTextContent('1');
    }

    const needsInformation = categories[0];
    expect(needsInformation).toHaveAttribute('open');
    expect(within(needsInformation).getByRole('heading', { name: 'Informazioni richieste' })).toBeInTheDocument();

    const offered = categories[1];
    expect(offered).not.toHaveAttribute('open');
    fireEvent.click(offered.querySelector('summary')!);
    expect(offered).toHaveAttribute('open');
    expect(within(offered).getByRole('heading', { name: 'Offerta da valutare' })).toBeInTheDocument();
    expect(within(proposalsPanel!).queryByRole('heading', { name: 'Posizione da verificare' })).not.toBeInTheDocument();

    const clarificationTasks = screen.getByRole('heading', { name: translations['jobBoard.concierge.clarificationTasksTitle'] }).closest('section')!;
    expect(within(clarificationTasks).getByRole('heading', { name: 'Posizione da chiarire' })).toBeInTheDocument();
    expect(within(clarificationTasks).getByText(translations['jobBoard.concierge.clarificationTasksIntro'])).toBeInTheDocument();
    expect(within(clarificationTasks).queryByRole('button', { name: translations['jobBoard.concierge.accept'] })).not.toBeInTheDocument();
    expect(within(clarificationTasks).queryByRole('button', { name: translations['jobBoard.concierge.decline'] })).not.toBeInTheDocument();
    expect(getCandidateVisibleApplicationConciergeProposals(proposals).map(item => item.proposalId)).not.toContain('proposal-clarification');
    expect(getCandidateVisibleConciergeClarificationTasks(proposals).map(item => item.proposalId)).toEqual(['proposal-clarification']);
  });

  it('does not show an unverified listing as a proposal or expose its stale match score', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const waiting: ApplicationConciergeProposal = {
      ...proposal, status: 'proposed', childApplicationId: null, eligibilityStatus: 'needs_verification',
      autoAcceptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), matchScore: 58, matchReasons: ['Ruolo compatibile'],
    };
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [waiting] }} locationSearch="" />);

    expect(screen.queryByRole('heading', { name: 'Posizione test' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Indice di affinità/)).not.toBeInTheDocument();
    expect(screen.queryByText('Ruolo compatibile')).not.toBeInTheDocument();
    expect(screen.queryByText(translations['jobBoard.concierge.proposalStatus.needs_verification'])).not.toBeInTheDocument();
    expect(getCandidateVisibleApplicationConciergeProposals([waiting])).toEqual([]);
  });

  it('shows clarification outside proposals and explains that the listing cannot yet be accepted', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const needsClarification: ApplicationConciergeProposal = {
      ...proposal, status: 'proposed', childApplicationId: null, eligibilityStatus: 'clarification_required',
      clarificationQuestions: [
        { id: 'experience', question: 'Hai esperienza nella gestione di applicazioni?', required: true },
        { id: 'enterprise-apps', question: 'Hai lavorato con applicazioni aziendali?', required: true },
        { id: 'it-management', question: 'Hai coordinato applicazioni o servizi IT?', required: true },
      ],
    };
    const check: ApplicationConciergePreProposalCheck = { ...needsClarification, status: 'preproposal_check' };
    render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{ ...service, proposals: [], preProposalChecks: [check] }} locationSearch="" />);

    const taskSection = screen.getByRole('heading', { name: translations['jobBoard.concierge.clarificationTasksTitle'] }).closest('section')!;
    const card = within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
    expect(card.getByText(translations['jobBoard.concierge.proposalStatus.needs_clarification'])).toBeInTheDocument();
    expect(card.getByText(translations['jobBoard.concierge.clarificationTitle'])).toBeInTheDocument();
    expect(card.getByText(translations['jobBoard.concierge.interestOnly'])).toBeInTheDocument();
    expect(card.getAllByRole('textbox')).toHaveLength(3);
    expect(within(taskSection).getByText(translations['jobBoard.concierge.clarificationTasksIntro'])).toBeInTheDocument();
    expect(card.queryByRole('button', { name: translations['jobBoard.concierge.accept'] })).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: translations['jobBoard.concierge.decline'] })).not.toBeInTheDocument();
    expect(getCandidateVisibleApplicationConciergeProposals([check])).toEqual([]);
    expect(getCandidateVisibleConciergeClarificationTasks([check])).toEqual([check]);
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

describe('the platform decision after 12 hours (owner decision 2026-11-11)', () => {
  const undecided: ApplicationConciergeProposal = { ...proposal, status: 'proposed', childApplicationId: null, eligibilityStatus: 'compatible' };
  const cardFor = (snapshot: ApplicationConciergeService) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    render(<ApplicationConciergePortal serviceId={snapshot.serviceId} previewService={snapshot} locationSearch="" />);
    return within(screen.getByRole('heading', { name: 'Posizione test' }).closest('article')!);
  };

  it('tells the candidate when an undecided proposal will be accepted for them', () => {
    const autoAcceptAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const card = cardFor({ ...service, proposals: [{ ...undecided, autoAcceptAt }] });
    expect(card.getByText(translations['jobBoard.concierge.autoAcceptAt'])).toBeInTheDocument();
    expect(card.getByRole('button', { name: translations['jobBoard.concierge.accept'] })).toBeInTheDocument();
  });

  it('says the platform is accepting once the time has passed, and who decided afterwards', () => {
    const due = cardFor({ ...service, proposals: [{ ...undecided, autoAcceptAt: new Date(Date.now() - 60_000).toISOString() }] });
    expect(due.getByText(translations['jobBoard.concierge.autoAcceptDue'])).toBeInTheDocument();
    cleanup();
    const accepted = cardFor({ ...service, proposals: [{ ...proposal, childApplicationState: 'accepted', decidedBy: 'platform_timeout' }] });
    expect(accepted.getByText(translations['jobBoard.concierge.autoAccepted'])).toBeInTheDocument();
  });

  it('hides proposals with pending or missing verification and shows no deadline without consent', () => {
    const autoAcceptAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const missingEligibility: ApplicationConciergeProposal = { ...undecided, autoAcceptAt };
    delete missingEligibility.eligibilityStatus;
    for (const proposalRow of [
      { ...undecided, autoAcceptAt, eligibilityStatus: 'needs_verification' },
      missingEligibility,
    ]) {
      cleanup();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
      render(<ApplicationConciergePortal serviceId={service.serviceId} previewService={{
        ...service, proposals: [proposalRow],
      }} locationSearch="" />);
      expect(screen.queryByRole('heading', { name: 'Posizione test' })).not.toBeInTheDocument();
      expect(screen.queryByText(translations['jobBoard.concierge.autoAcceptAt'])).not.toBeInTheDocument();
    }
    cleanup();
    const noConsent = cardFor({ ...service, hasConsent: false, proposals: [{ ...undecided, autoAcceptAt }] });
    expect(noConsent.queryByText(translations['jobBoard.concierge.autoAcceptAt'])).not.toBeInTheDocument();
  });
});
