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
 * contato, token protetti rimessi nella lingua di arrivo); la cornice si toglie
 * solo con i marcatori della chiamata, quindi un testo che contiene davvero
 * `END_TEXT` resta intero; le chiamate del processo passano una alla volta e
 * non superano insieme il budget di tempo; con FREE_TRANSLATE_CODEX_TIER=last
 * (translate-pending, dopo Argos) il tier non prende il testo prima dei tier
 * senza quota e lo traduce in coda, solo quando ogni altro tier lo ha lasciato.
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
// MyMemory che rimanda la sorgente: eco rifiutato, la cascata prosegue fino in fondo.
const free = { mymemoryEcho: false };
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
      const translatedText = free.mymemoryEcho ? new URL(u).searchParams.get('q') : `MYMEMORY ${EN}`;
      return { ok: true, json: async () => ({ responseData: { translatedText, match: 1 } }) };
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
/** Suffisso dei marcatori della chiamata, letto dal messaggio utente. */
function markerOf(messages: Array<{ role: string; content: string }>) {
  return /^BEGIN_TEXT_([A-Z0-9]{8})\n/.exec(messages.find((m) => m.role === 'user')!.content)?.[1];
}

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
    const user = messages.find((m) => m.role === 'user')!.content;
    const framed = /^BEGIN_TEXT_([A-Z0-9]{8})\n([\s\S]*)\nEND_TEXT_\1$/.exec(user);
    expect(framed, 'testo incorniciato dai marcatori della chiamata').toBeTruthy();
    expect(framed![2]).toBe(IT);
    expect(system).toContain(`between BEGIN_TEXT_${framed![1]} and END_TEXT_${framed![1]}`);
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
      const marker = markerOf(messages);
      return `\`\`\`\nBEGIN_TEXT_${marker}\nInfermiere diplomato ${token}\nEND_TEXT_${marker}\n\`\`\``;
    });
    const out = await ft.freeTranslate({ text: 'Pflegefachperson HF (m/w/d)', sourceLang: 'de', targetLang: 'it' });
    expect(calls).toHaveLength(1);
    expect(out).toMatch(/^Infermiere diplomato/);
    expect(out).not.toMatch(/ZQX|BEGIN_TEXT|END_TEXT|```/);
  });

  it('un testo che contiene davvero BEGIN_TEXT o END_TEXT resta intero', async () => {
    const source = 'BEGIN_TEXT apre il blocco e il modulo si chiude con END_TEXT';
    const translated = 'BEGIN_TEXT opens the block and the form closes with END_TEXT';
    const calls = stubCodex((messages) => {
      const marker = markerOf(messages);
      expect(marker, 'marcatori della chiamata presenti').toBeTruthy();
      expect(source.includes(marker!)).toBe(false);
      return translated;
    });
    expect(await tr(source)).toBe(translated);
    expect(calls).toHaveLength(1);
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

  it('le chiamate concorrenti passano una alla volta e non superano insieme il budget di tempo', async () => {
    // Orologio finto: ogni chiamata "dura" 10 s. Con 20 s di budget la prima
    // chiamata lascia 10 s, sotto il minimo di 15 s per chiamata: le altre non
    // partono. Lette in parallelo prima dell'await, tutte e tre avrebbero visto
    // 20 s di residuo e sarebbero partite.
    vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '20000');
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const calls = stubCodex(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        offset += 10_000;
        inFlight -= 1;
        return `CODEX ${EN}`;
      });
      const { value, lines } = await captureLog(() => Promise.all([tr(), tr(), tr()]));
      expect(calls).toHaveLength(1);
      expect(maxInFlight).toBe(1);
      expect(value).toEqual([`CODEX ${EN}`, `MYMEMORY ${EN}`, `MYMEMORY ${EN}`]);
      expect(lines.filter((l) => l.includes('budget di 20s esaurito'))).toHaveLength(1);
    } finally {
      clock.mockRestore();
      vi.stubEnv('FREE_TRANSLATE_CODEX_MAX_MS', '');
    }
  });

  it('in coda le chiamate non si sovrappongono mai', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = stubCodex(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return `CODEX ${EN}`;
    });
    const { value } = await captureLog(() => Promise.all(Array.from({ length: 4 }, () => tr())));
    expect(value).toEqual(Array(4).fill(`CODEX ${EN}`));
    expect(calls).toHaveLength(4);
    expect(maxInFlight).toBe(1);
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
  it('tre echi di fila fermano il tier come tre fallimenti, e restano contati come passthrough', async () => {
    const before = codexCounters();
    const calls = stubCodex(IT);
    const { value, lines } = await captureLog(async () => [await tr(), await tr(), await tr(), await tr()]);
    expect(value).toEqual(Array(4).fill(`MYMEMORY ${EN}`));
    expect(calls).toHaveLength(3);
    expect(codexCounters().passthroughs - before.passthroughs).toBe(3);
    expect(lines.filter((l) => l.includes('3 fallimenti consecutivi'))).toHaveLength(1);
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: Codex non prende il testo prima dei tier senza quota', async () => {
    // DeepL e Azure sono fuori gioco dai casi precedenti: nella posizione di
    // default Codex risponderebbe qui, prima di MyMemory.
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      expect(await tr()).toBe(`MYMEMORY ${EN}`);
      expect(calls).toHaveLength(0);
    } finally {
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('FREE_TRANSLATE_CODEX_TIER=last: Codex traduce in coda il testo che ogni altro tier ha lasciato', async () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', 'last');
    free.mymemoryEcho = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      const { value, lines } = await captureLog(() => tr());
      expect(value).toBe(`CODEX ${EN}`);
      expect(calls).toHaveLength(1);
      expect(lines.filter((l) => l.includes('testi che nessun altro tier ha tradotto'))).toHaveLength(1);
    } finally {
      free.mymemoryEcho = false;
      vi.stubEnv('FREE_TRANSLATE_CODEX_TIER', '');
    }
  });

  it('senza FREE_TRANSLATE_CODEX_TIER la posizione resta quella di default, senza secondo tentativo in coda', async () => {
    free.mymemoryEcho = true;
    try {
      const calls = stubCodex(`CODEX ${EN}`);
      expect(await tr()).toBe(`CODEX ${EN}`);
      expect(calls).toHaveLength(1);
      const failing = stubCodex(() => { throw new Error('broker non raggiungibile'); });
      expect(await tr()).toBe('');
      expect(failing).toHaveLength(1);
    } finally {
      free.mymemoryEcho = false;
    }
  });
});
