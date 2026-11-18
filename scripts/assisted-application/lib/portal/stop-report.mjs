/**
 * The fix issue for a portal the runner could not get through
 * (self-correction, level 3, owner decision 2026-10-01): the way a person
 * fixed JOIN's «Conferma e applica» (#10725), as an issue queued for the
 * repository's Codex fixer (`agent:fix-queued` → the drainer's `agent:fix`),
 * which opens the PR that review and auto-merge take from there.
 *
 * The repository is PUBLIC: the issue carries the portal's host, the page
 * with the employer and the posting left out (anonymizePath), the buttons,
 * the fields' labels and kinds and the form's messages. Every value of the
 * candidate (name and its parts, e-mail, alias, phone, birth date in its
 * usual formats, address, answers) is struck out first, and e-mail
 * addresses and phone numbers in any text too.
 *
 * Each field also carries the shape of its value, never the value
 * (value-shape.mjs, closed vocabulary): «Vorname» holding an e-mail shows up
 * as `mismatch:name`, a value the portal cut at its maxlength as `truncated`.
 */

import { isoDateOf } from '../../../../functions/src/lib/cvPeriod.js';
import { publicValueShape } from './value-shape.mjs';
import { PORTAL_STOP_REASONS } from '../../../../functions/src/lib/portalStopCodes.js';

