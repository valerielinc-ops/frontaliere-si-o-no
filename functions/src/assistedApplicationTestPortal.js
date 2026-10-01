/**
 * A test employer careers portal for the assisted application (owner request
 * 2026-10-01): the portal path of the runner (scripts/assisted-application/
 * lib/portal) is tried end to end, final click included, on a posting of
 * ours instead of a fake application to a real company.
 *
 * Fictional employer, Italian, like the trial order's: a job page, a two-step
 * form (personal data, then CV, questions and consents) and a confirmation
 * page. The submission is e-mailed with its attachments to the trial
 * "employer" address; Firestore keeps only the outcome and which boxes were
 * ticked (the runner must tick the privacy notice and leave newsletter and
 * talent pool alone, as plan.mjs promises and the Terms say).
 *
 * Off unless Remote Config holds ASSISTED_APPLICATION_TEST_PORTAL_TOKEN: the
 * token is the first path segment, so the pages are unlisted and anything
 * else answers 404. Links are relative, so the function's base path does not
 * matter.
 */

import { timingSafeEqual } from 'node:crypto';

export const TEST_PORTAL_COLLECTION = 'assisted_application_test_portal';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SUBMISSIONS_PER_HOUR = 30;
const FILE_TYPES = /\.(pdf|docx?)$/i;
const JOB = {
  title: 'Infermiere/a diplomato/a 80-100% (annuncio di prova)',
  company: 'Casa di cura Prova SA',
  place: 'Lugano',
};
const PERMITS = ['Cittadinanza svizzera', 'Permesso C', 'Permesso B', 'Permesso G (frontaliere)', 'Nessun permesso'];
const SOURCES = ['Sito dell’azienda', 'Portale di annunci', 'Passaparola', 'Altro'];

let submissions = { startedAt: 0, count: 0 };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length >= 16 && timingSafeEqual(a, b);
}

