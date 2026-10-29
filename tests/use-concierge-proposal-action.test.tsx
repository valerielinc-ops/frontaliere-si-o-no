import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetchService: vi.fn(), accept: vi.fn(), auth: { currentUser: null as any } }));
vi.mock('@/services/applicationConciergeService', () => ({ fetchApplicationConciergeService: mocks.fetchService, acceptApplicationConciergeProposal: mocks.accept }));
vi.mock('firebase/auth', () => ({ getAuth: () => mocks.auth }));
vi.mock('@/services/firebase', () => ({ getApp: async () => ({}) }));
import { useConciergeProposalAction } from '../hooks/useConciergeProposalAction';
const user = { uid: 'candidate', getIdToken: async () => 'test-token' };
const proposal = { proposalId: 'proposal-1', jobId: 'job-1', status: 'proposed' };
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/cerca-lavoro-zurigo/example/?concierge_service=service-1&concierge_proposal=proposal-1');
  mocks.auth.currentUser = user;
  mocks.fetchService.mockResolvedValue({ proposals: [proposal] });
  mocks.accept.mockResolvedValue({ childApplicationId: 'child-1' });
});
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

describe('proposal actions from JobDetails', () => {
  it('accepts once on rapid clicks and opens the existing owned review instead of a purchase', async () => {
    const navigate = vi.fn();
    const { result } = renderHook(() => useConciergeProposalAction({ user, authLoading: false, locale: 'it', navigate }));
    await waitFor(() => expect(mocks.fetchService).toHaveBeenCalledTimes(1));
    await act(async () => {});
    act(() => { expect(result.current.apply({ id: 'job-1' })).toBe(true); result.current.apply({ id: 'job-1' }); });
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toContain('application_concierge_application_id=child-1');
  });
  it('consumes an invalid context without falling through to a normal application', async () => {
    const { result } = renderHook(() => useConciergeProposalAction({ user, authLoading: false, locale: 'it', navigate: vi.fn() }));
    await act(async () => {});
    act(() => { expect(result.current.apply({ id: 'different-job' })).toBe(true); });
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(result.current.error).toBe('jobBoard.concierge.proposalUnavailable');
  });
  it('does not navigate a previous owner’s result after the authoritative session changes', async () => {
    let finish!: (value: any) => void;
    mocks.accept.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const navigate = vi.fn();
    const { result } = renderHook(() => useConciergeProposalAction({ user, authLoading: false, locale: 'it', navigate }));
    await act(async () => {});
    act(() => { result.current.apply({ id: 'job-1' }); });
    await waitFor(() => expect(mocks.accept).toHaveBeenCalledTimes(1));
    mocks.auth.currentUser = { uid: 'other-candidate' };
    await act(async () => { finish({ childApplicationId: 'child-1' }); });
    expect(navigate).not.toHaveBeenCalled();
  });
});
