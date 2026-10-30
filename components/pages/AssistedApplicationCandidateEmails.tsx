import { Eye, Info, Mail, MousePointerClick, Send } from 'lucide-react';
import type { AssistedApplicationCandidateEmail } from '@/services/assistedApplicationAdminService';

function formatDate(value: string | number | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
}

const EMAIL_STATUS_LABELS: Record<string, string> = {
  sent: 'inviata',
  sending: 'in invio',
  failed: 'non riuscita (ritento)',
  ambiguous: 'esito incerto',
};

function emailStatusLabel(status: string | null): string {
  return status ? EMAIL_STATUS_LABELS[status] || status : 'non inviata';
}

const CANDIDATE_EMAIL_LABELS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^customer_intro$/, () => 'Benvenuto'],
  [/^customer_materials_received$/, () => 'CV ricevuto'],
  [/^customer_materials_reminder$/, () => 'Promemoria 48 h'],
  [/^customer_submitted$/, () => 'Conferma invio'],
  [/^auto_candidate_review_r(\d+)(_held)?$/, (m) => `Revisione della bozza, round ${m[1]}${m[2] ? ' (con domande)' : ''}`],
  [/^auto_candidate_reminder_r(\d+)$/, (m) => `Promemoria revisione, round ${m[1]}`],
  [/^auto_candidate_action_\d+$/, () => 'Serve una risposta del candidato'],
  [/^auto_candidate_handoff$/, () => 'Invio dal portale affidato al candidato'],
  [/^auto_candidate_handoff_reminder$/, () => 'Promemoria invio dal portale'],
  [/^auto_candidate_posting_closed$/, () => 'Annuncio chiuso e rimborso'],
  [/^followup_review_(\d+)$/, (m) => `Follow-up ${m[1]} da rivedere`],
  [/^interview_prep$/, () => 'Preparazione al colloquio'],
  [/^employer_message_forward$/, () => 'Risposta del datore inoltrata'],
];

function candidateEmailLabel(key: string): string {
  for (const [pattern, label] of CANDIDATE_EMAIL_LABELS) {
    const match = key.match(pattern);
    if (match) return label(match);
  }
  return key;
}

