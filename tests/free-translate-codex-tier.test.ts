import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tier Codex Luna Max della cascata MT (decisione del proprietario del
 * 2026-09-25: «Quando deepl e azure translation sono fuori quota USA codex luna
 * Max»). Gemello di generator/tests/free-translate-codex-tier.test.mjs del
 * corpus.
 *
 * Pinna: il tier entra SOLO quando DeepL e Azure sono fuori gioco per la run
 * (chiavi esaurite), non quando falliscono su un testo solo; senza lane
 * (socket del broker assente) si salta in silenzio; il budget per processo e i
 * fallimenti consecutivi lo fermano con UNA riga di log; la risposta passa da
 * `tryTier`/`finalize` come ogni altro tier (eco della sorgente rifiutato e
 * contato, token protetti rimessi nella lingua di arrivo).
 *
 * Nessuna rete e nessun Codex vero: `fetch` e' uno stub (DeepL, Azure,
 * MyMemory) e la chiamata a Codex passa da `setCodexTranslateCallForTests`.
 * Le chiavi sono lette all'import del modulo: l'ambiente si prepara prima di un
 * import fresco (`vi.resetModules`), e lo stato dei tier (chiavi esaurite)
 * prosegue fra i casi nell'ordine in cui sono scritti.
 */

type FreeTranslate = typeof import('../scripts/lib/free-translate.mjs');
type CodexStub = (messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>) => Promise<string>;

const IT = 'Il permesso G si rinnova ogni cinque anni presso l\'ufficio della migrazione del Cantone Ticino.';
const EN = 'The G permit is renewed every five years at the migration office of the Canton of Ticino.';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tier-'));
const SOCKET = path.join(tmp, 'broker.sock');
fs.writeFileSync(SOCKET, '');

const premium = { deepl: 200, azure: 200 };
const realFetch = globalThis.fetch;
let ft: FreeTranslate;
let codexModel: string;

beforeAll(async () => {
  for (const key of [
    'DEEPL_API_KEY_2', 'AZURE_TRANSLATOR_KEY_2', 'GSC_CLIENT_ID', 'GSC_CLIENT_SECRET',
    'GSC_REFRESH_TOKEN', 'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'LIBRETRANSLATE_SELF_HOSTED_URL',
    'MT_LOCAL_OPUSMT', 'ENABLE_CODEX_ARTICLE_FALLBACK', 'AI_MODELS_PREFER', 'AI_MODELS_FORCE_CHAIN',
    'FREE_TRANSLATE_CODEX_MAX_CALLS', 'FREE_TRANSLATE_CODEX_MAX_MS',
  ]) vi.stubEnv(key, '');
  vi.stubEnv('DEEPL_API_KEY', 'deepl-finta');
  vi.stubEnv('AZURE_TRANSLATOR_KEY', 'azure-finta');
  vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', SOCKET);
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('api-free.deepl.com')) {
      if (premium.deepl === 200) return { ok: true, status: 200, json: async () => ({ translations: [{ text: `DEEPL ${EN}` }] }) };
      return { ok: false, status: premium.deepl, json: async () => ({}), text: async () => '' };
    }
    if (u.includes('api.cognitive.microsofttranslator.com')) {
      if (premium.azure === 200) return { ok: true, status: 200, json: async () => [{ translations: [{ text: `AZURE ${EN}` }] }] };
      return { ok: false, status: premium.azure, json: async () => ({}), text: async () => 'credenziali rifiutate' };
    }
    if (u.includes('api.mymemory.translated.net')) {
      return { ok: true, json: async () => ({ responseData: { translatedText: `MYMEMORY ${EN}`, match: 1 } }) };
    }
    throw new Error('offline nel test');
  }) as unknown as typeof globalThis.fetch;
  vi.resetModules();
  ft = await import('../scripts/lib/free-translate.mjs');
  const ai = await import('../scripts/lib/ai-models.mjs');
  codexModel = ai.AI_MODELS.CODEX_CLI_PRIMARY;
});

afterAll(() => {
  ft?.setCodexTranslateCallForTests(null);
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Contatori del tier Codex: `getCascadeStats` copia solo il primo livello. */
function codexCounters() {
  const s = ft.getCascadeStats();
  return {
    hits: s.tierHits.codex || 0,
    errors: s.tierErrors.codex || 0,
    passthroughs: s.tierPassthroughs.codex || 0,
  };
}

function stubCodex(answer: string | ((messages: Array<{ role: string; content: string }>) => string | Promise<string>)) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; opts: Record<string, unknown> }> = [];
  const stub: CodexStub = async (messages, opts) => {
    calls.push({ messages, opts });
    return typeof answer === 'function' ? answer(messages) : answer;
  };
  ft.setCodexTranslateCallForTests(stub);
  return calls;
}

