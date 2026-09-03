import { describe, it, expect, vi } from 'vitest';

import {
  LINK_TOKENS_COLLECTION,
  SUBSCRIBERS_COLLECTION,
  buildTelegramLinkUrl,
  isTelegramAlertRecipient,
  loadTelegramChatIds,
  mintLinkToken,
  newLinkToken,
  parseBotCommand,
  redeemLinkToken,
  renderCompanyAlertTelegram,
  resolveAlertBotUsername,
  unlinkChat,
} from '../scripts/lib/telegram-alert-channel.mjs';
import { applyCommand } from '../scripts/link-telegram-alert-chats.mjs';
import { getUpdates } from '../scripts/lib/telegram-client.mjs';

/**
 * Minimal in-memory Firestore double: enough for doc get/set/delete, a single
 * equality `where`, and `getAll`. Deliberately not a mock of the SDK — the
 * assertions below are about what the channel WROTE, and a stub that records
 * calls would let a wrong document path pass.
 */
function fakeDb(seed: Record<string, Record<string, any>> = {}) {
  const store: Record<string, Record<string, any>> = JSON.parse(JSON.stringify(seed));
  const docRef = (coll: string, id: string) => ({
    id,
    get: async () => ({
      exists: Boolean(store[coll]?.[id]),
      data: () => store[coll]?.[id],
    }),
    set: async (data: any, opts?: { merge?: boolean }) => {
      store[coll] = store[coll] || {};
      store[coll][id] = opts?.merge ? { ...(store[coll][id] || {}), ...data } : data;
    },
    delete: async () => { delete store[coll]?.[id]; },
  });
  const db: any = {
    store,
    collection: (coll: string) => ({
      doc: (id: string) => docRef(coll, id),
      where: (field: string, _op: string, value: any) => ({
        get: async () => ({
          docs: Object.entries(store[coll] || {})
            .filter(([, d]) => (d as any)[field] === value)
            .map(([id, d]) => ({ id, data: () => d, ref: docRef(coll, id) })),
        }),
      }),
    }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r) => r.get())),
  };
  return db;
}

describe('telegram link tokens', () => {
  it('mints a URL-safe token inside the 64-char ?start= budget', () => {
    const token = newLinkToken();
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(buildTelegramLinkUrl('@FrontaliereBot', token))
      .toBe(`https://t.me/FrontaliereBot?start=${token}`);
  });

  it('omits the deep link when the bot username is not configured', () => {
    expect(buildTelegramLinkUrl('', 'abc')).toBe('');
    expect(buildTelegramLinkUrl('bot', '')).toBe('');
    expect(resolveAlertBotUsername({ TELEGRAM_BOT_USERNAME: '@fallback' })).toBe('fallback');
    expect(resolveAlertBotUsername({})).toBe('');
  });

  it('binds the chat to the address the token was minted for, then burns it', async () => {
    const db = fakeDb();
    const token = await mintLinkToken(db, 'Reader@Example.com ', { now: 1_000, token: 'tok1' });
    expect(token).toBe('tok1');
    expect(db.store[LINK_TOKENS_COLLECTION].tok1.email).toBe('reader@example.com');

    const res = await redeemLinkToken(db, { token: 'tok1', chatId: 4242, now: 2_000 });
    expect(res).toMatchObject({ ok: true, email: 'reader@example.com' });
    expect(db.store[SUBSCRIBERS_COLLECTION]['reader@example.com']).toMatchObject({
      telegramChatId: '4242',
      telegramOptOut: false,
    });
    // Single use: a second tap of the same link cannot bind another chat.
    expect(await redeemLinkToken(db, { token: 'tok1', chatId: 9, now: 2_100 }))
      .toMatchObject({ ok: false, reason: 'unknown token' });
  });

  it('refuses an expired token and deletes it rather than leaving it live', async () => {
    const db = fakeDb();
    await mintLinkToken(db, 'a@b.ch', { now: 0, ttlMs: 100, token: 'old' });
    const res = await redeemLinkToken(db, { token: 'old', chatId: '7', now: 1_000 });
    expect(res).toMatchObject({ ok: false, reason: 'expired token' });
    expect(db.store[LINK_TOKENS_COLLECTION].old).toBeUndefined();
    expect(db.store[SUBSCRIBERS_COLLECTION]).toBeUndefined();
  });
});

