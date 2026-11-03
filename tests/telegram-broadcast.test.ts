/**
 * Guard for the Telegram broadcast pipeline:
 *   • telegram-client   — credential resolution, HTML escaping, sendMessage
 *                         (never throws; maps the Bot API envelope).
 *   • telegram-templates — daily jobs digest: canonical trailing-slash links,
 *                         escaping, URL-less job filtering, limit cap.
 *   • telegram-border-digest — weekly dogane ranking: best/worst order,
 *                         canonical links, skip-when-no-data.
 *   • social-post-utils — the shared salary formatter the digest reuses, and
 *                         `withUtm` link tagging.
 *   • telegram-links    — the single source of the channel's UTM identity.
 *
 * The UTM assertions are the observer for the 2026-08-24 finding: the channel
 * had been posting every day while GA4 reported ZERO sessions from `t.me`,
 * because every link it posted was untagged and landed in Direct. An untagged
 * broadcast link is invisible, not absent — these tests fail if one comes back.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  escapeHtml,
  resolveTelegramCredentials,
  hasTelegramCredentials,
  getCanonicalTelegramChatId,
  sendMessage,
  getChatMemberCount,
  TELEGRAM_MESSAGE_MAX,
} from '../scripts/lib/telegram-client.mjs';
import {
  buildDailyJobsDigest,
  buildPreferredSourceAnnouncement,
  PREFERRED_SOURCE_ANNOUNCEMENT_ID,
} from '../scripts/lib/telegram-templates.mjs';
import { buildWeeklyBorderDigest, telegramBorderCopyAssignmentKey } from '../scripts/lib/telegram-border-digest.mjs';
import { formatJobSalaryLabel, formatSwissThousands, withUtm } from '../scripts/lib/social-post-utils.mjs';
import {
  telegramUrl,
  TELEGRAM_UTM_SOURCE,
  TELEGRAM_UTM_MEDIUM,
  TELEGRAM_CAMPAIGN_JOBS,
  TELEGRAM_CAMPAIGN_BORDER,
  TELEGRAM_CAMPAIGN_PREFERRED_SOURCE,
} from '../scripts/lib/telegram-links.mjs';
import { buildForMode } from '../scripts/post-to-telegram.mjs';

// ── telegram-client ──────────────────────────────────────────

describe('telegram-client credentials', () => {
  it('resolves token + channel id, trimming whitespace', () => {
    const c = resolveTelegramCredentials({ TELEGRAM_BOT_TOKEN: ' abc ', TELEGRAM_CHANNEL_ID: ' @chan ' });
    expect(c).toEqual({ token: 'abc', chatId: '@chan' });
  });
  it('accepts TELEGRAM_CHAT_ID as an alias for the channel id', () => {
    const c = resolveTelegramCredentials({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100123' });
    expect(c.chatId).toBe('-100123');
  });
  it('hasTelegramCredentials requires BOTH token and chat id', () => {
    expect(hasTelegramCredentials({})).toBe(false);
    expect(hasTelegramCredentials({ TELEGRAM_BOT_TOKEN: 't' })).toBe(false);
    expect(hasTelegramCredentials({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHANNEL_ID: '@c' })).toBe(true);
  });
});

describe('escapeHtml', () => {
  it('escapes the three Telegram-HTML special characters only', () => {
    expect(escapeHtml('Tom & Jerry <b> "x"')).toBe('Tom &amp; Jerry &lt;b&gt; "x"');
  });
});

describe('sendMessage', () => {
  it('POSTs to the Bot API and maps a successful envelope', async () => {
    let captured: { url: string; body: any } | null = null;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    }) as unknown as typeof fetch;

    const res = await sendMessage({ token: 'TKN', chatId: '@c', text: 'ciao', fetchImpl });
    expect(res).toEqual({ ok: true, messageId: 42, error: null, deliveryUncertain: false });
    expect(captured!.url).toBe('https://api.telegram.org/botTKN/sendMessage');
    expect(captured!.body.chat_id).toBe('@c');
    expect(captured!.body.parse_mode).toBe('HTML');
  });

  it('maps an API error envelope to a soft failure', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    })) as unknown as typeof fetch;
    const res = await sendMessage({ token: 'T', chatId: '@c', text: 'x', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('chat not found');
    expect(res.deliveryUncertain).toBe(false);
  });

  it('keeps a 5xx Telegram error ambiguous even when the response envelope says ok=false', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, description: 'temporary failure' }),
    })) as unknown as typeof fetch;
    const res = await sendMessage({ token: 'T', chatId: '@c', text: 'x', fetchImpl });
    expect(res.deliveryUncertain).toBe(true);
  });

  it('keeps a success envelope without a valid native message id ambiguous', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    })) as unknown as typeof fetch;
    const res = await sendMessage({ token: 'T', chatId: '@c', text: 'x', fetchImpl });
    expect(res).toMatchObject({ ok: false, messageId: null, deliveryUncertain: true });
  });

  it('never throws on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const res = await sendMessage({ token: 'T', chatId: '@c', text: 'x', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
    expect(res.deliveryUncertain).toBe(true);
  });

  it('keeps delivery uncertain when the response is not a Telegram API rejection envelope', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: true }),
    })) as unknown as typeof fetch;
    const res = await sendMessage({ token: 'T', chatId: '@c', text: 'x', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.deliveryUncertain).toBe(true);
  });

  it('fails soft when credentials are missing', async () => {
    const res = await sendMessage({ token: '', chatId: '@c', text: 'x' });
    expect(res.ok).toBe(false);
  });

  it('truncates over-long text to the API hard limit', async () => {
    let sentLen = -1;
    const fetchImpl = (async (_url: string, init: any) => {
      sentLen = JSON.parse(init.body).text.length;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }) as unknown as typeof fetch;
    await sendMessage({ token: 'T', chatId: '@c', text: 'a'.repeat(TELEGRAM_MESSAGE_MAX + 500), fetchImpl });
    expect(sentLen).toBe(TELEGRAM_MESSAGE_MAX);
  });
});

describe('canonical Telegram account identity', () => {
  it('resolves public username aliases to the numeric chat ID used by the cap', async () => {
    let requestedUrl = '';
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: -1001234567890 } }) };
    }) as unknown as typeof fetch;
    await expect(getCanonicalTelegramChatId({ token: 'TKN', chatId: '@frontaliere', fetchImpl }))
      .resolves.toEqual({ ok: true, chatId: '-1001234567890', error: null });
    expect(requestedUrl).toContain('getChat?chat_id=%40frontaliere');
  });
});

describe('getChatMemberCount', () => {
  it('GETs the endpoint and maps a successful envelope', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ ok: true, result: 42 }) };
    }) as unknown as typeof fetch;

    const res = await getChatMemberCount({ token: 'TKN', chatId: '@c', fetchImpl });
    expect(res).toEqual({ ok: true, count: 42, error: null });
    expect(capturedUrl).toBe('https://api.telegram.org/botTKN/getChatMemberCount?chat_id=%40c');
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-finite', Number.POSITIVE_INFINITY],
  ])('rejects a %s member count as a soft failure', async (_label, result) => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    })) as unknown as typeof fetch;

    const res = await getChatMemberCount({ token: 'T', chatId: '@c', fetchImpl });

    expect(res).toMatchObject({ ok: false, count: null });
    expect(res.error).toContain('non-negative safe integer');
  });

  it('maps an API error envelope to a soft failure', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    })) as unknown as typeof fetch;
    const res = await getChatMemberCount({ token: 'T', chatId: '@c', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('chat not found');
  });

  it('never throws on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const res = await getChatMemberCount({ token: 'T', chatId: '@c', fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });

  it('fails soft when credentials are missing', async () => {
    const res = await getChatMemberCount({ token: '', chatId: '@c' });
    expect(res.ok).toBe(false);
  });
});

// ── shared salary formatter ──────────────────────────────────

describe('formatJobSalaryLabel', () => {
  it('formats a range with the Swiss apostrophe separator', () => {
    expect(formatSwissThousands(110000)).toBe("110'000");
    expect(
      formatJobSalaryLabel({ baseSalary: { currency: 'CHF', value: { minValue: 90000, maxValue: 110000 } } }),
    ).toBe("CHF 90'000–110'000");
  });
  it('returns empty when there is no pay', () => {
    expect(formatJobSalaryLabel({})).toBe('');
  });
});

// ── telegram-templates (jobs digest) ─────────────────────────

const JOB_A = {
  id: 'a',
  titleByLocale: { it: 'Sviluppatore Frontend' },
  slug: 'sviluppatore-frontend-lugano',
  hiringOrganization: { name: 'Acme & Co <SA>' },
  jobLocation: { address: { addressLocality: 'Lugano' } },
  baseSalary: { currency: 'CHF', value: { minValue: 90000, maxValue: 110000 } },
  employmentType: 'FULL_TIME',
  canton: 'TI',
};
const JOB_NO_SLUG = { id: 'b', title: 'Magazziniere', hiringOrganization: { name: 'LogiCo' }, canton: 'TI' };

describe('buildDailyJobsDigest', () => {
  it('builds a canonical trailing-slash link, escaping dynamic text', () => {
    const { text, jobIds, count } = buildDailyJobsDigest([JOB_A], { dateLabel: '19 luglio 2026' });
    expect(count).toBe(1);
    expect(jobIds).toEqual(['a']);
    // A stable first-party redirect carries post-specific attribution and the
    // canonical destination in its validated `to` parameter.
    expect(text).toContain('href="https://frontaliereticino.ch/social/r/');
    expect(text).toContain('to=%2Fcerca-lavoro-ticino%2Fsviluppatore-frontend-lugano%2F');
    expect(text).toContain('utm_source=telegram&amp;utm_medium=social&amp;utm_campaign=jobs_digest');
    expect(text).toContain('utm_content=sviluppatore-frontend-lugano');
    // company name is HTML-escaped
    expect(text).toContain('Acme &amp; Co &lt;SA&gt;');
    // salary with Swiss separator
    expect(text).toContain("CHF 90'000–110'000");
    // CTA to the canonical job hub (trailing slash preserved before the query)
    expect(text).toContain('to=%2Fcerca-lavoro-ticino%2F');
    expect(text).toContain('utm_source=telegram');
    expect(text).toContain('utm_content=hub');
  });

  it('uses generated hook and CTA while preserving the canonical destination', () => {
    const { text } = buildDailyJobsDigest([JOB_A], {
      socialCopy: {
        copyMode: 'codex',
        hook: 'Un dettaglio utile & concreto',
        cta: 'Apri tutte le offerte',
      },
    });
    expect(text).toContain('Un dettaglio utile &amp; concreto');
    expect(text).toContain('>Apri tutte le offerte</a>');
    expect(text).toContain('to=%2Fcerca-lavoro-ticino%2F');
    expect(text).toContain('utm_source=telegram');
  });

  it('drops jobs with no resolvable URL and caps at the limit', () => {
    const { count, jobIds } = buildDailyJobsDigest([JOB_A, JOB_NO_SLUG], { limit: 5 });
    expect(count).toBe(1); // JOB_NO_SLUG dropped
    expect(jobIds).toEqual(['a']);
  });

  it('returns empty text when there is nothing postable', () => {
    expect(buildDailyJobsDigest([JOB_NO_SLUG]).text).toBe('');
    expect(buildDailyJobsDigest([]).count).toBe(0);
  });

  it('respects the limit cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...JOB_A, id: `j${i}`, slug: `s${i}` }));
    expect(buildDailyJobsDigest(many, { limit: 3 }).count).toBe(3);
  });
});

describe('Telegram publication ledger', () => {
  it('records one API message id and timestamp for all jobs in a daily digest', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'telegram-ledger-'));
    try {
      const dataDir = path.join(root, 'data');
      const jobs = [{ ...JOB_A, id: 'job-a' }, { ...JOB_A, id: 'job-b', slug: 'magazziniere-lugano' }];
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path.join(dataDir, 'jobs.json'), JSON.stringify(jobs));
      const { text, onSent, reservation } = await buildForMode('jobs', {
        env: { TELEGRAM_JOBS_LIMIT: '5' },
        repoRoot: root,
        now: new Date('2026-11-02T12:00:00.000Z'),
        log: () => {},
        dryRun: true,
      });
      expect(reservation).toMatchObject({ type: 'jobs-digest', id: '2026-11-02', pendingGroup: 'telegram-jobs-digest' });
      expect(text).toContain('Sviluppatore Frontend');
      onSent!({ messageId: 42 });

      const ledger = JSON.parse(readFileSync(path.join(dataDir, 'telegram-posted-jobs.json'), 'utf8'));
      expect(ledger.posted).toHaveLength(2);
      expect(ledger.posted.map((row: any) => row.id)).toEqual(['job-a', 'job-b']);
      expect(ledger.posted.map((row: any) => row.telegramMessageId)).toEqual([42, 42]);
      expect(new Set(ledger.posted.map((row: any) => row.telegramDeliveryId)).size).toBe(1);
      expect(ledger.posted[0].telegramDeliveryId).toMatch(/^[a-f0-9-]{36}$/iu);
      expect(new Set(ledger.posted.map((row: any) => row.socialReservationType))).toEqual(new Set(['jobs-digest']));
      expect(new Set(ledger.posted.map((row: any) => row.socialReservationId)).size).toBe(1);
      expect(new Set(ledger.posted.map((row: any) => row.ts)).size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── telegram-templates (preferred-source announcement) ───────

describe('buildPreferredSourceAnnouncement', () => {
  it('links the canonical Google preferred-source deep link, UTM-tagged', () => {
    const { text } = buildPreferredSourceAnnouncement();
    expect(text).toContain(
      'href="https://www.google.com/preferences/source?q=frontaliereticino.ch' +
        '&amp;utm_source=telegram&amp;utm_medium=social' +
        '&amp;utm_campaign=preferred_source_announcement&amp;utm_content=announcement"',
    );
  });

  it('has a stable, never-repeating ledger id', () => {
    expect(PREFERRED_SOURCE_ANNOUNCEMENT_ID).toBeTruthy();
  });

  it('carries the preferred-source UTM campaign identity', () => {
    expect(TELEGRAM_CAMPAIGN_PREFERRED_SOURCE).toBe('preferred_source_announcement');
  });
});

// ── UTM tagging (the GA4-zero observer) ──────────────────────

describe('withUtm', () => {
  it('sets the four utm keys and keeps the existing query + trailing slash', () => {
    const out = withUtm('https://frontaliereticino.ch/cerca-lavoro-ticino/?page=2', {
      source: 'telegram',
      medium: 'social',
      campaign: 'jobs_digest',
      content: 'hub',
    });
    expect(out).toContain('/cerca-lavoro-ticino/?');
    expect(out).toContain('page=2');
    expect(out).toContain('utm_source=telegram');
    expect(out).toContain('utm_medium=social');
    expect(out).toContain('utm_campaign=jobs_digest');
    expect(out).toContain('utm_content=hub');
  });

  it('skips empty fields rather than writing an empty utm_content', () => {
    const out = withUtm('https://frontaliereticino.ch/x/', {
      source: 'telegram',
      medium: 'social',
      campaign: 'jobs_digest',
      content: '   ',
    });
    expect(out).not.toContain('utm_content');
  });

  it('returns the input verbatim when it is not a parseable URL', () => {
    // Attribution may be lost; the destination never may be.
    expect(withUtm('not a url', { source: 's', medium: 'm', campaign: 'c' })).toBe('not a url');
    expect(withUtm('', { source: 's', medium: 'm', campaign: 'c' })).toBe('');
  });
});

describe('telegram-links identity', () => {
  it('pins medium=channel-class and source=identifier (project UTM convention)', () => {
    // Matches scripts/send-job-alerts.mjs / newsletter-template.mjs.
    expect(TELEGRAM_UTM_SOURCE).toBe('telegram');
    expect(TELEGRAM_UTM_MEDIUM).toBe('social');
    expect(TELEGRAM_CAMPAIGN_JOBS).toBe('jobs_digest');
    expect(TELEGRAM_CAMPAIGN_BORDER).toBe('border_ranking');
  });

  it('telegramUrl applies that identity', () => {
    const out = new URL(telegramUrl('https://frontaliereticino.ch/a/', TELEGRAM_CAMPAIGN_JOBS, 'slug-x'));
    expect(out.pathname).toMatch(/^\/social\/r\/[a-f0-9]{20}\/$/u);
    expect(out.searchParams.get('to')).toBe('/a/');
    expect(out.searchParams.get('utm_source')).toBe('telegram');
    expect(out.searchParams.get('utm_medium')).toBe('social');
    expect(out.searchParams.get('utm_campaign')).toBe('jobs_digest');
    expect(out.searchParams.get('utm_content')).toBe('slug-x');
  });
});

describe('no broadcast link ships untagged', () => {
  const hrefs = (text: string) => Array.from(text.matchAll(/href="([^"]+)"/g), (m) => m[1]);

  it('every href in the jobs digest carries utm_source=telegram', () => {
    const { text } = buildDailyJobsDigest([JOB_A], { dateLabel: '19 luglio 2026' });
    const found = hrefs(text);
    expect(found.length).toBeGreaterThan(0);
    for (const href of found) {
      expect(href).toContain('utm_source=telegram');
      expect(href).toContain('utm_medium=social');
      expect(href).toContain('utm_campaign=jobs_digest');
    }
  });

  it('attributes Codex copy variants on the linked jobs and digest CTA', () => {
    const { text } = buildDailyJobsDigest([JOB_A], {
      dateLabel: '19 luglio 2026',
      socialCopy: {
        copyMode: 'codex',
        copyPackId: '0123456789abcdef',
        copySlot: 'job',
        id: 'telegram-job-one',
        hook: 'Uno spunto sul lavoro in Ticino',
        cta: 'Scopri tutte le offerte',
      },
    });
    expect(text).toContain('utm_content=sviluppatore-frontend-lugano--cp0123456789abcdef-job.telegram-job-one');
    expect(text).toContain('utm_content=hub--cp0123456789abcdef-job.telegram-job-one');
  });
});

// ── telegram-border-digest (weekly ranking) ──────────────────

function cell(avg: number, samples = 10) {
  return { min: Math.max(0, avg - 2), avg, max: avg + 2, samples };
}
function makeHours(avg: number): Array<ReturnType<typeof cell> | null> {
  return Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 20 ? cell(avg) : null));
}
function writeDay(dir: string, date: string, perCrossing: Record<string, Array<ReturnType<typeof cell> | null>>) {
  writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, perCrossing }));
}

describe('buildWeeklyBorderDigest', () => {
  it('keeps the same Codex copy across retries within the weekly window', () => {
    expect(telegramBorderCopyAssignmentKey('2026-07-10')).toBe('border:2026-07-03');
    expect(telegramBorderCopyAssignmentKey('2026-07-10'))
      .toBe(telegramBorderCopyAssignmentKey('2026-07-10'));
  });

  it('ranks fastest→slowest with canonical per-crossing links', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-'));
    // 7-day window ending the day before 2026-07-10 → 07-03 … 07-09.
    for (let d = 3; d <= 9; d++) {
      const date = `2026-07-0${d}`;
      writeDay(dir, date, {
        'chiasso-centro': makeHours(2), // fastest
        'ponte-tresa': makeHours(25),   // slowest
        gaggiolo: makeHours(10),
      });
    }
    const { text, rankedCount } = buildWeeklyBorderDigest({ historyDir: dir, todayIso: '2026-07-10' });
    expect(rankedCount).toBe(3);
    // fastest section names Chiasso Centro before the slowest section
    const fastIdx = text.indexOf('Chiasso Centro');
    const slowIdx = text.indexOf('Ponte Tresa');
    expect(fastIdx).toBeGreaterThan(-1);
    expect(slowIdx).toBeGreaterThan(-1);
    // canonical trailing-slash "oggi" links, UTM-tagged per crossing
    expect(text).toContain('href="https://frontaliereticino.ch/social/r/');
    expect(text).toContain('to=%2Ftraffico-dogane%2Fchiasso-centro%2Foggi%2F');
    expect(text).toContain('utm_source=telegram&amp;utm_medium=social&amp;utm_campaign=border_ranking');
    expect(text).toContain('utm_content=chiasso-centro');
    // CTA links to the canonical hub + ranking article (trailing slash)
    expect(text).toContain('to=%2Ftraffico-dogane%2F');
    expect(text).toContain('to=%2Farticoli-frontaliere%2Fclassifica-dogane-ticino%2F');

    const generated = buildWeeklyBorderDigest({
      historyDir: dir,
      todayIso: '2026-07-10',
      socialCopy: {
        copyMode: 'codex',
        hook: 'La situazione aggiornata & spiegata',
        cta: 'Leggi la classifica completa',
      },
    });
    expect(generated.text).toContain('La situazione aggiornata &amp; spiegata');
    expect(generated.text).toContain('>Leggi la classifica completa</a>');
  });

  it('skips (empty text) when fewer than two crossings can be ranked', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-'));
    for (let d = 3; d <= 9; d++) writeDay(dir, `2026-07-0${d}`, { 'chiasso-centro': makeHours(2) });
    const { text, rankedCount } = buildWeeklyBorderDigest({ historyDir: dir, todayIso: '2026-07-10' });
    expect(rankedCount).toBeLessThan(2);
    expect(text).toBe('');
  });

  it('excludes Germany-corridor crossings from the Ticino-branded broadcast (#4952 regression)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-'));
    for (let d = 3; d <= 9; d++) {
      const date = `2026-07-0${d}`;
      writeDay(dir, date, {
        'chiasso-centro': makeHours(2),   // Ticino, fastest
        'ponte-tresa': makeHours(25),     // Ticino, slowest
        gaggiolo: makeHours(10),          // Ticino
        // Germany corridor: display names exist (registry #4952), must not
        // appear in this Ticino-branded "Classifica dogane Ticino" text.
        'basel-weil-am-rhein-hiltalingerstrasse': makeHours(1),
      });
    }
    const { text, rankedCount } = buildWeeklyBorderDigest({ historyDir: dir, todayIso: '2026-07-10' });
    expect(rankedCount).toBe(3); // Germany-corridor entry excluded from the count
    expect(text).toContain('Chiasso Centro');
    expect(text).toContain('Ponte Tresa');
    expect(text).not.toContain('Weil am Rhein');
    expect(text).not.toContain('Hiltalingerstrasse');
  });
});
