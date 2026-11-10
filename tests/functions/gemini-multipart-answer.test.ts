import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async (key: string) => (['GEMINI_API_KEY', 'GROQ_API_KEY'].includes(key) ? 'test-only-key' : '')),
}));
vi.mock('../../functions/src/codexFallback.js', () => ({ tryCodexFallback: vi.fn(async () => ({ ok: false, notConfigured: true })) }));
const { generateServerText } = await import('../../functions/src/geminiGenerate.js');
const { geminiResponseText } = await import('../../functions/src/lib/geminiResponseText.js');
const { eligibilityJsonObject } = await import('../../functions/src/applicationConciergeEligibility.js');

// Shape observed on gemini-3.5-flash-lite (2026-11-10): one JSON answer split
// across two text parts, the second one carrying a thoughtSignature.
const splitAnswer = {
  candidates: [{
    finishReason: 'STOP',
    content: { parts: [
      { text: '```json\n{\n  "postingLanguage": "en",\n  "requirements": [{"requirement": "Retail sales"' },
      { text: '}],\n  "rolling": false\n}\n```', thoughtSignature: 'opaque' },
    ] },
  }],
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Gemini answer text', () => {
  it('joins every answer part and leaves thought summaries out', () => {
    expect(geminiResponseText(splitAnswer)).toBe('```json\n{\n  "postingLanguage": "en",\n  "requirements": [{"requirement": "Retail sales"}],\n  "rolling": false\n}\n```');
    expect(geminiResponseText({ candidates: [{ content: { parts: [{ text: 'thinking aloud', thought: true }, { text: ' answer ' }] } }] })).toBe('answer');
    expect(geminiResponseText({ candidates: [{ content: { parts: [{ inlineData: {} }] } }] })).toBe('');
    expect(geminiResponseText({})).toBe('');
  });

  it('returns the whole split JSON answer, which the eligibility check can parse', async () => {
    const fetchMock = vi.fn(async () => json(splitAnswer));
    vi.stubGlobal('fetch', fetchMock);
    const response = await generateServerText({ userPrompt: 'Synthetic posting', maxProviderAttempts: 3, allowCodexFallback: false,
      acceptText: (text: string) => eligibilityJsonObject(text) !== null });
    expect(response).toMatchObject({ status: 200, body: { ok: true, provider: 'gemini' } });
    expect(eligibilityJsonObject(response.body.text)).toEqual({ postingLanguage: 'en', requirements: [{ requirement: 'Retail sales' }], rolling: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('moves a rejected answer on to the next provider instead of returning it', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).includes('generativelanguage')
      ? json({ candidates: [{ content: { parts: [{ text: '{"requirements": [' }] } }] })
      : json({ choices: [{ message: { content: '{"requirements":[]}' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const response = await generateServerText({ userPrompt: 'Synthetic posting', maxProviderAttempts: 3, allowCodexFallback: false,
      acceptText: (text: string) => eligibilityJsonObject(text) !== null });
    expect(response).toMatchObject({ status: 200, body: { ok: true, provider: 'groq-gpt-oss-120b', text: '{"requirements":[]}' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an exhausted chain of rejected answers as invalid output, within the attempt budget', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).includes('generativelanguage')
      ? json({ candidates: [{ content: { parts: [{ text: 'Here is the JSON you asked for' }] } }] })
      : json({ choices: [{ message: { content: 'not json either' } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const response = await generateServerText({ userPrompt: 'Synthetic posting', maxProviderAttempts: 2, allowCodexFallback: false,
      background: true, acceptText: (text: string) => eligibilityJsonObject(text) !== null });
    expect(response).toMatchObject({ status: 502, body: { ok: false, error: 'all_providers_failed', invalidOutput: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps callers without an output contract unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ candidates: [{ content: { parts: [{ text: 'Plain prose answer' }] } }] })));
    const response = await generateServerText({ userPrompt: 'Synthetic prompt', allowCodexFallback: false });
    expect(response).toMatchObject({ status: 200, body: { ok: true, provider: 'gemini', text: 'Plain prose answer' } });
    expect(response.body).not.toHaveProperty('invalidOutput');
  });
});
