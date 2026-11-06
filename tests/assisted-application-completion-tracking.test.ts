import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ track: vi.fn(), suppress: vi.fn(() => false) }));
vi.mock('../services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.track,
  shouldSuppressAssistedApplicationEvent: mocks.suppress,
}));

const context = { variant: 'assisted_application' as const, jobId: 'job-test', companyId: 'company-test', price_eur_cents: 199 };
let storage: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.suppress.mockReturnValue(false);
  storage = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import('../services/assistedApplicationCompletionTracking');

describe('assisted paid-order funnel deduplication', () => {
  it('emits each order once and keeps its price/attribution intact', async () => {
    const { trackAssistedApplicationCompletionOnce: track } = await load();
    expect(track('order-one', context)).toBe(true);
    expect(track('order-one', context)).toBe(false);
    expect(track('order-two', context)).toBe(true);
    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track).toHaveBeenCalledWith('checkout_completed', context);
  });

  it('does not emit an old paid order again after the page/module reloads', async () => {
    (await load()).trackAssistedApplicationCompletionOnce('order-one', context);
    vi.resetModules();
    expect((await load()).trackAssistedApplicationCompletionOnce('order-one', context)).toBe(false);
    expect(mocks.track).toHaveBeenCalledOnce();
  });

  it('does not consume the marker for suppressed automated traffic', async () => {
    const { trackAssistedApplicationCompletionOnce: track } = await load();
    mocks.suppress.mockReturnValue(true);
    expect(track('order-one', context)).toBe(false);
    expect(storage.size).toBe(0);
    mocks.suppress.mockReturnValue(false);
    expect(track('order-one', context)).toBe(true);
    expect(mocks.track).toHaveBeenCalledOnce();
  });

  it('retains page-local deduplication when browser storage is denied', async () => {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('denied'); } });
    const { trackAssistedApplicationCompletionOnce: track } = await load();
    expect(track('order-one', context)).toBe(true);
    expect(track('order-one', context)).toBe(false);
    expect(mocks.track).toHaveBeenCalledOnce();
  });

  it('does not persist a completion when the emitter throws', async () => {
    const { trackAssistedApplicationCompletionOnce: track } = await load();
    mocks.track.mockImplementationOnce(() => { throw new Error('emitter-failed'); });
    expect(() => track('order-one', context)).toThrow('emitter-failed');
    expect(storage.size).toBe(0);
    expect(track('order-one', context)).toBe(true);
  });
});