/** Delivery, opens and clicks of each e-mail the candidate received. */
export default function CandidateEmails({ emails }: { emails: AssistedApplicationCandidateEmail[] }) {
  if (!emails.length) return <span className="block text-xs text-subtle">Nessuna email al candidato finora</span>;
  return (
    <div className="min-w-0">
      <div role="table" aria-label="Invio e interazioni delle email al candidato">
        <div role="rowgroup">
          <div role="row" className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 border-b border-edge pb-2 text-xs font-medium text-muted md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)] md:gap-x-4">
            <span role="columnheader">Email</span>
            <span role="columnheader" className="hidden md:block">Invio</span>
            <span role="columnheader" className="inline-flex items-center gap-1"><Eye size={13} aria-hidden="true" />Lettura</span>
            <span role="columnheader" className="inline-flex items-center gap-1"><MousePointerClick size={13} aria-hidden="true" />Clic</span>
          </div>
        </div>
        <ul role="rowgroup" className="divide-y divide-edge">
          {emails.map((email) => {
            const sent = Boolean(email.sentAt || email.delivered || email.status === 'sent' || email.opens || email.clicks);
            let sendLabel = emailStatusLabel(email.status || (sent ? 'sent' : null));
            let sendIconTone = sent ? 'text-success' : 'text-muted';
            const sendTextTone = email.bounces || email.complaints || email.status === 'failed'
              ? 'text-danger'
              : sent ? 'text-body' : 'text-muted';
            if (email.bounces > 0) {
              sendLabel = 'Rimbalzata';
              sendIconTone = 'text-danger';
            } else if (email.complaints > 0 || email.status === 'failed') {
              sendLabel = email.complaints > 0 ? 'Segnalata come spam' : sendLabel;
              sendIconTone = 'text-danger';
            } else if (email.status === 'ambiguous') {
              sendIconTone = 'text-warning';
            } else if (email.status === 'sending') {
              sendIconTone = 'text-info';
            }
            const trackingAvailable = sent && email.bounces === 0 && !['ambiguous', 'failed', 'sending'].includes(email.status || '');
            const openedLabel = email.opens ? `Letta ${email.opens}×` : trackingAvailable ? 'Non letta' : '—';
            const clickedLabel = email.clicks ? `${email.clicks} clic` : trackingAvailable ? 'Nessun clic' : '—';
            const openedDescription = email.opens
              ? `${openedLabel}${email.firstOpenAt ? `, prima apertura ${formatDate(email.firstOpenAt)}` : ''}`
              : trackingAvailable ? 'Non ancora aperta' : 'Nessun dato di apertura';
            const clickedDescription = email.clicks
              ? `${clickedLabel}${email.lastClickAt ? `, ultimo ${formatDate(email.lastClickAt)}` : ''}`
              : trackingAvailable ? 'Nessun clic registrato' : 'Nessun dato sui clic';
            return (
              <li role="row" key={email.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-1.5 py-2.5 text-xs md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)] md:items-center md:gap-x-4">
                <div role="cell" className="col-start-1 row-start-1 min-w-0 md:col-auto md:row-auto">
                  <span className="flex min-w-0 items-start gap-1.5 font-semibold leading-snug text-strong" title={candidateEmailLabel(email.key)}>
                    <Mail size={14} className="shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 break-words">{candidateEmailLabel(email.key)}</span>
                  </span>
                  <span className="mt-1 inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-body md:hidden">
                    <Send size={13} className={sendIconTone} aria-hidden="true" />
                    <span className={`font-medium ${sendTextTone}`}>{sendLabel}</span>
                    {email.sentAt && <time className="text-subtle tabular-nums" dateTime={email.sentAt}>{formatDate(email.sentAt)}</time>}
                    {email.bounces > 0 && <span className="text-danger">{email.bounces} rimbalzi</span>}
                    {email.complaints > 0 && <span className="text-danger">{email.complaints} segnalazioni spam</span>}
                  </span>
                </div>
                <span role="cell" className="hidden min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-body md:flex">
                  <span className={`inline-flex items-center gap-1.5 font-medium ${sendTextTone}`}>
                    <Send size={13} className={sendIconTone} aria-hidden="true" />
                    {sendLabel}
                  </span>
                  {email.sentAt && <time className="text-xs text-subtle tabular-nums" dateTime={email.sentAt}>{formatDate(email.sentAt)}</time>}
                  {email.bounces > 0 && <span className="text-xs text-danger">{email.bounces} rimbalzi</span>}
                  {email.complaints > 0 && <span className="text-xs text-danger">{email.complaints} segnalazioni spam</span>}
                </span>
                <span role="cell"
                  className={`col-start-2 row-start-1 inline-flex items-center justify-end gap-1.5 whitespace-nowrap font-medium md:col-auto md:row-auto md:justify-start ${sent ? 'text-body' : 'text-muted'}`}
                  aria-label={openedDescription}
                  title={openedDescription}
                >
                  <Eye size={14} className={email.opens ? 'text-success' : 'text-muted'} aria-hidden="true" />
                  <span className="md:hidden tabular-nums">{trackingAvailable ? email.opens : '—'}</span>
                  <span className="hidden md:inline">{openedLabel}</span>
                </span>
                <span role="cell"
                  className={`col-start-3 row-start-1 inline-flex items-center justify-end gap-1.5 whitespace-nowrap font-medium md:col-auto md:row-auto md:justify-start ${sent ? 'text-body' : 'text-muted'}`}
                  aria-label={clickedDescription}
                  title={clickedDescription}
                >
                  <MousePointerClick size={14} className={email.clicks ? 'text-accent' : 'text-muted'} aria-hidden="true" />
                  <span className="md:hidden tabular-nums">{trackingAvailable ? email.clicks : '—'}</span>
                  <span className="hidden md:inline">{clickedLabel}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <span className="mt-2 inline-flex items-start gap-1.5 text-xs text-muted">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        Le aperture sono indicative: alcuni client email possono registrarle automaticamente.
      </span>
    </div>
  );
}
