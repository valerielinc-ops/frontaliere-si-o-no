import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { employerReceiptAuthority } from '../functions/src/assistedApplicationInbound.js';
import { parseMimeMessage } from '../functions/src/lib/mimeMessage.js';
import { submissionSlotHash, submissionAttemptHash } from '../functions/src/lib/submissionReceiptContract.js';
const ID = 'dual_ack_fixture', ROOT = 'assisted_applications/' + ID, ALIAS = 'c-abcdefghjk', MESSAGE = 'native-inbox-123', OUTBOUND = '<aa-original@candidature.frontaliereticino.ch>';
const bytes = Buffer.from(['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=employer.example', 'From: Recruitment <hr@employer.example>', `In-Reply-To: ${OUTBOUND}`, 'Subject: Your application', 'Content-Type: text/plain', '', 'We have received your application.'].join('\r\n'));
async function fixture(modern = false) {
    let clock = 1000;
    const order = { consentVersion: 'assisted-application-v2', consentedAt: 1, paymentStatus: 'paid', submissionStatus: 'in_progress', cvUploadedAt: 1, jobId: 'synthetic-job', jobUrl: 'https://employer.example/job' };
    const store = createMemoryFirestore({ [ROOT]: order, [ROOT + '/automation/flow']: { round: 1, state: modern ? 'submitting' : 'owner_takeover', heldBy: modern ? [] : ['email_ambiguous'], dispatch: { mode: 'submit', round: 1, requestedAt: 400 } }, [ROOT + '/ai_drafts/current']: { round: 1, status: 'ready', questions: [], coverLetter: 'Approved synthetic letter' }, ['assisted_application_aliases/' + ALIAS]: { orderId: ID } });
    const emailHandoff = { messageId: OUTBOUND, recipient: 'jobs@employer.example', slotHash: submissionSlotHash({ orderId: ID, order }) };
    const orderRef = store.db.collection('assisted_applications').doc(ID);
    let record: any, guard: any, photo: any;
    if (modern) {
        guard = submissionGuard(store.db, ID, 1, { receiptClock: () => clock, answerSourceGuard: { fingerprint: 'e'.repeat(64), async assertInTransaction(tx: any) { await tx.get(orderRef); } } });
        await guard.claim('email', 500);
        photo = { at: 500, channel: 'email', files: [], submissionAttempt: guard.attemptBinding() };
        await orderRef.collection('ai_drafts').doc('current').set({ sentAttempt: photo }, { merge: true });
        await guard.markEmailSending(600, { emailHandoff });
        record = store.read(ROOT + '/automation/submission').r1;
        clock = record.startedAt + 100;
    }
    else {
        record = { state: 'sending', channel: 'email', startedAt: 500, clickedAt: null, emailHandoff };
        await orderRef.collection('automation').doc('submission').set({ r1: record });
    }
    const claimed = { receivedAt: clock, rawSha256: createHash('sha256').update(bytes).digest('hex'), envelopeAlias: ALIAS, rawKey: 'assisted-application-uploads/' + ID + '/inbox-original.eml.json.enc' };
    await orderRef.collection('inbox').doc(MESSAGE).set(claimed);
    const factory = employerReceiptAuthority({ db: store.db, orderId: ID, messageId: MESSAGE, claimed, message: parseMimeMessage(bytes), rawBytes: bytes });
    assert(factory);
    const authority = await factory({ record: structuredClone(record), round: 1 });
    assert(authority);
    const outcome = submissionGuard(store.db, ID, 1, { outcomeAuthority: authority, receiptClock: () => clock });
    return { store, orderRef, authority, outcome, photo, get clock() { return clock; }, set clock(v) { clock = v; } };
}
describe('verified employer outcome writer', () => {
    it('preserves modern and historical authority across races without granting a new send', async () => {
        const rows: string[] = [];
        for (const modern of [false, true]) {
            const p = await fixture(modern);
            const result = await p.outcome.markSent({ channel: 'email', sent: modern ? undefined : { private: 'UNATTESTED-PHOTO' } }, p.clock);
            assert.equal(result.minimal, false);
            const record = p.store.read(ROOT + '/automation/submission').r1;
            assert.equal(record.state, 'sent');
            if (modern) {
                assert.equal(record.attemptId, p.photo.submissionAttempt.id);
                assert.deepEqual(record.sent.files, p.photo.files);
            }
            else {
                assert.equal(record.sent, undefined);
                assert.equal(record.provenance, 'legacy_employer_ack');
                assert.equal(record.originalRecordHash, p.authority.proof.recordHash);
                const doc = p.store.read(ROOT + '/submission_receipts/' + record.receiptBindingHash);
                assert.equal(doc.kind, 'legacy_employer_ack');
                assert.equal(doc.leftAt, 500);
                assert.equal(doc.providerReceivedAt, p.clock);
                assert(!JSON.stringify(doc).includes('employer.example'));
            }
            rows.push(modern ? 'actualModernARM_MIMEFactoryWriterBoundPhoto' : 'historicalSending_ActualMIMEFactoryWriterNoPhotoGraft');
            const dup = await p.outcome.markSent({ unexpected: 'late' }, p.clock + 1);
            assert.equal(dup.alreadySent, true);
        }
        for (const change of ['retarget', 'round', 'record', 'alias', 'noop_callback', 'future_clock']) {
            const p = await fixture();
            let outcome = p.outcome;
            if (change === 'retarget')
                p.store.read(ROOT).jobId = 'different';
            if (change === 'round')
                p.store.read(ROOT + '/automation/flow').round = 2;
            if (change === 'record')
                p.store.read(ROOT + '/automation/submission').r1.startedAt = 499;
            if (change === 'alias')
                p.store.read('assisted_application_aliases/' + ALIAS).orderId = 'different';
            if (change === 'noop_callback')
                outcome = submissionGuard(p.store.db, ID, 1, { outcomeAuthority: { ...p.authority, assertInTransaction: async () => undefined }, receiptClock: () => p.clock });
            if (change === 'future_clock')
                p.clock = 999;
            await assert.rejects(outcome.markSent({}, p.clock), /authority_changed/);
            assert.equal(p.store.read(ROOT + '/automation/submission').r1.state, 'sending');
            assert.equal(p.store.list(ROOT + '/submission_receipts/').length, 0);
            rows.push('rejected_' + change);
        }
        for (const modern of [false, true]) {
            const p = await fixture(modern);
            p.store.read(ROOT).retentionPurgingAt = p.clock;
            const result = await p.outcome.markSent({ PII: 'do-not-restore' }, p.clock);
            assert.equal(result.minimal, true);
            assert.equal(p.store.read(ROOT + '/automation/submission').r1.state, 'sending');
            for (const doc of p.store.list(ROOT + '/submission_receipts/'))
                assert(!JSON.stringify(p.store.read(doc)).includes('do-not-restore'));
            rows.push(modern ? 'modernEmbargoMinimumOnly' : 'legacyEmbargoMinimumOnly');
        }
        {
            const p = await fixture();
            p.store.docs.delete(ROOT + '/automation/submission');
            p.store.read(ROOT).retentionPurgedAt = p.clock;
            await assert.rejects(p.outcome.markSent({}, p.clock), /authority_changed/);
            assert.equal(p.store.list(ROOT + '/submission_receipts/').length, 0);
            rows.push('missingHistoricalLedgerNoFirstProof');
        }
        {
            const p = await fixture();
            await p.outcome.markSent({}, p.clock);
            p.store.docs.delete(ROOT + '/automation/submission');
            p.store.docs.delete(ROOT + '/automation/flow');
            p.store.docs.delete(ROOT + '/ai_drafts/current');
            p.store.docs.delete(ROOT + '/inbox/' + MESSAGE);
            p.store.read(ROOT).retentionPurgedAt = p.clock;
            assert.equal((await p.outcome.markSent({ PII: 'never' }, p.clock + 1)).minimal, true);
            assert.equal(p.store.read(ROOT + '/automation/submission'), undefined);
            assert.equal(p.store.read(ROOT + '/ai_drafts/current'), undefined);
            rows.push('existingLegacyMinimumSurvivesPurgeWithoutRecreation');
        }
        {
            const p = await fixture(true);
            const forced = submissionGuard(p.store.db, ID, 1, { outcomeAuthority: { ...p.authority, kind: 'legacy_employer_ack' }, receiptClock: () => p.clock });
            await assert.rejects(forced.markSent({}, p.clock), /authority_changed/);
            assert.equal(p.store.read(ROOT + '/automation/submission').r1.state, 'sending');
            rows.push('modernNeverDowngradedToLegacy');
        }
        for (const changed of ['handoff', 'frameHash', 'attempt']) {
            const p = await fixture(true);
            const record = p.store.read(ROOT + '/automation/submission').r1, frame = p.store.read(ROOT + '/submission_receipts/' + submissionAttemptHash(record.attemptId));
            if (changed === 'handoff')
                record.emailHandoff.recipient = 'different@employer.example';
            if (changed === 'frameHash')
                frame.emailHandoffHash = 'a'.repeat(64);
            if (changed === 'attempt')
                record.attemptId = '00000000-0000-4000-8000-000000000009';
            await assert.rejects(p.outcome.markSent({}, p.clock), /authority_invalid|claim_changed/);
            assert.equal(p.store.read(ROOT + '/automation/submission').r1.state, 'sending');
            rows.push('modernRejects_' + changed);
        }
        {
            const p = await fixture();
            const bad = { ...p.authority, assertInTransaction: async () => ({ ...p.authority.proof, providerReceivedAt: p.clock + 1 }) };
            const guard = submissionGuard(p.store.db, ID, 1, { outcomeAuthority: bad, receiptClock: () => p.clock + 1 });
            await assert.rejects(guard.markSent({}, p.clock + 1), /authority_changed/);
            assert.equal(p.store.list(ROOT + '/submission_receipts/').length, 0);
            rows.push('callbackMustReturnExactCapturedProof');
        }
        {
            const p = await fixture(true);
            await p.outcome.markSent({}, p.clock);
            p.store.docs.delete(ROOT + '/automation/submission');
            p.store.docs.delete(ROOT + '/automation/flow');
            p.store.docs.delete(ROOT + '/ai_drafts/current');
            p.store.docs.delete(ROOT + '/inbox/' + MESSAGE);
            p.store.read(ROOT).retentionPurgedAt = p.clock;
            assert.equal((await p.outcome.markSent({ PII: 'never' }, p.clock + 1)).minimal, true);
            assert.equal(p.store.read(ROOT + '/automation/submission'), undefined);
            assert.equal(p.store.read(ROOT + '/ai_drafts/current'), undefined);
            rows.push('existingModernMinimumSurvivesPurgeWithoutCallbackOrRecreation');
        }
        {
            const p = await fixture(true);
            p.store.docs.delete(ROOT + '/automation/submission');
            p.store.docs.delete(ROOT + '/inbox/' + MESSAGE);
            p.store.read(ROOT).retentionPurgedAt = p.clock;
            await assert.rejects(p.outcome.markSent({}, p.clock), /authority_invalid/);
            const frame = p.store.read(p.store.list(ROOT + '/submission_receipts/')[0]);
            assert.equal(frame.minimalReceipt, undefined);
            rows.push('missingModernLedgerNoFirstExternalProof');
        }
        assert.equal(rows.length, 19);
    });
});
