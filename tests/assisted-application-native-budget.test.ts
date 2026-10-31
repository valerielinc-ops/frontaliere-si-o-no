import { describe, expect, it, vi } from 'vitest';
import { qualificationSources } from '../functions/src/lib/qualificationEvidence.js';
import { createPortalQualificationVerifier } from '../scripts/assisted-application/lib/portal/qualification-gate.mjs';

function fixture(count: number, failSecondChunk = false) {
  const fields = Array.from({ length: count }, (_, index) => ({ id: `degree-${index}`, label: 'Do you hold a university degree?', kind: 'text', inputType: 'text',
    nativeMetadataComplete: true, nativeOwnedScopes: [{ kind: 'form', names: ['Application'], unknown: false }], options: [],
    // Only the private gate unit is tested here; a real DOM binding is covered by the portal production-path suite.
    _nativeFrameBinding: { token: 'fixture-frame', index: 0, url: 'https://example.test/apply/', origin: 'https://example.test', timeOrigin: 1 } }));
  const action = { action: 'fill', value: 'Yes' };
  let invocations = 0;
  const codex = vi.fn(async ({ prompt, timeoutMs }: { prompt: string; timeoutMs: number }) => {
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(90_000);
    invocations++;
    if (failSecondChunk && invocations === 3) throw new Error('second_chunk_unavailable');
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{"') + 2, prompt.lastIndexOf('\n\nReturn exactly')));
    return { assessments: data.claims.map((claim: any) => data.sourceColumns
      ? { index: claim.index, sourceIds: [data.sources[0][0]] }
      : { index: claim.index, proofId: claim.proof.id, verdict: 'supported', reason: 'explicit_fact' }) };
  });
  const verifier = createPortalQualificationVerifier({ context: { sources: qualificationSources({ sourceText: 'Bachelor degree in Computer Science.' }),
    scope: { orderId: 'budget-fixture', round: 1 }, answerEvidence: [], localAnswerEvidence: [], unverifiedContext: null }, codex });
  const claims = fields.map(field => verifier.claim(field, action, 'Yes'));
  return { fields, action, claims, codex, verifier };
}

describe('one bounded native assessment covers every derived claim', () => {
  it.each([13, 24])('verifies %s claims in two batches before granting any action', async count => {
    const f = fixture(count);
    await f.verifier.verify(f.claims);
    expect(f.codex).toHaveBeenCalledTimes(4);
    for (const field of f.fields) expect(() => f.verifier.assert(field, f.action, 'Yes')).not.toThrow();
  });

  it('rejects 25 claims before calling the provider', async () => {
    const f = fixture(25);
    await expect(f.verifier.verify(f.claims)).rejects.toMatchObject({ reason: 'claim_budget' });
    expect(f.codex).not.toHaveBeenCalled();
    expect(() => f.verifier.assert(f.fields[0], f.action, 'Yes')).toThrow();
  });

  it('passes only the remaining aggregate time to later stages and stops when that shared signal aborts', async () => {
    const f = fixture(13);
    const original = f.codex.getMockImplementation()!;
    const controller = new AbortController();
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    f.codex.mockImplementation(async args => {
      if (f.codex.mock.calls.length === 1) {
        const response = await original(args);
        elapsed = 60_000;
        return response;
      }
      expect(args.timeoutMs).toBe(30_000);
      controller.abort(new Error('aggregate_deadline'));
      return new Promise<never>(() => {});
    });
    try {
      await expect(f.verifier.verify(f.claims)).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
      expect(f.codex).toHaveBeenCalledTimes(2);
      expect(() => f.verifier.assert(f.fields[0], f.action, 'Yes')).toThrow();
    } finally { clock.mockRestore(); deadline.mockRestore(); }
  });

  it('publishes no partial permission when the second batch fails', async () => {
    const f = fixture(13, true);
    await expect(f.verifier.verify(f.claims)).rejects.toMatchObject({ code: 'evidence_entailment_unverified' });
    expect(f.codex).toHaveBeenCalledTimes(3);
    expect(() => f.verifier.assert(f.fields[0], f.action, 'Yes')).toThrow();
    expect(() => f.verifier.assert(f.fields[12], f.action, 'Yes')).toThrow();
  });
});