const STRUCK = '[dato del candidato]';
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d ()./-]{7,}\d/g;
const URL_RE = /\bhttps?:\/\/[^\s<>'"`]+/giu;
const NAMED_PATH_SEGMENT_AFTER = /^(companies|company|jobs|job|careers|career|positions|position|stellen|stelle|offerte|offres|vacancies|postings|o|j)$/i;
const RECEIPT_FINGERPRINT_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const RECEIPT_BINDING = new Set(['bound', 'unbound', 'unknown']);
const RECEIPT_EVIDENCE = new Set([
  'application_entry',
  'form_content',
  'form_posting_match',
  'job_identity',
  'posting_data',
  'posting_page',
  'posting_route',
  'posting_url',
  'route_binding',
  'successfactors_requisition',
]);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const allowlisted = (value, allowed) => {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : '';
};

/** Keep only the anonymous path; never serialize an origin, query or hash. */
function receiptPath(value, strike) {
  let path = String(value || '').trim();
  if (!path) return '';
  try {
    path = new URL(path).pathname;
  } catch {
    if (!path.startsWith('/')) return '';
    path = path.split(/[?#]/u, 1)[0];
  }
  try { path = decodeURIComponent(path); } catch { /* redact the encoded path below */ }
  const segments = strike(path).split('/').filter(Boolean);
  return `/${segments.map((segment, index) => {
    const named = index > 0 && NAMED_PATH_SEGMENT_AFTER.test(segments[index - 1]);
    const unsafe = named || segment.includes(STRUCK) || segment.includes('[email]') || segment.includes('[telefono]')
      || /\d/u.test(segment) || segment.length > 24 || !/^[\p{L}._~*-]+$/u.test(segment);
    return unsafe ? '*' : segment;
  }).join('/')}`;
}

/**
 * Durable, candidate-free proof for a posting mismatch. Every factual field
 * must be supplied by the runner; this serializer never derives a match from
 * the stop reason.
 */
function postingMismatchReceipt(report, strike) {
  if (report?.reason !== 'posting_mismatch' || !report?.receipt || typeof report.receipt !== 'object') return null;
  const raw = report.receipt;
  const path = receiptPath(raw.path || raw.url || report.path, strike);
  const label = strike(String(raw.cta?.label || '').replace(URL_RE, '[url]')).slice(0, 120);
  const fingerprint = String(raw.cta?.fingerprint || '').trim().toLowerCase();
  const binding = allowlisted(raw.binding?.status, RECEIPT_BINDING);
  const bindingVia = allowlisted(raw.binding?.via, RECEIPT_EVIDENCE);
  const decision = String(raw.decision?.result || '').trim().toLowerCase() === 'mismatch' ? 'mismatch' : '';
  const decisionVia = allowlisted(raw.decision?.via, RECEIPT_EVIDENCE);
  if (!path || !label || !RECEIPT_FINGERPRINT_RE.test(fingerprint)
    || !binding || !bindingVia || !decision || !decisionVia) return null;
  return {
    path,
    cta: { label, fingerprint },
    binding: { status: binding, via: bindingVia },
    decision: { result: decision, via: decisionVia },
  };
}

/** The values to strike: each one, a name's words, a birth date's other formats. */
export function candidateValues(values = []) {
  const out = new Set();
  for (const raw of values.flat()) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const value = String(raw).trim();
    if (value.length < 3) continue;
    out.add(value);
    // "Luigi Prova" → "Luigi", "Prova".
    for (const word of value.split(/\s+/)) if (word.length >= 3 && /^\p{L}+$/u.test(word)) out.add(word);
    // 1986-09-12 ↔ 12.09.1986 ↔ 12/09/1986, whichever form the value is written in («14. März 2010» too).
    const iso = isoDateOf(value);
    if (iso) {
      out.add(iso);
      const [year, month, day] = iso.split('-');
      for (const separator of ['.', '/', '-']) out.add([day, month, year].join(separator));
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The report with every candidate value struck out, ready to be published. */
export function redactStopReport(report, values = []) {
  const strike = (text) => {
    let out = String(text ?? '');
    for (const value of values) out = out.replace(new RegExp(escape(value), 'gi'), STRUCK);
    return out.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[telefono]');
  };
  const receipt = postingMismatchReceipt(report, strike);
  return {
    host: String(report.host || ''),
    path: receiptPath(report.path || report.receipt?.url || '', strike),
    reason: String(report.reason || ''),
    channel: String(report.channel || ''),
    step: Number(report.step) || 0,
    buttons: (report.buttons || []).map(strike).slice(0, 30),
    fields: (report.fields || []).slice(0, 30).map((field) => {
      const valueShape = publicValueShape(field.valueShape);
      return { label: strike(field.label), kind: String(field.kind || ''), required: Boolean(field.required), ...(valueShape ? { valueShape } : {}) };
    }),
    errors: (report.errors || []).map(strike).slice(0, 8),
    agent: (report.agent || []).map((item) => ({ hint: String(item.hint || ''), status: String(item.status || '') })),
    ...(receipt ? { receipt } : {}),
  };
}

/**
 * Candidate-free proof that the portal runner reached its reliable success
 * boundary: confirmed after submit, or final review before a dry-run click.
 */
export function portalPassFrom({ applyUrl, channel, event, evidence, dryRun }) {
  const stage = event?.type === 'submit_succeeded' && !dryRun
    ? 'submitted'
    : event?.type === 'dry_run_ready' && dryRun && evidence?.finalButton
      ? 'final_review'
      : '';
  if (!stage) return null;
  if (event.type === 'submit_succeeded' && !evidence?.finalUrl) return null;
  let host = '';
  try {
    host = new URL(String(applyUrl || '')).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const step = Number(evidence?.steps?.length);
  return {
    host,
    channel: String(channel || '').slice(0, 80),
    step: Number.isSafeInteger(step) && step >= 1 ? step : 0,
    stage,
  };
}

/** Serialize the only fields the workflow may use to reconcile portal issues. */
export function portalPassRecord(pass, mode) {
  return {
    host: String(pass?.host || ''),
    channel: String(pass?.channel || ''),
    mode: String(mode || ''),
    step: Number(pass?.step) || 0,
    stage: String(pass?.stage || ''),
  };
}

export const REASONS = PORTAL_STOP_REASONS;

const code = (value) => `\`${String(value).replace(/`/g, "'")}\``;

/** «, contiene: email» for a field's value shape; nothing for a field without one. */
const valueShapeText = (shape) => {
  const safe = publicValueShape(shape);
  if (!safe) return '';
  const note = safe === 'truncated' ? ' (troncato dal portale al maxlength)'
    : safe === 'changed' ? ' (il portale ha tenuto un valore diverso da quello scritto)'
      : safe.startsWith('mismatch:') ? ` (incoerente: il campo chiede ${safe.slice('mismatch:'.length)})` : '';
  return `, contiene: ${safe}${note}`;
};

/** Title, body and de-duplication key of the issue (one issue per host, reason and page). */
export function stopIssue(report, runUrl = '') {
  const reason = REASONS[report.reason] || report.reason || 'stop';
  const title = `[portal-stop] ${report.host}: ${reason} su ${report.path || '/'}`;
  const lines = [
    '## Il runner del portale si è fermato',
    '',
    `- **Portale:** ${code(report.host)}${report.channel ? ` (canale ${code(report.channel)})` : ''}`,
    `- **Pagina:** ${code(report.path || '/')} (passo ${report.step})`,
    `- **Motivo:** ${code(report.reason)}`,
    `- **Ripiego agentico:** ${report.agent.length ? report.agent.map((item) => `${item.hint} → ${item.status}`).join('; ') : 'non usato'}`,
    ...(runUrl ? [`- **Run:** ${runUrl}`] : []),
    '',
    '### Cosa vedeva il runner',
    '',
    `**Pulsanti:** ${report.buttons.length ? report.buttons.map(code).join(', ') : '—'}`,
    '',
    '**Campi:**',
    ...(report.fields.length ? report.fields.map((field) => `- ${code(field.label || '(senza etichetta)')} — ${field.kind}${field.required ? ', obbligatorio' : ''}${valueShapeText(field.valueShape)}`) : ['- —']),
    '',
    `**Messaggi del modulo:** ${report.errors.length ? report.errors.map(code).join(', ') : '—'}`,
    ...(report.receipt ? [
      '',
      '### Receipt candidate-free',
      '',
      `- **Path:** ${code(report.receipt.path)}`,
      `- **CTA:** ${code(report.receipt.cta.label)} (${code(report.receipt.cta.fingerprint)})`,
      `- **Job binding:** ${code(report.receipt.binding.status)} via ${code(report.receipt.binding.via)}`,
      `- **Decisione match:** ${code(report.receipt.decision.result)} via ${code(report.receipt.decision.via)}`,
    ] : []),
    '',
    '### Cosa fare',
    '',
    'Insegna al runner (`scripts/assisted-application/lib/portal/`) a superare questa pagina, con un test in `tests/assisted-application-portal*.test.ts` che riproduce i pulsanti e i campi qui sopra.',
    '- L’invio finale resta del runner, dietro la guardia anti-doppio invio (`onBeforeSubmit`): l’agente non lo preme mai.',
    '- Mai inventare una risposta del candidato: ciò che i dati non dicono diventa una domanda per lui.',
    '- Nessun dato personale nei test: i valori del candidato sono stati tolti da questa issue prima della pubblicazione.',
    '',
    'Dopo la pubblicazione, il recupero automatico verifica la guardia di invio e riprende i blocchi tecnici certamente non inviati; nessun nuovo invio se il risultato precedente è ambiguo.',
  ];
  return { title: title.slice(0, 200), description: lines.join('\n'), dedupKey: title.slice(0, 120) };
}