async function captureLog<T>(fn: () => Promise<T> | T) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    return { value: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

const tr = (text = IT) => ft.freeTranslate({ text, sourceLang: 'it', targetLang: 'en', fieldType: 'description' });

describe('freeTranslate — tier Codex Luna Max', () => {
  it('DeepL sano: Codex non viene chiamato', async () => {
    const calls = stubCodex(`CODEX ${EN}`);
    expect(await tr()).toBe(`DEEPL ${EN}`);
    expect(calls).toHaveLength(0);
  });

  it('DeepL e Azure giu\' su UN testo (5xx), chiavi non esaurite: niente Codex', async () => {
    premium.deepl = 500;
    premium.azure = 500;
    const calls = stubCodex(`CODEX ${EN}`);
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    expect(calls).toHaveLength(0);
  });

  it('DeepL 456 e Azure 401: tier Codex, con il prompt stretto e la sola lane Codex', async () => {
    premium.deepl = 456;
    premium.azure = 401;
    const before = codexCounters();
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(() => tr());
    expect(value).toBe(`CODEX ${EN}`);
    expect(calls).toHaveLength(1);
    expect(codexCounters().hits - before.hits).toBe(1);
    expect(lines.filter((l) => l.includes('traduzioni via Codex Luna Max'))).toHaveLength(1);

    const { messages, opts } = calls[0];
    const system = messages.find((m) => m.role === 'system')!.content;
    expect(system).toMatch(/from Italian to English/);
    expect(system).toMatch(/Translate only/);
    expect(system).toMatch(/\*\*bold\*\*/);
    expect(system).toMatch(/URLs/);
    expect(system).toMatch(/ZQX0XQZ/);
    expect(system).toMatch(/translated text only/);
    expect(messages.find((m) => m.role === 'user')!.content).toBe(`BEGIN_TEXT\n${IT}\nEND_TEXT`);
    expect(opts.chain).toEqual([codexModel]);
    expect(opts.prefer).toEqual([codexModel]);
    expect(opts.bypassForceChain).toBe(true);
    expect(opts.deadlineMs as number).toBeGreaterThan(Date.now());
    expect(opts.deadlineMs as number).toBeLessThanOrEqual(Date.now() + 180_000);
  });

  it('la risposta passa da finalize: cornice tolta, token protetto rimesso nella lingua di arrivo', async () => {
    const calls = stubCodex((messages) => {
      const user = messages.find((m) => m.role === 'user')!.content;
      const token = /ZQX\d+XQZ/.exec(user)?.[0];
      expect(token, 'il trigramma di genere deve arrivare mascherato').toBeTruthy();
      return `\`\`\`\nBEGIN_TEXT\nInfermiere diplomato ${token}\nEND_TEXT\n\`\`\``;
    });
    const out = await ft.freeTranslate({ text: 'Pflegefachperson HF (m/w/d)', sourceLang: 'de', targetLang: 'it' });
    expect(calls).toHaveLength(1);
    expect(out).toMatch(/^Infermiere diplomato/);
    expect(out).not.toMatch(/ZQX|BEGIN_TEXT|END_TEXT|```/);
  });

  it('un eco della sorgente e\' rifiutato e contato, la cascata prosegue', async () => {
    const before = codexCounters();
    const calls = stubCodex(IT);
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    expect(calls).toHaveLength(1);
    const after = codexCounters();
    expect(after.passthroughs - before.passthroughs).toBe(1);
    expect(after.hits - before.hits).toBe(0);
  });

  it('senza lane (socket assente, variabile vuota o lane spenta) il tier si salta in silenzio', async () => {
    const before = codexCounters();
    const calls = stubCodex(`CODEX ${EN}`);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', path.join(tmp, 'broker-scaduto.sock'));
    const { value, lines } = await captureLog(() => tr());
    expect(value).toBe(`MYMEMORY ${EN}`);
    expect(lines.filter((l) => l.includes('[codex]'))).toHaveLength(0);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', '');
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    vi.stubEnv('CODEX_AUTH_BROKER_SOCKET', SOCKET);
    vi.stubEnv('ENABLE_CODEX_ARTICLE_FALLBACK', '0');
    expect(await tr()).toBe(`MYMEMORY ${EN}`);
    vi.stubEnv('ENABLE_CODEX_ARTICLE_FALLBACK', '');
    expect(calls).toHaveLength(0);
    expect(codexCounters().errors).toBe(before.errors);
  });

  it('il budget di chiamate ferma il tier con una riga sola', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '2');
    const calls = stubCodex(`CODEX ${EN}`);
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual([`CODEX ${EN}`, `CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
    expect(calls).toHaveLength(2);
    expect(lines.filter((l) => l.includes('budget di 2 chiamate esaurito'))).toHaveLength(1);
    const summary = await captureLog(() => ft.logCascadeSummary());
    expect(summary.lines.some((l) => l.includes('Codex Luna Max: 2/2 calls'))).toBe(true);
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '');
  });

  it('le chiamate concorrenti non superano il budget', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '3');
    const calls = stubCodex(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `CODEX ${EN}`;
    });
    const { value } = await captureLog(() => Promise.all(Array.from({ length: 6 }, () => tr())));
    expect(calls).toHaveLength(3);
    expect(value.filter((v) => v === `CODEX ${EN}`)).toHaveLength(3);
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_CALLS', '');
  });

  it('tre fallimenti consecutivi fermano il tier, contati come errori del tier', async () => {
    const before = codexCounters();
    const calls = stubCodex(() => { throw new Error('broker non raggiungibile'); });
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual(Array(4).fill(`MYMEMORY ${EN}`));
    expect(calls).toHaveLength(3);
    expect(codexCounters().errors - before.errors).toBe(3);
    expect(lines.filter((l) => l.includes('3 fallimenti consecutivi'))).toHaveLength(1);
    // Il messaggio dell'errore non finisce nel log.
    expect(lines.every((l) => !l.includes('broker non raggiungibile'))).toBe(true);
  });
});