describe('consent', () => {
  it('treats a missing binding as NOT opted in', () => {
    expect(isTelegramAlertRecipient(undefined)).toBe(false);
    expect(isTelegramAlertRecipient({})).toBe(false);
    expect(isTelegramAlertRecipient({ telegramChatId: '1' })).toBe(true);
  });

  it('honours both withdrawal switches', () => {
    expect(isTelegramAlertRecipient({ telegramChatId: '1', telegramOptOut: true })).toBe(false);
    expect(isTelegramAlertRecipient({ telegramChatId: '1', channels: { telegram: false } })).toBe(false);
  });

  it('/stop clears every address bound to that chat', async () => {
    const db = fakeDb({
      [SUBSCRIBERS_COLLECTION]: {
        'a@b.ch': { telegramChatId: '55' },
        'c@d.ch': { telegramChatId: '55' },
        'e@f.ch': { telegramChatId: '56' },
      },
    });
    expect(await unlinkChat(db, { chatId: '55', now: 9 })).toBe(2);
    expect(db.store[SUBSCRIBERS_COLLECTION]['a@b.ch'].telegramOptOut).toBe(true);
    expect(db.store[SUBSCRIBERS_COLLECTION]['e@f.ch'].telegramOptOut).toBeUndefined();
  });

  it('excludes opted-out subscribers from the delivery lookup', async () => {
    const db = fakeDb({
      [SUBSCRIBERS_COLLECTION]: {
        'in@b.ch': { telegramChatId: '1' },
        'out@b.ch': { telegramChatId: '2', telegramOptOut: true },
      },
    });
    const map = await loadTelegramChatIds(db, ['IN@b.ch', 'out@b.ch', 'never@b.ch']);
    expect([...map.entries()]).toEqual([['in@b.ch', '1']]);
  });
});

describe('parseBotCommand', () => {
  it('reads /start with its payload, @mention and all', () => {
    expect(parseBotCommand({ update_id: 3, message: { chat: { id: -100 }, text: '/start@myBot tok9' } }))
      .toEqual({ updateId: 3, chatId: '-100', command: '/start', payload: 'tok9' });
  });

  it('ignores updates that carry no command', () => {
    expect(parseBotCommand({ update_id: 1, message: { chat: { id: 1 }, text: 'ciao' } })).toBeNull();
    expect(parseBotCommand({ update_id: 1, edited_message: { chat: { id: 1 }, text: '/start x' } })).toBeNull();
    expect(parseBotCommand({ message: { chat: { id: 1 }, text: '/stop' } })).toBeNull();
  });
});

describe('applyCommand', () => {
  const send = () => vi.fn(async () => ({ ok: true, messageId: 1, error: null }));

  it('links, replies in the reader locale, and reports the address', async () => {
    const db = fakeDb();
    await mintLinkToken(db, 'r@b.ch', { now: 0, token: 'tk' });
    const sendImpl = send();
    const res = await applyCommand(db, { chatId: '8', command: '/start', payload: 'tk' },
      { token: 'BOT', locale: 'en', sendImpl, now: 1 });
    expect(res).toMatchObject({ action: 'linked', email: 'r@b.ch' });
    expect(sendImpl).toHaveBeenCalledWith(expect.objectContaining({ chatId: '8', token: 'BOT' }));
    expect(sendImpl.mock.calls[0][0].text).toMatch(/Done!/);
  });

  it('tells the reader when the token is stale instead of failing silently', async () => {
    const sendImpl = send();
    const res = await applyCommand(fakeDb(), { chatId: '8', command: '/start', payload: 'nope' },
      { token: 'BOT', sendImpl });
    expect(res.action).toBe('rejected:unknown token');
    expect(sendImpl.mock.calls[0][0].text).toMatch(/non è più valido/);
  });

  it('never writes to Telegram in dry-run', async () => {
    const sendImpl = send();
    await applyCommand(fakeDb(), { chatId: '8', command: '/stop', payload: '' },
      { token: 'BOT', sendImpl, dryRun: true });
    expect(sendImpl).not.toHaveBeenCalled();
  });
});

