import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../functions/src/geminiGenerate.js', () => ({ generateServerText: vi.fn() }));
const { generateServerText } = await import('../functions/src/geminiGenerate.js');
const { verifyNativeApplicationClaims } = await import('../functions/src/assistedApplicationNativeProof.js');
const { qualificationSources } = await import('../functions/src/lib/qualificationEvidence.js');

beforeEach(() => { vi.clearAllMocks(); });

function fixture() {
  const claims = [{ fieldId: 'degree', nativeFormContract: { question: 'Do you hold a degree?', context: 'Education' }, proposedAnswer: true }];
  const context = { sources: qualificationSources({ sourceText: 'Bachelor of Computer Science' }), scope: { orderId: 'server-fixture', round: 1 }, unverifiedContext: { notes: '' } };
  const response = (user: string) => {
    const payload = JSON.parse(user);
    return payload.sourceColumns ? { assessments: [{ index: 0, sourceIds: [payload.sources[0][0]] }] }
      : { assessments: [{ index: 0, proofId: payload.claims[0].proof.id, verdict: 'supported', reason: 'explicit_fact' }] };
  };
  const generate = vi.fn(async (_system: string, user: string, _schema?: any, _options?: any) => response(user));
  return { claims, context, generate, response };
}

describe('Functions-only native proof boundary', () => {
  it('uses the existing bounded backend tier for both passes with no Codex fallback', async () => {
    const f = fixture();
    vi.mocked(generateServerText).mockImplementation(async options => ({ status: 200, body: { ok: true, provider: 'test', text: JSON.stringify(f.response(options.userPrompt)) } }));
    const result = await verifyNativeApplicationClaims({ claims: f.claims, context: f.context });
    expect(result.status).toBe('supported');
    expect(generateServerText).toHaveBeenCalledTimes(2);
    for (const [options] of vi.mocked(generateServerText).mock.calls) expect(options).toMatchObject({ maxTokens: 2048, maxProviderAttempts: 3, allowCodexFallback: false, temperature: 0, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(vi.mocked(generateServerText).mock.calls)).not.toContain('server-fixture');
  });

  it.each(['value', 'counter'])('never binds a verdict to %s changed while the provider was awaiting', async kind => {
    const f = fixture();
    const generate = vi.fn(async (_system: string, user: string) => {
      if (JSON.parse(user).sourceColumns) {
        if (kind === 'value') f.claims[0].proposedAnswer = false;
        else f.context.unverifiedContext.notes = 'Current correction invalidates the earlier assertion.';
      }
      return f.response(user);
    });
    expect(await verifyNativeApplicationClaims({ ...f, generate })).toMatchObject({ status: 'unverified', verification: { failure: 'input_changed' } });
  });

  it('returns technical unknown promptly on cancellation and ignores a late provider result', async () => {
    const f = fixture(); const controller = new AbortController();
    let entered!: () => void; let resume!: (value: any) => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const generate = vi.fn(async () => { entered(); return new Promise(resolve => { resume = resolve; }); });
    const pending = verifyNativeApplicationClaims({ ...f, generate, signal: controller.signal });
    await ready; controller.abort(new Error('request canceled'));
    expect(await pending).toMatchObject({ status: 'unverified', verification: { failure: 'proof_deadline' } });
    expect(generate).toHaveBeenCalledTimes(1);
    resume({ assessments: [] });
  });
});
