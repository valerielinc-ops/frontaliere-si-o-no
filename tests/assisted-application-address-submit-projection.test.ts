import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, it } from 'vitest';
import { buildFillKit } from '../functions/src/assistedApplicationFillKit.js';
import { candidateAnswerForField } from '../scripts/assisted-application/lib/portal/plan.mjs';
import { portalQuestionId } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { submitApplication } from '../scripts/assisted-application/lib/submit.mjs';

const extension = new URL('../scripts/assisted-application/extension/', import.meta.url);

describe('submit preserves raw candidate provenance through automatic projections', () => {
  it.each([
    ['Employer', undefined, ''], ['Employer', '', ''],
    ['Employer', 'Lugano', 'Lugano'], ['Personal information', 'Lugano', 'Lugano'],
  ])('keeps %s with raw answer %s bound through submit, kit and fill', async (owner, value, expected) => {
    const dom = new JSDOM(`<form><h2>Personal information</h2><fieldset aria-label="${owner}"><label for="city">City</label><input id="city" name="city" autocomplete="address-level2" required></fieldset></form>`, {
      url: 'https://jobs.example.test/apply/', runScripts: 'outside-only',
    });
    try {
      const w = dom.window;
      Object.defineProperty(w.HTMLElement.prototype, 'getBoundingClientRect', { value: () => ({ width: 100, height: 24 }) });
      Object.defineProperty(w, 'CSS', { value: { escape: (text: string) => text } });
      w.eval(readFileSync(new URL('runner-fields.js', extension), 'utf8'));
      const field = (w as any).CompilaRunnerFields().fields.find((entry: any) => entry.name === 'city');
      const question = { ...field, question: field.label, source: 'portal', type: 'text' };
      question.id = portalQuestionId(question);
      const orderId = 'test_owned_submit';
      const letterKey = `assisted-application-uploads/${orderId}/letter.pdf`;
      const order = {
        jobId: 'synthetic-job', jobUrl: 'https://jobs.lever.co/example/1', jobTitle: 'Example engineer',
        companyName: 'Example', applicantName: 'Test User', applicantEmail: 'test@example.test', locale: 'it',
        cvStorageKey: `assisted-application-uploads/${orderId}/cv.pdf`,
      };
      const draft = {
        round: 1, status: 'ready', language: 'it',
        profile: { fullName: 'Test User', address: { city: 'Como', country: 'Italia' } },
        coverLetter: { text: 'Gentili Signori. Cordiali saluti.' }, coverLetterPdfKey: letterKey,
        applicationEmail: { subject: 'Candidatura', body: 'CV e lettera in allegato.' },
        factSources: { text: 'Test User Como Italia', posting: 'Example engineer Example', order: '' },
        questions: [question], formAnswers: [],
        channel: { type: 'lever', applyUrl: 'https://jobs.lever.co/example/1/apply' },
        job: { title: 'Example engineer', applyUrl: 'https://jobs.lever.co/example/1/apply' },
      };
      const flow = { answers: value === undefined ? {} : { [question.id]: value } };
      const raw = JSON.stringify(flow);
      const files = new Map([[letterKey, Buffer.from('%PDF-1.4 synthetic')]]);
      const bucket = { file: (key: string) => ({
        save: async (content: Buffer) => { files.set(key, Buffer.from(content)); },
        download: async () => [files.get(key)], delete: async () => { files.delete(key); },
      }) };
      let candidate: any;
      const event = await submitApplication({
        order, orderId, flow, draft, bucket, cvBuffer: Buffer.from('%PDF-1.4 synthetic CV'), cvType: 'pdf',
        runKey: Buffer.alloc(32, 7), log: () => {},
        codex: async () => { throw new Error('unexpected model call'); },
        sendCascade: async () => { throw new Error('unexpected email send'); },
        fetchImpl: async (url: string) => url.startsWith('https://cdn.frontaliereticino.ch/data/job-detail/')
          ? new Response(JSON.stringify({ description: 'Example engineer at Example. '.repeat(20), applyUrl: draft.job.applyUrl, titleByLocale: { it: 'Example engineer' }, addressLocality: 'Lugano' }), { headers: { 'content-type': 'application/json' } })
          : new Response(`<main><p>${'Example engineer at Example. '.repeat(20)}</p><button>Apply now</button></main>`, { headers: { 'content-type': 'text/html' } }),
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        portalRunner: async (ctx: any) => {
          candidate = ctx.candidate;
          return { event: { type: 'submit_handoff', reason: 'synthetic_no_submission' }, evidence: { steps: [] } };
        },
      });
      assert.ok(candidate, JSON.stringify(event));
      assert.equal(JSON.stringify(flow), raw);
      assert.equal(candidate.portalQuestionsAnswered.some((answer: any) => answer.source === 'answers' && answer.current && answer.answer === 'Como'), false);
      assert.equal(candidateAnswerForField(candidate, field)?.value || '', expected);
      const kit = buildFillKit({ orderId, order, draft: { ...draft, portalAnswers: { answers: candidate.portalQuestionsAnswered } }, flow });
      for (const file of ['apply-control.js', 'filler.js']) w.eval(readFileSync(new URL(file, extension), 'utf8'));
      await (w as any).CompilaCandidatura.fillPage(w.document, kit, { getFile: async () => null, attempts: new WeakMap(), uploaded: new Set() });
      assert.equal((w.document.getElementById('city') as HTMLInputElement).value, expected);
    } finally {
      dom.window.close();
    }
  });
});
