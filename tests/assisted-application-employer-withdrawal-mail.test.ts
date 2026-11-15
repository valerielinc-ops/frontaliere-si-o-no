// Owner decision 2026-11-11: the employer's own authenticated e-mail on the order's alias is proof that it
// withdrew the posting. Every order, name, address and posting here is invented.
import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { ensureOrderAlias } = await import('../functions/src/assistedApplicationAlias.js');
const { handleAssistedApplicationInbound, processAssistedApplicationInbound } = await import('../functions/src/assistedApplicationInbound.js');
const { HELD_REMINDERS_AFTER_MS } = await import('../functions/src/assistedApplicationFlow.js');

const ORDER = 'order_WITHDRAWN1';
const ORDER_PATH = `assisted_applications/${ORDER}`;
const FLOW_PATH = `${ORDER_PATH}/automation/flow`;
const RUN_KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'worker-secret';
const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
const WITHDRAWN = 'Guten Tag\n\nLeider müssen wir Ihnen mitteilen, dass die Stelle Testrolle zurückgezogen wurde.\n\nFreundliche Grüsse\nMuster AG';

function fakeBucket() {
  const files = new Map<string, string>();
  return {
    file: (key: string) => ({
      async save(content: string) { files.set(key, String(content)); },
      async download() { return [Buffer.from(files.get(key) || '')]; },
    }),
  };
}

const cf = () => {
  const rules = new Map<string, string>();
  return {
    async createRule(address: string) { const id = `rule-${rules.size + 1}`; rules.set(id, address); return id; },
    async deleteRule(id: string) { rules.delete(id); },
  };
};

let sequence = 0;
const mail = ({ text = WITHDRAWN, authenticated = true } = {}) => Buffer.from([
  `Message-ID: <withdrawn-${sequence++}@example.test>`,
  'From: Muster AG <jobs@stelle.example.test>',
  ...(authenticated ? ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=stelle.example.test'] : []),
  `Subject: =?utf-8?B?${Buffer.from('Ihre Bewerbung', 'utf8').toString('base64')}?=`,
  'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(text, 'utf8').toString('base64'), '',
].join('\r\n'), 'latin1');

const model = {
  category: 'other', summaryIt: 'Annuncio ritirato.', summaryCandidate: 'Il datore ha ritirato l’annuncio.',
  interviewWhen: '', requestedDocuments: [], verificationCode: '', verificationUrl: '', needsReply: false,
};

async function deliver(flow: any, raw: Buffer) {
  const store = createMemoryFirestore({
    [ORDER_PATH]: { paymentStatus: 'paid', submissionStatus: 'awaiting_upload', automationState: flow.state, locale: 'de', companyName: 'Muster AG', jobTitle: 'Testrolle', applicantEmail: 'candidate@example.test' },
    [FLOW_PATH]: flow,
    [`${ORDER_PATH}/ai_drafts/current`]: { status: 'ready', round: 1, questions: [{ id: 'q1', required: true }] },
  });
  const alias = await ensureOrderAlias({ db: store.db, orderId: ORDER, cf: cf() });
  const bucket = fakeBucket();
  const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'maileroo' }] }));
  const accepted = await handleAssistedApplicationInbound({
    method: 'POST', rawBody: raw,
    get: (name: string) => ({ 'x-stop-secret': SECRET, 'x-envelope-to': alias.address } as Record<string, string>)[name],
  }, { db: store.db, bucket, secret: SECRET, runKey: RUN_KEY, nowMs: T0 });
  const effects: any[] = [];
  const processed = await processAssistedApplicationInbound({
    db: store.db, bucket, orderId: ORDER, messageId: accepted.body.accepted, runKey: RUN_KEY,
    classify: vi.fn(async () => model), sendCascade, runEffect: async (context: any) => { effects.push(context.effect); return { ok: true }; }, nowMs: T0,
  });
  return { store, processed, effects, sendCascade };
}

const waiting = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: ['question:q1'], heldSince: T0 - 48 * 3600_000, heldNudges: 1, reminderAt: T0 - 48 * 3600_000 + HELD_REMINDERS_AFTER_MS[1], deadlineAt: null };

describe('the employer\'s e-mail that withdraws the posting', () => {
  it('withdraws a waiting application with the mail as proof without forwarding a non-actionable notice', async () => {
    const { store, processed, effects, sendCascade } = await deliver(waiting, mail());
    expect(processed).toMatchObject({ ok: true, postingWithdrawn: true });
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'withdrawn', withdrawnReason: 'posting_withdrawn_by_employer', withdrawalEvidence: { kind: 'employer_mail', source: 'employer_mail', at: T0 } });
    expect(store.read(ORDER_PATH)).toMatchObject({ submissionStatus: 'withdrawn', withdrawalReason: 'posting_withdrawn_by_employer' });
    expect(effects).toEqual([{ type: 'email', kind: 'candidate_posting_withdrawn' }]);
    expect(sendCascade).not.toHaveBeenCalled();
  });

  it('changes nothing from an unauthenticated sender', async () => {
    const { store, processed, effects } = await deliver(waiting, mail({ authenticated: false }));
    expect(processed.postingWithdrawn).toBeUndefined();
    expect(store.read(FLOW_PATH)).toMatchObject({ state: 'candidate_review', heldBy: ['question:q1'] });
    expect(effects).toEqual([]);
  });

  it('changes nothing for a round that did not wait for the candidate, nor for a filled post', async () => {
    const reviewing = { state: 'candidate_review', round: 1, shownRounds: [1], heldBy: [], deadlineAt: T0 + 3600_000 };
    expect((await deliver(reviewing, mail())).store.read(FLOW_PATH)).toMatchObject({ state: 'candidate_review' });
    expect((await deliver(waiting, mail({ text: 'Leider wurde die Stelle bereits besetzt.' }))).store.read(FLOW_PATH)).toMatchObject({ state: 'candidate_review', heldBy: ['question:q1'] });
  });
});
