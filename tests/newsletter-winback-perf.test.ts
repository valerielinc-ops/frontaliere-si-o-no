// @ts-nocheck
/**
 * Winback (perf-plan email senders, F1): il timestamp di stadio si scrive per ogni invio
 * confermato (onSent, a micro-batch), non a fine stadio; throttle come la jobalert,
 * sempre su Maileroo. Nessuna rete e nessun invio.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBatchedStateWriter } from '../scripts/lib/batched-state-writes.mjs';

const ROOT = path.resolve(__dirname, '..');

vi.mock('../scripts/lib/email-cascade.mjs', () => ({
  sendEmailCascade: vi.fn(async (items, opts) => {
    globalThis.__cascadeCall = { items, opts };
    return globalThis.__cascadeBehaviour(items, opts);
  }),
  logProviderSummary: vi.fn(),
}));

const mkItem = (n) => ({ ref: { path: `newsletter_subscribers/u${n}` }, email: `u${n}@example.test`, locale: 'it', interest: 'general' });

beforeEach(() => {
  globalThis.__cascadeCall = undefined;
  globalThis.__cascadeBehaviour = async (items) => ({ sent: items.map((i) => ({ ...i })), failed: [] });
});

describe('F1: throttle e provider', () => {
  it('stage 1 e stage 2 usano il throttle della jobalert e restano su Maileroo', async () => {
    const { sendStage1, sendStage2 } = await import('../scripts/newsletter-winback-campaign.mjs');
    await sendStage1([mkItem(1)]);
    expect(globalThis.__cascadeCall.opts).toMatchObject({
      concurrency: 4, delayMs: 100, adaptiveThrottle: { stepMs: 100, maxDelayMs: 1000 }, forceProvider: 'maileroo',
    });
    await sendStage2([mkItem(2)]);
    expect(globalThis.__cascadeCall.opts).toMatchObject({ concurrency: 4, delayMs: 100, forceProvider: 'maileroo' });
  });

  it('senza onConfirmed la cascade non riceve un onSent (comportamento di chiamanti vecchi)', async () => {
    const { sendStage1 } = await import('../scripts/newsletter-winback-campaign.mjs');
    await sendStage1([mkItem(1)]);
    expect(globalThis.__cascadeCall.opts.onSent).toBeUndefined();
  });
});

describe('F1: timestamp di stadio per ogni invio confermato', () => {
  it('onConfirmed gira per ogni invio confermato, e non per i fallimenti', async () => {
    const { sendStage1 } = await import('../scripts/newsletter-winback-campaign.mjs');
    const items = [1, 2, 3].map(mkItem);
    globalThis.__cascadeBehaviour = async (list, opts) => {
      const sent = []; const failed = [];
      for (const item of list) {
        const payloadItem = { payload: { to: [item.recipient.email] }, recipient: { email: item.recipient.email }, meta: {} };
        if (item.recipient.email === 'u2@example.test') { failed.push({ ...payloadItem, error: 'rejected', ambiguousDelivery: false }); continue; }
        sent.push(payloadItem);
        await opts.onSent(payloadItem, { provider: 'maileroo', messageId: 'm' });
      }
      return { sent, failed };
    };
    const stamped = [];
    const failedEmails = await sendStage1(items, { onConfirmed: async (w) => { stamped.push(w.email); } });
    expect(stamped.sort()).toEqual(['u1@example.test', 'u3@example.test']);
    expect([...failedEmails]).toEqual(['u2@example.test']);
  });

  it('crash a meta stadio: gli invii gia confermati hanno il timestamp, quindi non si rimandano', async () => {
    const { sendStage1 } = await import('../scripts/newsletter-winback-campaign.mjs');
    const items = [1, 2, 3, 4, 5].map(mkItem);
    const docs = new Map();
    const db = {
      batch: () => {
        const sets = [];
        return { set: (ref, data) => sets.push({ ref, data }), commit: async () => { for (const s of sets) docs.set(s.ref.path, { ...(docs.get(s.ref.path) || {}), ...s.data }); } };
      },
    };
    const writer = createBatchedStateWriter({ getDb: async () => db, maxItems: 2, windowMs: 1 });
    globalThis.__cascadeBehaviour = async (list, opts) => {
      let confirmed = 0;
      for (const item of list) {
        if (confirmed === 3) throw new Error('runner lost');
        const payloadItem = { payload: { to: [item.recipient.email] }, recipient: { email: item.recipient.email }, meta: {} };
        await opts.onSent(payloadItem, { provider: 'maileroo', messageId: 'm' });
        confirmed += 1;
      }
      return { sent: [], failed: [] };
    };
    await expect(sendStage1(items, {
      onConfirmed: (w) => writer.write([{ ref: w.ref, data: { dormant_winback_stage1_sent_at: 'ts' }, options: { merge: true } }]),
    })).rejects.toThrow('runner lost');
    // Three sends confirmed before the crash: three stamps, none lost.
    expect([...docs.keys()].sort()).toEqual(['newsletter_subscribers/u1', 'newsletter_subscribers/u2', 'newsletter_subscribers/u3']);
    for (const value of docs.values()) expect(value.dormant_winback_stage1_sent_at).toBe('ts');
  });

  it('il main passa il timestamp a onConfirmed e non riscrive piu i confermati a fine stadio', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/newsletter-winback-campaign.mjs'), 'utf8');
    expect(source).toContain("onConfirmed: stampStage('dormant_winback_stage1_sent_at')");
    expect(source).toContain("onConfirmed: stampStage('dormant_winback_stage2_sent_at')");
    expect(source).not.toMatch(/commitInChunks\(db, confirmed/);
    expect(source).toContain('createBatchedStateWriter');
  });
});

describe('F1/F2: telemetria e workflow', () => {
  it('WINBACK_METRICS ha le fasi scan/apply/send', async () => {
    const { WINBACK_PHASES, winbackMetrics } = await import('../scripts/newsletter-winback-campaign.mjs');
    expect([...WINBACK_PHASES]).toEqual(['scan', 'apply', 'send']);
    expect(winbackMetrics.tag).toBe('WINBACK');
  });

  it('i follow-up di conferma usano il throttle condiviso con i pavimenti della cascade base', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/newsletter-confirmation-followups.mjs'), 'utf8');
    expect(source).toContain('bulkOptionsFor(baseEmailCascade, {');
    expect(source).not.toMatch(/await sendEmailCascade\(items, \{\s*onSent/);
  });
});