describe('renderCompanyAlertTelegram', () => {
  const sections = [
    { companyName: 'Rossi & Figli', jobs: [{ title: 'Dev <senior>', url: 'https://x.ch/1', location: 'Lugano' }] },
    { companyName: 'Acme', jobs: [{ title: 'QA', url: 'https://x.ch/2', canton: 'TI' }] },
  ];

  it('escapes every dynamic value so Telegram can parse the HTML', () => {
    const text = renderCompanyAlertTelegram({ sections, locale: 'it', manageUrl: 'https://m' });
    expect(text).toContain('Rossi &amp; Figli');
    expect(text).toContain('Dev &lt;senior&gt;');
    expect(text).not.toMatch(/<senior>/);
  });

  it('names the employer when there is exactly one, counts them when there are more', () => {
    expect(renderCompanyAlertTelegram({ sections: [sections[0]] })).toContain('Nuovi annunci da Rossi');
    expect(renderCompanyAlertTelegram({ sections })).toContain('2 aziende');
  });

  it('keeps the way out when it has to truncate', () => {
    const many = [{
      companyName: 'A',
      jobs: Array.from({ length: 400 }, (_, i) => ({ title: `Job ${i}`, url: `https://x.ch/${i}` })),
    }];
    const text = renderCompanyAlertTelegram({ many: 0, sections: many, manageUrl: 'https://m' } as any);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('/stop');
    expect(text).toContain('https://m');
  });

  it('says nothing when there is nothing to say', () => {
    expect(renderCompanyAlertTelegram({ sections: [] })).toBe('');
    expect(renderCompanyAlertTelegram({ sections: [{ companyName: 'A', jobs: [] }] })).toBe('');
  });
});

describe('getUpdates', () => {
  it('passes the acknowledgement cursor and unwraps the envelope', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('offset=42');
      return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 42 }] }) } as any;
    });
    const res = await getUpdates({ token: 'T', offset: 42, fetchImpl: fetchImpl as any });
    expect(res).toEqual({ ok: true, updates: [{ update_id: 42 }], error: null });
  });

  it('omits offset on the first poll and never throws on a bad reply', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).not.toContain('offset=');
      return { ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) } as any;
    });
    expect(await getUpdates({ token: 'T', fetchImpl: fetchImpl as any }))
      .toMatchObject({ ok: false, error: 'telegram error: Unauthorized' });
    await expect(getUpdates({ token: 'T', fetchImpl: (() => { throw new Error('boom'); }) as any }))
      .resolves.toMatchObject({ ok: false, error: 'boom' });
  });
});

describe('send-company-alerts wiring', () => {
  it('sends one Telegram copy per LINKED recipient, carrying the rendered sections', async () => {
    const { deliverTelegramCopies } = await import('../scripts/send-company-alerts.mjs');
    const sendImpl = vi.fn(async () => ({ ok: true, messageId: 1, error: null }));
    const delivered = await deliverTelegramCopies([
      {
        to: 'Linked@b.ch',
        telegramChatId: '77',
        telegramLocale: 'it',
        telegramManageUrl: 'https://m',
        telegramSections: [{ company: 'Acme', hubUrl: 'https://hub', jobs: [{ title: 'Dev', url: 'https://x.ch/1' }] }],
      },
      { to: 'unlinked@b.ch', telegramChatId: null, telegramSections: [] },
    ], { token: 'BOT', sendImpl });

    expect(sendImpl).toHaveBeenCalledTimes(1);
    expect(sendImpl.mock.calls[0][0].text).toContain('Acme');
    expect([...delivered]).toEqual(['linked@b.ch']);
  });

  it('swallows a Telegram failure — the email channel is the record', async () => {
    const { deliverTelegramCopies } = await import('../scripts/send-company-alerts.mjs');
    const sendImpl = vi.fn(async () => ({ ok: false, messageId: null, error: 'bot was blocked by the user' }));
    const delivered = await deliverTelegramCopies([
      { to: 'a@b.ch', telegramChatId: '1', telegramSections: [{ company: 'A', jobs: [{ title: 'J', url: 'u' }] }] },
    ], { token: 'BOT', sendImpl });
    expect(delivered.size).toBe(0);
  });

  it('lets a delivered Telegram copy rescue the dedup record of a bounced email', async () => {
    const { selectPersistableSends } = await import('../scripts/send-company-alerts.mjs');
    const emails = [{ to: 'a@b.ch' }, { to: 'b@b.ch' }];
    const failed = [{ to: 'a@b.ch' }, { to: 'b@b.ch' }];
    // Without the Telegram set, both are blocked from writing back (unchanged).
    expect(selectPersistableSends(emails, failed)).toEqual([]);
    // With it, only the one the reader actually received is persisted.
    expect(selectPersistableSends(emails, failed, new Set(['a@b.ch']))).toEqual([{ to: 'a@b.ch' }]);
  });
});
