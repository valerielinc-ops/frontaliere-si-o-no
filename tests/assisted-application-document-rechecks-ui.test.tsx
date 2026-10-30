import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAssistedApplicationDocumentRechecks } from '../services/useAssistedApplicationDocumentRechecks';
import { recheckReviewDocument, type ReviewPayload } from '../services/assistedApplicationReviewService';

vi.mock('../services/assistedApplicationReviewService', () => ({ recheckReviewDocument: vi.fn() }));
const CHECK = { verdict: 'match' as const, matched: 'esame di laurea', version: 4 };
const payload = () => ({ round: 1, stale: false, answers: { kept: 'candidate answer' }, documents: [{ id: 'degree', kind: 'diploma', label: 'degree certificates', keywords: ['degree certificates'], files: [{ id: 'degree.pdf', name: 'degree.pdf', size: 42, detectedType: 'pdf', uploadedAt: 1, clientCheck: { verdict: 'mismatch', matched: '' } }] }] }) as unknown as ReviewPayload;
const deferred = () => { let resolve!: (value: typeof CHECK) => void; const promise = new Promise<typeof CHECK>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('automatic rechecks on the candidate review page', () => {
  it('does not abort or restart a read when an ordinary payload refresh changes only answers', async () => {
    const pending = deferred(); vi.mocked(recheckReviewDocument).mockReturnValue(pending.promise);
    const setData = vi.fn(); const first = payload();
    const hook = renderHook(({ data }) => useAssistedApplicationDocumentRechecks('token', data, setData), { initialProps: { data: first } });
    expect(recheckReviewDocument).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(recheckReviewDocument).mock.calls[0][3];
    const refreshed = { ...payload(), answers: { kept: 'new unsaved answer' } };
    hook.rerender({ data: refreshed });
    expect(signal.aborted).toBe(false); expect(recheckReviewDocument).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(CHECK); });
    await waitFor(() => expect(setData).toHaveBeenCalledTimes(1));
    const updated = setData.mock.calls[0][0](refreshed);
    expect(updated.answers).toEqual(refreshed.answers);
    expect(updated.documents[0].files[0].clientCheck).toEqual(CHECK);
  });

  it('resumes an unfinished read after StrictMode cleanup instead of permanently marking it attempted', async () => {
    const first = deferred(); const second = deferred();
    vi.mocked(recheckReviewDocument).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const setData = vi.fn();
    renderHook(() => useAssistedApplicationDocumentRechecks('token', payload(), setData), { wrapper: StrictMode });
    expect(recheckReviewDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recheckReviewDocument).mock.calls[0][3].aborted).toBe(true);
    await act(async () => { first.resolve(CHECK); }); expect(setData).not.toHaveBeenCalled();
    await act(async () => { second.resolve(CHECK); }); await waitFor(() => expect(setData).toHaveBeenCalledTimes(1));
  });

  it('aborts the old token and never applies its late response to the next application', async () => {
    const first = deferred(); const second = deferred();
    vi.mocked(recheckReviewDocument).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const setData = vi.fn();
    const hook = renderHook(({ token }) => useAssistedApplicationDocumentRechecks(token, payload(), setData), { initialProps: { token: 'first' } });
    hook.rerender({ token: 'second' });
    expect(vi.mocked(recheckReviewDocument).mock.calls[0][3].aborted).toBe(true);
    await act(async () => { first.resolve(CHECK); }); expect(setData).not.toHaveBeenCalled();
    await act(async () => { second.resolve(CHECK); }); await waitFor(() => expect(setData).toHaveBeenCalledTimes(1));
  });

  it('restarts a pending read when only the requested-document quote changes', async () => {
    const first = deferred(); const second = deferred();
    vi.mocked(recheckReviewDocument).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const setData = vi.fn();
    const hook = renderHook(({ data }) => useAssistedApplicationDocumentRechecks('token', data, setData), { initialProps: { data: payload() } });
    const changed = payload(); changed.documents![0].quote = 'Current posting wording';
    hook.rerender({ data: changed });
    expect(recheckReviewDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recheckReviewDocument).mock.calls[0][3].aborted).toBe(true);
    await act(async () => { first.resolve(CHECK); }); expect(setData).not.toHaveBeenCalled();
    await act(async () => { second.resolve(CHECK); }); await waitFor(() => expect(setData).toHaveBeenCalledTimes(1));
  });

  it('keeps a failed attempt settled instead of retrying on every render', async () => {
    vi.mocked(recheckReviewDocument).mockRejectedValue(new Error('network'));
    const setData = vi.fn();
    const hook = renderHook(({ data }) => useAssistedApplicationDocumentRechecks('token', data, setData), { initialProps: { data: payload() } });
    await act(async () => {});
    hook.rerender({ data: { ...payload(), answers: {} } });
    expect(recheckReviewDocument).toHaveBeenCalledTimes(1); expect(setData).not.toHaveBeenCalled();
  });

  it('cancels a replaced file and resumes the new identity without accepting the old response', async () => {
    const first = deferred(); const second = deferred();
    vi.mocked(recheckReviewDocument).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const setData = vi.fn();
    const hook = renderHook(({ data }) => useAssistedApplicationDocumentRechecks('token', data, setData), { initialProps: { data: payload() } });
    const replaced = payload(); replaced.documents![0].files[0].uploadedAt = 2;
    hook.rerender({ data: replaced });
    expect(recheckReviewDocument).toHaveBeenCalledTimes(2);
    await act(async () => { first.resolve(CHECK); }); expect(setData).not.toHaveBeenCalled();
    await act(async () => { second.resolve(CHECK); }); await waitFor(() => expect(setData).toHaveBeenCalledTimes(1));
    expect(setData.mock.calls[0][0](payload()).documents[0].files[0].clientCheck.verdict).toBe('mismatch');
    expect(setData.mock.calls[0][0](replaced).documents[0].files[0].clientCheck.verdict).toBe('match');
  });
});
