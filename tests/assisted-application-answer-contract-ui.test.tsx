import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const api = vi.hoisted(() => ({ fetchReview: vi.fn(), sendReviewAction: vi.fn(), adminAction: vi.fn() }));
vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ locale: 'it', t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key }) }));
vi.mock('@/services/assistedApplicationReviewService', () => ({
  fetchReview: api.fetchReview, sendReviewAction: api.sendReviewAction,
  ReviewRequestError: class ReviewRequestError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } },
}));
vi.mock('@/services/assistedApplicationAdminService', () => ({ runAutomationAdminAction: api.adminAction, uploadAssistedApplicationCv: vi.fn() }));
vi.mock('@/services/useAssistedApplicationDocumentRechecks', () => ({ useAssistedApplicationDocumentRechecks: vi.fn() }));
vi.mock('@/components/community/AssistedApplicationEmployerResponse', () => ({ AssistedApplicationEmployerResponse: () => null }));
vi.mock('@/components/community/AssistedApplicationLegalLinks', () => ({ AssistedApplicationLegalLinks: () => null }));
vi.mock('@/components/community/AssistedApplicationDocuments', () => ({ AssistedApplicationDocuments: () => null }));
vi.mock('@/components/community/AssistedApplicationFitNotice', () => ({ AssistedApplicationFitNotice: () => null }));
vi.mock('@/components/community/AssistedApplicationCvChanges', () => ({ AssistedApplicationCvChanges: () => null }));
vi.mock('@/components/community/AssistedApplicationKeptDocuments', () => ({ AssistedApplicationKeptDocuments: () => null, WordCopyLink: () => null }));
vi.mock('@/components/community/ResidenceLocationInput', () => ({ default: () => null }));
vi.mock('@/components/admin/ui/AdminConfirmDialog', () => ({ useAdminConfirm: () => ({ requestConfirmation: vi.fn() }) }));
import Review from '@/components/community/AssistedApplicationReview';
import Admin from '@/components/pages/AssistedApplicationAutomationPanel';
import { ReviewRequestError } from '@/services/assistedApplicationReviewService';

const question = { id: 'same-id', question: 'Original privacy question', type: 'text', required: true, options: [], why: '' };
const replacement = { ...question, question: 'Updated permission question' };
const payload = (questions = [question], hash = 'A', canAnswer = true): any => ({
  ok: true, state: 'candidate_review', stale: false, locale: 'it', round: 1, roundsLeft: 2,
  job: { title: 'Test role', company: 'Test employer', channel: 'portal', jobUrl: '', applyUrl: '' },
  questions, answerContracts: questions.length ? { 'same-id': hash } : {}, answers: {}, formAnswers: [], documents: [], ready: false,
  can: { answer: canAnswer, approve: true, edit: false, reject: false },
});
const order = (questions = [question], hash = 'A', orderId = 'order-one'): any => ({
  orderId, jobTitle: 'Test role', companyName: 'Test employer',
  automation: { answerContracts: questions.length ? { 'same-id': hash } : {}, accounts: [],
    flow: { state: 'owner_review', heldBy: [], feedback: [], answers: {}, flags: [], history: [] },
    draft: { status: 'ready', checksIt: [], questions, requirements: [], matches: [], flags: [], coverLetter: null, applicationEmail: null },
  },
});
beforeEach(() => { vi.clearAllMocks(); api.fetchReview.mockResolvedValue(payload()); api.sendReviewAction.mockResolvedValue({ ok: true }); api.adminAction.mockResolvedValue({ ok: true }); });
afterEach(() => cleanup());
const reviewSave = () => screen.getByRole('button', { name: 'jobBoard.assisted.review.saveAnswers' });
const reviewApprove = () => screen.getByRole('button', { name: 'jobBoard.assisted.review.approve' }) as HTMLButtonElement;

