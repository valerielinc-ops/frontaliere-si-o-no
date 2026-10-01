import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTestPortal, resetTestPortalLimit, TEST_PORTAL_COLLECTION } from '../functions/src/assistedApplicationTestPortal.js';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE } from '../scripts/assisted-application/lib/portal/fill.mjs';

const TOKEN = 'test-portal-token-0123456789';
const PERSONAL = { firstName: 'Luigi', lastName: 'Prova', email: 'luigi.prova.ab12@candidature.frontaliereticino.ch', phone: '', location: 'Como' };

function store() {
  const added: any[] = [];
  return { added, db: { collection: (name: string) => ({ add: async (data: any) => { added.push({ name, data }); } }) } };
}

/** A real multipart body, as a browser (or the runner's Chromium) sends it. */
async function post(path: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = new Response(form);
  return { method: 'POST', path, headers: { 'content-type': response.headers.get('content-type') }, rawBody: Buffer.from(await response.arrayBuffer()) };
}

const cv = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'CV_Luigi_Prova.pdf', { type: 'application/pdf' });

describe('assisted application test portal', () => {
  beforeEach(() => resetTestPortalLimit());

  it('is off without its token, and answers 404 to any other path', async () => {
    const { db } = store();
    const deps = { token: TOKEN, employerEmail: 'employer@example.com', db, sendCascade: vi.fn() };
    expect((await handleTestPortal({ method: 'GET', path: `/${TOKEN}/job`, headers: {} }, { ...deps, token: '' })).status).toBe(404);
    expect((await handleTestPortal({ method: 'GET', path: '/wrong-token-0123456789ab/job', headers: {} }, deps)).status).toBe(404);
    const job = await handleTestPortal({ method: 'GET', path: `/assistedApplicationTestPortal/${TOKEN}/job`, headers: {} }, deps);
    expect(job.status).toBe(200);
    // The job page names no e-mail address, so the channel is the employer's site.
    expect(job.body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(job.body).toContain('href="apply"');
    expect(job.body).toContain('noindex');
  });

  it('walks the runner through two steps and a confirmation, e-mailing the application', async () => {
    const { db, added } = store();
    const sendCascade = vi.fn(async () => ({ failed: [], sent: [{ provider: 'resend', messageId: 'm1' }] }));
    const deps = { token: TOKEN, employerEmail: 'employer@example.com', db, sendCascade, nowMs: Date.UTC(2026, 9, 1) };

    const stepOne = await handleTestPortal({ method: 'GET', path: `/${TOKEN}/apply`, headers: {} }, deps);
    expect(stepOne.body).toMatch(/<button type="submit">Avanti<\/button>/);
    expect('Avanti').toMatch(NEXT_RE);

    // A missing required field comes back with the message the runner recognises.
    const missing = await handleTestPortal(await post(`/${TOKEN}/apply`, { ...PERSONAL, lastName: '' }), deps);
    expect(missing.body).toMatch(VALIDATION_RE);
    expect(missing.body).toContain('aria-invalid="true"');

    const stepTwo = await handleTestPortal(await post(`/${TOKEN}/apply`, PERSONAL), deps);
    expect(stepTwo.body).toContain('Passo 2 di 2');
    expect(stepTwo.body).toContain(`name="email" value="${PERSONAL.email}"`);
    expect('Invia candidatura').toMatch(SUBMIT_RE);

    const done = await handleTestPortal(await post(`/${TOKEN}/submit`, {
      ...PERSONAL, cv: cv(), permit: 'Permesso G (frontaliere)', startDate: '2027-01-01', salary: '80000', privacy: 'yes',
    }), deps);
    expect(done.body).toMatch(CONFIRM_RE);
    const [[items, options]] = sendCascade.mock.calls as any;
    expect(options).toEqual({ delayMs: 0, forceProvider: 'resend' });
    expect(items[0].payload).toMatchObject({ to: ['employer@example.com'], replyTo: PERSONAL.email, tracking: false, openTracking: false });
    expect(items[0].payload.attachments.map((item: any) => item.filename)).toEqual(['CV_Luigi_Prova.pdf']);
    expect(items[0].payload.text).toContain('Newsletter: no · Talent pool: no');
    // Firestore keeps the outcome and the boxes, not the candidate's data.
    expect(added).toEqual([{ name: TEST_PORTAL_COLLECTION, data: expect.objectContaining({ consents: { privacy: true, newsletter: false, talentPool: false }, email: { status: 'sent', provider: 'resend' } }) }]);
    expect(JSON.stringify(added)).not.toContain('Luigi');
  });

  it('refuses the last step without the CV or the privacy consent', async () => {
    const { db } = store();
    const deps = { token: TOKEN, employerEmail: 'employer@example.com', db, sendCascade: vi.fn() };
    const refused = await handleTestPortal(await post(`/${TOKEN}/submit`, { ...PERSONAL, permit: 'Permesso B', startDate: '2027-01-01', salary: '80000' }), deps);
    expect(refused.body).toContain('Passo 2 di 2');
    expect(refused.body.match(/Campo obbligatorio/g)?.length).toBe(2);
    expect(deps.sendCascade).not.toHaveBeenCalled();
  });
});
