import { describe, expect, it } from 'vitest';
import { guardAgentStep, AGENT_SCHEMA } from '../scripts/assisted-application/lib/portal/agent.mjs';
import { learnedButton, normalizeLabel, portalKnowledgeStore, PORTAL_KNOWLEDGE_COLLECTION } from '../scripts/assisted-application/lib/portal/knowledge.mjs';
import { anonymizePath, stopReportFrom } from '../scripts/assisted-application/lib/portal/portal.mjs';
import { CONFIRM_RE, REFUSED_RE } from '../scripts/assisted-application/lib/portal/fill.mjs';
import { candidateValues, redactStopReport, stopIssue } from '../scripts/assisted-application/lib/portal/stop-report.mjs';
import { createMemoryFirestore } from './helpers/memoryFirestore';

// Owner decision 2026-10-01: the runner corrects itself the way JOIN's «Conferma e applica» was fixed (#10725).
describe('portal runner self-correction', () => {
  it('level 1: the agent may name the last page’s send button; the guard keeps only a real ref', () => {
    expect(Object.keys(AGENT_SCHEMA.properties)).toContain('submitRef');
    const turn = (submitRef: string) => ({ status: 'done', reason: '', advanceRef: '', submitRef, actions: [], questions: [] });
    expect(guardAgentStep(turn('e42'), null).submitRef).toBe('e42');
    expect(guardAgentStep(turn('button:has-text("Invia")'), null).submitRef).toBe('');
  });

  it('level 2: remembers a portal’s labels after a confirmed submission and recognises them next time', async () => {
    const { db, read } = createMemoryFirestore();
    const store = portalKnowledgeStore({ db });
    expect(await store.load('join.com')).toEqual({ finalLabels: [], nextLabels: [] });
    await store.learn('join.com', { finalLabel: 'Conferma e  applica', nextLabels: ['Salva e prosegui'] });
    await store.learn('JOIN.com', { finalLabel: 'Conferma e applica' });
    const known = await store.load('join.com');
    expect(known).toEqual({ finalLabels: ['conferma e applica'], nextLabels: ['salva e prosegui'] });
    expect(read(`${PORTAL_KNOWLEDGE_COLLECTION}/join.com`)).toMatchObject({ confirmedSubmissions: 2 });
    // Exact label only, enabled only.
    const buttons = [{ id: 'b1', text: 'Conferma e applica filtro' }, { id: 'b2', text: ' Conferma e applica ', disabled: true }, { id: 'b3', text: 'Conferma e applica' }];
    expect(learnedButton(buttons, known.finalLabels)).toEqual({ id: 'b3', text: 'Conferma e applica' });
    expect(normalizeLabel('  A   b ')).toBe('a b');
  });

  it('level 3: the stop report names the page without the employer or the posting', () => {
    expect(anonymizePath('https://join.com/companies/acme-sagl/16772222/apply/review?step=3#x')).toBe('/companies/*/*/apply/review');
    expect(anonymizePath('https://acme.wd3.myworkdayjobs.com/de-DE/External/job/Lugano/Pflege_R12345/apply')).toBe('/de-DE/External/job/*/*/apply');
    expect(anonymizePath('not a url')).toBe('');
    const report = stopReportFrom({
      url: 'https://join.com/companies/acme/16772222/apply/review',
      reason: 'portal_needs_candidate',
      step: 10,
      seen: { buttons: [{ text: 'Indietro' }, { text: 'Conferma e applica' }, { text: 'Indietro' }], fields: [{ label: 'Note', kind: 'textarea', required: false, value: 'x' }], errors: [] },
      agent: [{ hint: 'no_form_controls', status: 'done', rounds: [] }],
    });
    expect(report).toEqual({
      host: 'join.com', path: '/companies/*/*/apply/review', reason: 'portal_needs_candidate', step: 10,
      buttons: ['Indietro', 'Conferma e applica'], fields: [{ label: 'Note', kind: 'textarea', required: false }], errors: [],
      agent: [{ hint: 'no_form_controls', status: 'done' }],
    });
  });

  it('level 3: strikes every value of the candidate out before the public issue', () => {
    const values = candidateValues([['Maria Rossi', 'maria.rossi@example.com', '1986-09-12'], ['c-abcdefghjk@candidature.example'], ['+41 79 123 45 67']]);
    const clean = redactStopReport({
      host: 'jobs.example', path: '/apply', reason: 'portal_needs_candidate', step: 3,
      buttons: ['Profilo di Maria', 'Invia'],
      fields: [{ label: 'Rossi, conferma la data 12.09.1986', kind: 'text', required: true }],
      errors: ['Indirizzo maria.rossi@example.com già usato', 'Chiama +41 79 123 45 67', 'Scrivi a altro@example.org'],
    }, values);
    const text = JSON.stringify(clean);
    for (const value of ['Maria', 'Rossi', 'maria.rossi', '12.09.1986', '123 45 67', 'altro@example.org']) expect(text).not.toContain(value);
    expect(clean.buttons).toEqual(['Profilo di [dato del candidato]', 'Invia']);

    const issue = stopIssue(clean, 'https://github.com/o/r/actions/runs/1');
    expect(issue.title).toBe('[portal-stop] jobs.example: pagina non superata su /apply');
    expect(issue.dedupKey).toBe(issue.title);
    expect(issue.description).toContain('`Invia`');
    expect(issue.description).toContain('onBeforeSubmit');
    expect(issue.description).not.toContain('Maria');
  });

  // JOIN run 36846326334: after «Conferma e applica» the portal said it did not send.
  it('reads a portal’s own refusal as a refusal, never as a confirmation', () => {
    for (const text of [
      'Non siamo riusciti a inviare la tua candidatura. Riprova.',
      'We couldn’t submit your application',
      "We couldn't send your application",
      'Ihre Bewerbung konnte nicht gesendet werden.',
      "Nous n'avons pas pu envoyer votre candidature.",
    ]) {
      expect(REFUSED_RE.test(text)).toBe(true);
      expect(CONFIRM_RE.test(text)).toBe(false);
    }
    expect(REFUSED_RE.test('Grazie per la tua candidatura, è stata inviata.')).toBe(false);
  });
});