describe('answer contract CAS in actual Review and Admin renderers', () => {
  it('requires confirmation after a new mount reads provisional saved answers, without blocking Save', async () => {
    api.fetchReview.mockResolvedValue({ ...payload(), answers: { 'same-id': 'Yes' }, reviewRequired: true });
    render(<Review token="token-remount" />);
    expect((await screen.findByLabelText(/Original privacy question/) as HTMLInputElement).value).toBe('Yes');
    expect((reviewSave() as HTMLButtonElement).disabled).toBe(false);
    expect(reviewApprove().disabled).toBe(true);
    cleanup();
    const provisional = order(); provisional.automation.reviewRequired = true; provisional.automation.flow.answers = { 'same-id': 'Yes' };
    render(<Admin order={provisional} user={null} onChanged={vi.fn()} />);
    expect((screen.getByLabelText(/Original privacy question/) as HTMLInputElement).value).toBe('Yes');
    expect((screen.getByRole('button', { name: /Salva risposte/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('treats a compatibility200 reviewRequired as unconfirmed in both forms', async () => {
    const reply = { ok: true, reviewRequired: true, rawSaved: true, answerConfirmation: { status: 'review_required', authority: false } };
    api.sendReviewAction.mockResolvedValueOnce(reply);
    render(<Review token="token-compat" />);
    fireEvent.change(await screen.findByLabelText(/Original privacy question/), { target: { value: 'Yes' } });
    fireEvent.click(reviewSave());
    expect(await screen.findByRole('button', { name: 'Rileggi le domande aggiornate' })).toBeTruthy();
    expect(reviewApprove().disabled).toBe(true);
    expect((screen.getByLabelText(/Original privacy question/) as HTMLInputElement).value).toBe('Yes');
    cleanup();
    api.adminAction.mockResolvedValueOnce(reply);
    render(<Admin order={order()} user={null} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Original privacy question/), { target: { value: 'Yes' } });
    fireEvent.click(screen.getByRole('button', { name: /Salva risposte/ }));
    expect(await screen.findByRole('button', { name: 'Rileggi le domande aggiornate' })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps an incomplete native contract technical in both forms, without asking for another Yes', async () => {
    const unavailable = { ...question, contractUnavailable: true };
    api.fetchReview.mockResolvedValue(payload([unavailable]));
    render(<Review token="token-unavailable" />);
    expect((await screen.findByLabelText(/Original privacy question/))!.hasAttribute('disabled')).toBe(true);
    expect((reviewSave() as HTMLButtonElement).disabled).toBe(true);
    expect(reviewApprove().disabled).toBe(true);
    cleanup();
    render(<Admin order={order([unavailable])} user={null} onChanged={vi.fn()} />);
    expect(screen.getByLabelText(/Original privacy question/).hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('button', { name: /Salva risposte/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.sendReviewAction).not.toHaveBeenCalled();
    expect(api.adminAction).not.toHaveBeenCalled();
  });
  it('renders own hard assertions and legal links in both confirmation forms', async () => {
    const detailed = { ...question, applicationQuestion: 'Original privacy question', ownConsentText: ['Original privacy question', 'I hold a work permit'], ownConsentLinks: ['https://jobs.example/privacy-policy'] };
    api.fetchReview.mockResolvedValue(payload([detailed]));
    render(<Review token="token-details" />);
    expect(await screen.findByText('I hold a work permit')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Leggi il documento collegato' }).getAttribute('href')).toBe('https://jobs.example/privacy-policy');
    cleanup();
    render(<Admin order={order([detailed])} user={null} onChanged={vi.fn()} />);
    expect(screen.getByText('I hold a work permit')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Leggi il documento collegato' }).getAttribute('href')).toBe('https://jobs.example/privacy-policy');
  });
  it('Review sends the displayed hash, preserves input after409, and requires explicit reread then confirmation', async () => {
    render(<Review token="token-one" />);
    const input = await screen.findByLabelText(/Original privacy question/);
    fireEvent.change(input, { target: { value: 'Yes' } });
    api.sendReviewAction.mockRejectedValueOnce(new ReviewRequestError('answer_contract_changed', {} as any));
    api.fetchReview.mockResolvedValue(payload([replacement], 'B'));
    fireEvent.click(reviewSave());
    await screen.findByRole('button', { name: 'Rileggi le domande aggiornate' });
    expect(api.sendReviewAction).toHaveBeenCalledWith('token-one', 'answers', { answers: { 'same-id': 'Yes' }, answerContracts: { 'same-id': 'A' } });
    expect((screen.getByLabelText(/Original privacy question/) as HTMLInputElement).value).toBe('Yes');
    expect(reviewApprove().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rileggi le domande aggiornate' }));
    expect((screen.getByLabelText(/Updated permission question/) as HTMLInputElement).value).toBe('Yes');
    expect(reviewApprove().disabled).toBe(true);
    expect(api.sendReviewAction).toHaveBeenCalledTimes(1);
    fireEvent.click(reviewSave());
    await waitFor(() => expect(api.sendReviewAction).toHaveBeenLastCalledWith('token-one', 'answers', { answers: { 'same-id': 'Yes' }, answerContracts: { 'same-id': 'B' } }));
  });
  it('Review exposes recovery when all questions disappear and answering becomes unavailable', async () => {
    render(<Review token="token-one" />);
    fireEvent.change(await screen.findByLabelText(/Original privacy question/), { target: { value: 'Yes' } });
    api.sendReviewAction.mockRejectedValueOnce(new ReviewRequestError('answer_contract_required', {} as any));
    api.fetchReview.mockResolvedValue(payload([], '', false));
    fireEvent.click(reviewSave());
    fireEvent.click(await screen.findByRole('button', { name: 'Rileggi le domande aggiornate' }));
    expect(reviewApprove().disabled).toBe(false);
    expect(api.sendReviewAction).toHaveBeenCalledTimes(1);
  });
  it('Review clears a previous confirmation hold on a new token with no questions', async () => {
    const view = render(<Review token="token-one" />);
    fireEvent.change(await screen.findByLabelText(/Original privacy question/), { target: { value: 'Yes' } });
    api.sendReviewAction.mockRejectedValueOnce(new ReviewRequestError('answer_contract_changed', {} as any));
    api.fetchReview.mockResolvedValue(payload([replacement], 'B'));
    fireEvent.click(reviewSave());
    fireEvent.click(await screen.findByRole('button', { name: 'Rileggi le domande aggiornate' }));
    expect(reviewApprove().disabled).toBe(true);
    api.fetchReview.mockResolvedValue(payload([], '', false));
    view.rerender(<Review token="token-two" />);
    await waitFor(() => expect(reviewApprove().disabled).toBe(false));
    expect(api.sendReviewAction).toHaveBeenCalledTimes(1);
  });
  it('Admin polling keeps old input and hash until reread and a new save', async () => {
    const onChanged = vi.fn(), view = render(<Admin order={order()} user={null} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText(/Original privacy question/), { target: { value: 'Yes' } });
    view.rerender(<Admin order={order([replacement], 'B')} user={null} onChanged={onChanged} />);
    expect((screen.getByLabelText(/Original privacy question/) as HTMLInputElement).value).toBe('Yes');
    expect((screen.getByRole('button', { name: /Salva risposte/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.adminAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rileggi le domande aggiornate' }));
    fireEvent.click(screen.getByRole('button', { name: /Salva risposte/ }));
    await waitFor(() => expect(api.adminAction).toHaveBeenCalledWith(null, 'order-one', 'automationSetAnswers', { answers: { 'same-id': 'Yes' }, answerContracts: { 'same-id': 'B' } }));
  });
  it('Admin recovery is reachable for an empty question list and a new order clears confirmation', () => {
    const onChanged = vi.fn(), view = render(<Admin order={order()} user={null} onChanged={onChanged} />);
    view.rerender(<Admin order={order([replacement], 'B')} user={null} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rileggi le domande aggiornate' }));
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<Admin order={order([], '', 'order-two')} user={null} onChanged={onChanged} />);
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Rileggi le domande aggiornate' })).toBeNull();
    view.rerender(<Admin order={order()} user={null} onChanged={onChanged} />);
    view.rerender(<Admin order={order([], '')} user={null} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rileggi le domande aggiornate' }));
    expect(screen.queryByRole('button', { name: /Salva risposte/ })).toBeNull();
    expect((screen.getByRole('button', { name: /Approva ora/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.adminAction).not.toHaveBeenCalled();
  });
});