function page(title, body) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — ${esc(JOB.company)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1e293b;background:#f8fafc}
h1{font-size:1.5rem}form{display:grid;gap:14px}label{display:grid;gap:4px;font-weight:600}
input,select{font:inherit;padding:8px;border:1px solid #94a3b8;border-radius:6px}.check{display:flex;gap:8px;font-weight:400}
.error{color:#b91c1c;font-weight:400}button,a.button{font:inherit;padding:10px 16px;border-radius:6px;background:#0f766e;color:#fff;border:0;text-decoration:none;display:inline-block}
.note{font-size:.85rem;color:#475569}</style></head><body>
<p class="note">${esc(JOB.company)} · Portale carriere (pagina di prova di Frontaliere Ticino, non è un annuncio reale)</p>
${body}</body></html>`;
}

function jobPage() {
  return page(JOB.title, `<h1>${esc(JOB.title)}</h1>
<p><strong>${esc(JOB.company)}</strong> · ${esc(JOB.place)} · Grado d’occupazione 80-100%</p>
<h2>Il ruolo</h2>
<p>Per il nostro reparto di cure a lungo termine cerchiamo un infermiere o un’infermiera diplomata che si occupi
dell’assistenza agli ospiti, della pianificazione delle cure e della documentazione infermieristica informatizzata,
in collaborazione con il team medico e con i familiari.</p>
<h2>Requisiti</h2>
<ul><li>Diploma SSS o Bachelor in cure infermieristiche, riconosciuto dalla CRS</li>
<li>Esperienza in geriatria o medicina interna</li><li>Ottima conoscenza dell’italiano; il tedesco è un vantaggio</li>
<li>Disponibilità a lavorare a turni</li></ul>
<h2>Offriamo</h2>
<p>Un ambiente accogliente, formazione continua e condizioni secondo il contratto collettivo cantonale.</p>
<p><a class="button" href="apply">Candidati a questa posizione</a></p>`);
}

function field(name, label, { type = 'text', value = '', required = false, error = '', extra = '' } = {}) {
  return `<label for="${name}">${esc(label)}${required ? ' *' : ''}
<input id="${name}" name="${name}" type="${type}" value="${esc(value)}"${required ? ' required' : ''}${error ? ' aria-invalid="true"' : ''}${extra}>
${error ? `<span class="error">${esc(error)}</span>` : ''}</label>`;
}

function select(name, label, options, { value = '', required = false, error = '' } = {}) {
  const items = [`<option value="">Seleziona…</option>`, ...options.map((option) => `<option${option === value ? ' selected' : ''}>${esc(option)}</option>`)];
  return `<label for="${name}">${esc(label)}${required ? ' *' : ''}
<select id="${name}" name="${name}"${required ? ' required' : ''}${error ? ' aria-invalid="true"' : ''}>${items.join('')}</select>
${error ? `<span class="error">${esc(error)}</span>` : ''}</label>`;
}

function checkbox(name, label, { required = false, error = '' } = {}) {
  return `<label class="check" for="${name}"><input id="${name}" name="${name}" type="checkbox" value="yes"${required ? ' required' : ''}>
<span>${esc(label)}${required ? ' *' : ''}${error ? ` <span class="error">${esc(error)}</span>` : ''}</span></label>`;
}

const STEP_ONE = ['firstName', 'lastName', 'email', 'phone', 'location'];

function stepOne(values = {}, errors = {}) {
  return page(`Candidatura: ${JOB.title}`, `<h1>Candidatura · Passo 1 di 2</h1><p>${esc(JOB.title)}</p>
<form method="post" action="apply" enctype="multipart/form-data" novalidate>
${field('firstName', 'Nome', { value: values.firstName, required: true, error: errors.firstName, extra: ' autocomplete="given-name"' })}
${field('lastName', 'Cognome', { value: values.lastName, required: true, error: errors.lastName, extra: ' autocomplete="family-name"' })}
${field('email', 'Email', { type: 'email', value: values.email, required: true, error: errors.email, extra: ' autocomplete="email"' })}
${field('phone', 'Telefono', { type: 'tel', value: values.phone, extra: ' autocomplete="tel"' })}
${field('location', 'Località di residenza', { value: values.location, required: true, error: errors.location })}
<p><button type="submit">Avanti</button></p></form>`);
}

function stepTwo(personal, values = {}, errors = {}) {
  const hidden = STEP_ONE.map((name) => `<input type="hidden" name="${name}" value="${esc(personal[name])}">`).join('');
  return page(`Candidatura: ${JOB.title}`, `<h1>Candidatura · Passo 2 di 2</h1><p>${esc(JOB.title)}</p>
<form method="post" action="submit" enctype="multipart/form-data" novalidate>${hidden}
${field('cv', 'Curriculum vitae (PDF, DOC o DOCX, massimo 5 MB)', { type: 'file', required: true, error: errors.cv, extra: ' accept=".pdf,.doc,.docx"' })}
${field('coverLetter', 'Lettera di presentazione (facoltativa)', { type: 'file', error: errors.coverLetter, extra: ' accept=".pdf,.doc,.docx"' })}
${select('permit', 'Permesso di lavoro in Svizzera', PERMITS, { value: values.permit, required: true, error: errors.permit })}
${field('startDate', 'Data d’inizio possibile', { type: 'date', value: values.startDate, required: true, error: errors.startDate })}
${field('salary', 'Pretese salariali annue lorde (CHF)', { value: values.salary, required: true, error: errors.salary })}
${select('source', 'Come hai conosciuto questo annuncio?', SOURCES, { value: values.source })}
${checkbox('privacy', 'Ho letto l’informativa sulla protezione dei dati e acconsento al trattamento dei miei dati per questa candidatura.', { required: true, error: errors.privacy })}
${checkbox('newsletter', `Desidero ricevere la newsletter di ${JOB.company}.`)}
${checkbox('talentPool', 'Inseritemi nel talent pool per future posizioni.')}
<p><button type="submit">Invia candidatura</button></p></form>`);
}

function confirmation() {
  return page('Candidatura ricevuta', `<h1>Grazie per la tua candidatura!</h1>
<p>La candidatura è stata ricevuta: la esamineremo e ti risponderemo entro due settimane.</p>`);
}

const REQUIRED = 'Campo obbligatorio';

function text(form, name) {
  const value = form?.get?.(name);
  return typeof value === 'string' ? value.trim().slice(0, 300) : '';
}

function file(form, name) {
  const value = form?.get?.(name);
  return value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && value.size > 0 ? value : null;
}

async function readForm(req) {
  const type = String(req.headers?.['content-type'] || '');
  if (!/multipart\/form-data|application\/x-www-form-urlencoded/i.test(type) || !req.rawBody) return null;
  try {
    return await new Response(req.rawBody, { headers: { 'content-type': type } }).formData();
  } catch {
    return null;
  }
}

function personalErrors(values) {
  const errors = {};
  for (const name of ['firstName', 'lastName', 'location']) if (!values[name]) errors[name] = REQUIRED;
  if (!values.email) errors.email = REQUIRED;
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.email = 'Indirizzo email non valido';
  return errors;
}

function allowSubmission(nowMs) {
  if (nowMs - submissions.startedAt > 60 * 60 * 1000) submissions = { startedAt: nowMs, count: 0 };
  submissions.count += 1;
  return submissions.count <= MAX_SUBMISSIONS_PER_HOUR;
}

/** Test seam: the hourly counter starts over. */
export function resetTestPortalLimit() {
  submissions = { startedAt: 0, count: 0 };
}

/**
 * @param {{method:string, path:string, headers:object, rawBody?:Buffer}} req
 * @param {{token:string, employerEmail:string, db:object, sendCascade:Function, nowMs?:number}} deps
 * @returns {Promise<{status:number, body:string}>}
 */
export async function handleTestPortal(req, { token, employerEmail, db, sendCascade, nowMs = Date.now() }) {
  const notFound = { status: 404, body: 'Not found' };
  const segments = String(req.path || '').split('/').filter(Boolean);
  const at = segments.findIndex((segment) => sameToken(segment, token));
  if (!token || at < 0) return notFound;
  const action = segments[at + 1] || 'job';
  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'GET' && action === 'job') return { status: 200, body: jobPage() };
  if (method === 'GET' && action === 'apply') return { status: 200, body: stepOne() };
  if (method !== 'POST' || !['apply', 'submit'].includes(action)) return notFound;

  const form = await readForm(req);
  if (!form) return { status: 400, body: page('Richiesta non valida', '<h1>Richiesta non valida</h1><p><a href="apply">Ricomincia</a></p>') };
  const personal = Object.fromEntries(STEP_ONE.map((name) => [name, text(form, name)]));
  const errorsOne = personalErrors(personal);
  if (action === 'apply' || Object.keys(errorsOne).length) {
    return { status: 200, body: Object.keys(errorsOne).length ? stepOne(personal, errorsOne) : stepTwo(personal) };
  }

  const values = { permit: text(form, 'permit'), startDate: text(form, 'startDate'), salary: text(form, 'salary'), source: text(form, 'source') };
  const consents = { privacy: text(form, 'privacy') === 'yes', newsletter: text(form, 'newsletter') === 'yes', talentPool: text(form, 'talentPool') === 'yes' };
  const cv = file(form, 'cv');
  const coverLetter = file(form, 'coverLetter');
  const errors = {};
  if (!cv) errors.cv = REQUIRED;
  for (const [name, upload] of [['cv', cv], ['coverLetter', coverLetter]]) {
    if (upload && (upload.size > MAX_FILE_BYTES || !FILE_TYPES.test(upload.name || ''))) errors[name] = 'Carica un PDF, DOC o DOCX di massimo 5 MB';
  }
  if (!PERMITS.includes(values.permit)) errors.permit = REQUIRED;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.startDate)) errors.startDate = REQUIRED;
  if (!values.salary) errors.salary = REQUIRED;
  if (!consents.privacy) errors.privacy = REQUIRED;
  if (Object.keys(errors).length) return { status: 200, body: stepTwo(personal, values, errors) };
  if (!allowSubmission(nowMs)) return { status: 429, body: page('Troppe richieste', '<h1>Troppe richieste</h1><p>Riprova più tardi.</p>') };

  const attachments = [];
  for (const upload of [cv, coverLetter].filter(Boolean)) {
    attachments.push({ filename: String(upload.name || 'allegato.pdf').replace(/[^\w.() -]/g, '_').slice(0, 120), content: Buffer.from(await upload.arrayBuffer()).toString('base64') });
  }
  const name = `${personal.firstName} ${personal.lastName}`.trim();
  const lines = [
    `Nuova candidatura dal portale di prova per «${JOB.title}».`,
    '',
    `Nome: ${name}`, `Email: ${personal.email}`, `Telefono: ${personal.phone || '—'}`, `Località: ${personal.location}`,
    `Permesso: ${values.permit}`, `Data d’inizio: ${values.startDate}`, `Pretese salariali: ${values.salary}`, `Fonte: ${values.source || '—'}`,
    `Privacy: ${consents.privacy ? 'accettata' : 'no'} · Newsletter: ${consents.newsletter ? 'sì' : 'no'} · Talent pool: ${consents.talentPool ? 'sì' : 'no'}`,
    `Allegati: ${attachments.map((item) => item.filename).join(', ')}`,
  ];
  let sent = { status: 'skipped' };
  if (employerEmail) {
    const { failed, sent: delivered } = await sendCascade([{
      payload: {
        from: `${JOB.company} (portale di prova) <valerie@frontaliereticino.ch>`,
        to: [employerEmail],
        subject: `[Portale di prova] Candidatura: ${JOB.title} – ${name}`,
        text: lines.join('\n'),
        html: `<pre style="font-family:inherit;white-space:pre-wrap">${esc(lines.join('\n'))}</pre>`,
        ...(personal.email ? { replyTo: personal.email } : {}),
        attachments,
        tracking: false,
        openTracking: false,
      },
      recipient: { email: employerEmail },
      meta: { key: 'test_portal_application' },
    }], { delayMs: 0, forceProvider: 'resend' });
    sent = failed.length ? { status: 'failed', error: String(failed[0]?.error || '').slice(0, 120) } : { status: 'sent', provider: delivered[0]?.provider || null };
  }
  // The outcome and the boxes, never the candidate's data (that is in the e-mail).
  await db.collection(TEST_PORTAL_COLLECTION).add({
    submittedAt: new Date(nowMs),
    consents,
    filled: Object.entries({ ...personal, ...values }).filter(([, value]) => value).map(([key]) => key),
    files: attachments.map((item) => item.filename.replace(/^.*(\.[a-z]+)$/i, 'file$1')),
    email: sent,
  });
  return { status: 200, body: confirmation() };
}
