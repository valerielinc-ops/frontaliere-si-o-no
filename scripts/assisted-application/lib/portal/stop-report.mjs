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
 */

const STRUCK = '[dato del candidato]';
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d ()./-]{7,}\d/g;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    // 1986-09-12 ↔ 12.09.1986 ↔ 12/09/1986.
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (iso) for (const separator of ['.', '/', '-']) out.add([iso[3], iso[2], iso[1]].join(separator));
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
  return {
    host: String(report.host || ''),
    path: String(report.path || ''),
    reason: String(report.reason || ''),
    channel: String(report.channel || ''),
    step: Number(report.step) || 0,
    buttons: (report.buttons || []).map(strike).slice(0, 30),
    fields: (report.fields || []).slice(0, 30).map((field) => ({ label: strike(field.label), kind: String(field.kind || ''), required: Boolean(field.required) })),
    errors: (report.errors || []).map(strike).slice(0, 8),
    agent: (report.agent || []).map((item) => ({ hint: String(item.hint || ''), status: String(item.status || '') })),
  };
}

const REASONS = {
  portal_needs_candidate: 'pagina non superata',
  posting_mismatch: 'modulo non riconosciuto come quello dell’annuncio',
  account: 'account del portale',
  rejected: 'invio rifiutato dal portale',
};

const code = (value) => `\`${String(value).replace(/`/g, "'")}\``;

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
    ...(report.fields.length ? report.fields.map((field) => `- ${code(field.label || '(senza etichetta)')} — ${field.kind}${field.required ? ', obbligatorio' : ''}`) : ['- —']),
    '',
    `**Messaggi del modulo:** ${report.errors.length ? report.errors.map(code).join(', ') : '—'}`,
    '',
    '### Cosa fare',
    '',
    'Insegna al runner (`scripts/assisted-application/lib/portal/`) a superare questa pagina, con un test in `tests/assisted-application-portal*.test.ts` che riproduce i pulsanti e i campi qui sopra.',
    '- L’invio finale resta del runner, dietro la guardia anti-doppio invio (`onBeforeSubmit`): l’agente non lo preme mai.',
    '- Mai inventare una risposta del candidato: ciò che i dati non dicono diventa una domanda per lui.',
    '- Nessun dato personale nei test: i valori del candidato sono stati tolti da questa issue prima della pubblicazione.',
    '',
    'Dopo il merge Valerie preme «Riprova l’invio automatico» sull’ordine fermo.',
  ];
  return { title: title.slice(0, 200), description: lines.join('\n'), dedupKey: title.slice(0, 120) };
}
