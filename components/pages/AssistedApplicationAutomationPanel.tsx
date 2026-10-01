import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, FileText, Loader2, Pause, Play, RefreshCw, Save, Send, UploadCloud, UserCheck, Wand2 } from 'lucide-react';
import {
  runAutomationAdminAction,
  uploadAssistedApplicationCv,
  type AssistedApplicationAdminOrder,
  type AutomationAdminAction,
} from '@/services/assistedApplicationAdminService';

/**
 * Owner view of the automated assisted application for one order: flow
 * state and clocks, why it is held, the AI draft with its analysis, and the
 * actions Valerie can take. Italian only, like the rest of the admin queue.
 */

const STATE_LABELS: Record<string, string> = {
  drafting: 'Bozza in preparazione (Codex)',
  regenerating: 'Nuova versione in preparazione',
  owner_review: 'In revisione da te',
  candidate_review: 'In revisione dal candidato',
  submitting: 'Invio in corso',
  needs_candidate_action: 'Attende risposte del candidato',
  candidate_handoff: 'Handoff: il candidato completa sul portale',
  submitted: 'Inviata',
  owner_takeover: 'Sospesa: presa in carico da te',
  failed: 'Fallita',
};

// Owner flags with no dedicated acknowledgement field: acknowledged by name.
const OTHER_OWNER_FLAGS: Record<string, string> = {
  no_posting: 'Testo dell’annuncio non recuperato: ho verificato l’annuncio, procedi',
  channel_unknown: 'Canale di candidatura sconosciuto: il candidato completerà sul portale, procedi',
};

const FOLLOWUP_STATES: Record<string, string> = {
  scheduled: 'programmato',
  awaiting_candidate: 'in attesa del candidato (12 ore)',
  sending: 'in invio',
  done: 'completati',
  stopped: 'fermati',
};

const LEGITIMACY_TIERS: Record<string, string> = {
  high_confidence: 'affidabile',
  caution: 'da verificare',
  suspicious: 'sospetto',
};

const TAILORED_CV_LABELS: Record<string, string> = {
  ready: 'pronto, verrà inviato',
  fact_check_failed: 'scartato dal controllo dei fatti: parte il CV originale',
  failed: 'non generato: parte il CV originale',
  skipped: 'non generato',
};

const HELD_LABELS: Record<string, string> = {
  fact_check: 'fatti non verificati nei testi',
  knock_out: 'requisito indispensabile mancante',
  no_posting: 'testo dell’annuncio non recuperato',
  channel_unknown: 'canale di candidatura sconosciuto',
  legitimacy: 'annuncio sospetto (Block G)',
  max_rounds: '3 rifiuti del candidato',
  draft_failed: 'bozza non generata',
  posting_closed: 'annuncio chiuso (rimborso automatico)',
  portal_needs_candidate: 'il portale richiede il candidato',
  owner: 'presa in carico manuale',
};

const VERDICT_LABELS: Record<string, string> = { strong: 'forte', good: 'buono', weak: 'debole', poor: 'scarso' };
const INBOX_LABELS: Record<string, string> = {
  interview_invite: 'Invito a colloquio', rejection: 'Rifiuto', documents_request: 'Documenti richiesti', question: 'Domanda',
  assessment: 'Test', auto_acknowledgement: 'Conferma di ricezione', verification: 'Verifica account', offer: 'Offerta', other: 'Messaggio',
  processing: 'In elaborazione',
};
const MATCH_STYLES: Record<string, string> = { met: 'text-success', partial: 'text-warning', missing: 'text-danger' };

function formatMs(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('it-CH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' });
}

const PORTAL_STOP_LABELS: Record<string, string> = {
  captcha: 'CAPTCHA sul portale: completa tu l’invio',
  account: 'account sul portale da creare o verificare',
  rejected: 'il portale ha rifiutato l’invio automatico',
  portal_needs_candidate: 'una pagina del portale non completata dal robot',
  posting_mismatch: 'il modulo non sembra di questo annuncio: controlla e riprova',
};

function heldLabel(reason: string): string {
  if (reason.startsWith('question:')) return `domanda aperta: ${reason.slice(9)}`;
  if (reason.startsWith('portal:')) return PORTAL_STOP_LABELS[reason.slice(7)] || PORTAL_STOP_LABELS.portal_needs_candidate;
  if (reason === 'owner_handoff') return 'affidata al candidato per l’ultimo passaggio';
  return HELD_LABELS[reason] || reason;
}

export default function AssistedApplicationAutomationPanel({
  order,
  user,
  onChanged,
}: {
  order: AssistedApplicationAdminOrder;
  user: { getIdToken: () => Promise<string> } | null | undefined;
  onChanged: (message: { ok: boolean; text: string }) => Promise<void> | void;
}) {
  const automation = order.automation || null;
  const flow = automation?.flow || null;
  const draft = automation?.draft || null;
  const [busy, setBusy] = useState<string | null>(null);
  const [letter, setLetter] = useState(draft?.coverLetter?.text || '');
  const [emailTo, setEmailTo] = useState(draft?.applicationEmail?.to || '');
  const [emailSubject, setEmailSubject] = useState(draft?.applicationEmail?.subject || '');
  const [emailBody, setEmailBody] = useState(draft?.applicationEmail?.body || '');
  const [answers, setAnswers] = useState<Record<string, string>>(flow?.answers || {});
  const [ackFacts, setAckFacts] = useState(false);
  const [ackKnockOut, setAckKnockOut] = useState(false);
  const [ackFlags, setAckFlags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setLetter(draft?.coverLetter?.text || '');
    setEmailTo(draft?.applicationEmail?.to || '');
    setEmailSubject(draft?.applicationEmail?.subject || '');
    setEmailBody(draft?.applicationEmail?.body || '');
    setAnswers(flow?.answers || {});
  }, [draft?.coverLetter?.text, draft?.applicationEmail?.to, draft?.applicationEmail?.subject, draft?.applicationEmail?.body, flow?.answers]);

  const act = async (action: AutomationAdminAction, extra: Record<string, unknown> = {}, success = 'Fatto.') => {
    if (busy) return;
    setBusy(action);
    try {
      await runAutomationAdminAction(user, order.orderId, action, extra);
      await onChanged({ ok: true, text: success });
    } catch (error) {
      await onChanged({ ok: false, text: error instanceof Error ? error.message : 'Operazione non riuscita.' });
    } finally {
      setBusy(null);
    }
  };

  // The fill extension (scripts/assisted-application/extension): its bridge
  // marks the page when installed. When the robot stopped on a portal,
  // Valerie sends the application from her browser; the extension fills it
  // and reports the portal's confirmation, which marks the order as sent.
  const [extensionVersion, setExtensionVersion] = useState('');
  useEffect(() => {
    const read = () => setExtensionVersion(document.documentElement.dataset.compilaCandidatura || '');
    read();
    const timer = window.setTimeout(read, 800);
    return () => window.clearTimeout(timer);
  }, []);
  const markedByExtension = useRef(false);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; type?: string; orderId?: string; status?: string; detail?: string; ok?: boolean; error?: string } | null;
      if (data?.source !== 'compila-candidatura' || data.orderId !== order.orderId) return;
      if (data.type === 'fill-opened' && !data.ok) {
        void onChanged({ ok: false, text: `L’estensione non ha aperto il portale: ${data.error || 'errore'}.` });
      } else if (data.type === 'fill-status' && data.status === 'submitted' && !markedByExtension.current) {
        markedByExtension.current = true;
        void act('automationMarkSubmitted', { via: 'extension' }, 'Il portale ha confermato l’invio: candidatura segnata come inviata, il cliente riceve la conferma.');
      } else if (data.type === 'fill-status' && data.status === 'clicked') {
        // Before the portal answers: the round is on record as possibly sent.
        void runAutomationAdminAction(user, order.orderId, 'automationMarkClicked').catch(() => {});
      } else if (data.type === 'fill-status' && data.status === 'ready') {
        void onChanged({ ok: true, text: 'Tutto compilato: sul portale premi il pulsante d’invio evidenziato.' });
      } else if (data.type === 'fill-status' && ['needs', 'stuck', 'refused'].includes(data.status || '')) {
        const why = data.status === 'refused' ? 'il portale dice che non ha inviato la candidatura' : data.status === 'stuck' ? 'troppi passaggi, continua tu' : `manca: ${data.detail || 'una risposta'}`;
        void onChanged({ ok: false, text: `Estensione ferma: ${why}.` });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
  const fillWithExtension = async () => {
    if (busy) return;
    setBusy('automationFillKit');
    try {
      let result: Record<string, unknown>;
      try {
        result = await runAutomationAdminAction(user, order.orderId, 'automationFillKit');
      } catch (error) {
        // The send button was already pressed with no confirmation: a kit only
        // after Valerie checked the portal (a second application could leave).
        if ((error as { code?: string })?.code !== 'submission_unconfirmed'
          || !window.confirm('Il pulsante d’invio è già stato premuto senza conferma del portale. Hai controllato sul portale che la candidatura NON sia arrivata?')) throw error;
        result = await runAutomationAdminAction(user, order.orderId, 'automationFillKit', { confirmNotReceived: true });
      }
      markedByExtension.current = false;
      window.postMessage({ source: 'frontaliere-queue', type: 'fill-order', kit: result.kit }, window.location.origin);
      await onChanged({ ok: true, text: 'Portale aperto in una nuova scheda: l’estensione compila e si ferma sul pulsante d’invio, che premi tu.' });
    } catch (error) {
      await onChanged({ ok: false, text: error instanceof Error ? error.message : 'Kit di compilazione non disponibile.' });
    } finally {
      setBusy(null);
    }
  };
  const portalUrl = draft?.channel?.type !== 'email' ? (draft?.channel?.applyUrl || draft?.job?.applyUrl || '') : '';

  // Kept in memory only for this view: the password never goes to the order list.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const reveal = async (host: string) => {
    if (busy) return;
    setBusy('automationRevealAccount');
    try {
      const body = await runAutomationAdminAction(user, order.orderId, 'automationRevealAccount', { host });
      setRevealed((current) => ({ ...current, [host]: String(body.password || '') }));
    } catch (error) {
      await onChanged({ ok: false, text: error instanceof Error ? error.message : 'Password non disponibile.' });
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy('uploadCv');
    try {
      await uploadAssistedApplicationCv(user, order.orderId, file);
      await onChanged({ ok: true, text: 'CV caricato: il controllo del file avvia l’automazione (se attiva).' });
    } catch (error) {
      await onChanged({ ok: false, text: error instanceof Error ? error.message : 'Caricamento non riuscito.' });
    } finally {
      setBusy(null);
    }
  };

  const button = 'inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';
  const primary = `${button} bg-accent text-on-accent hover:bg-accent-hover`;
  const secondary = `${button} border border-edge text-subtle hover:border-accent hover:text-link`;
  const spinner = (name: string) => (busy === name ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null);
  const unsupported = draft?.factCheck?.unsupported || [];
  const canUpload = order.paymentStatus === 'paid' && ['awaiting_upload', 'ready_for_manual_submission', 'in_progress', 'blocked'].includes(order.submissionStatus);

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-info-border bg-info-subtle/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-bold text-strong">
          <Bot size={16} className="text-info" aria-hidden="true" /> Automazione
        </h4>
        <span className="text-xs text-subtle">
          {flow ? `${STATE_LABELS[flow.state || ''] || flow.state} · giro ${flow.round}` : 'Non avviata'}
        </span>
      </div>

      {canUpload && (
        <label className={`${secondary} cursor-pointer`}>
          {busy === 'uploadCv' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UploadCloud size={14} aria-hidden="true" />}
          {order.hasCv ? 'Sostituisci CV (ricevuto via email)' : 'Carica CV ricevuto via email'}
          <input type="file" accept=".pdf,.doc,.docx" className="sr-only" disabled={Boolean(busy)} onChange={(event) => { void upload(event.target.files?.[0]); }} />
        </label>
      )}

      {!flow && order.hasCv && order.cvFileCheck === 'ok' && (
        <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => { void act('automationStart', {}, 'Automazione avviata: la bozza arriva in 10-15 minuti.'); }}>
          {spinner('automationStart') || <Play size={14} aria-hidden="true" />} Avvia automazione
        </button>
      )}

      {flow && (
        <dl className="grid gap-2 text-xs text-subtle sm:grid-cols-3">
          <div><dt className="font-semibold uppercase tracking-wide text-muted">Prossima scadenza</dt><dd>{formatMs(flow.deadlineAt)}</dd></div>
          <div><dt className="font-semibold uppercase tracking-wide text-muted">Fermo per</dt><dd>{flow.heldBy.length ? flow.heldBy.map(heldLabel).join(', ') : '—'}</dd></div>
          <div><dt className="font-semibold uppercase tracking-wide text-muted">Ultimo run</dt><dd>{flow.dispatch ? `${flow.dispatch.mode} · ${formatMs(flow.dispatch.requestedAt)} · tentativi ${flow.dispatch.attempts}` : '—'}</dd></div>
        </dl>
      )}

      {(automation?.inbox || []).length > 0 && (
        <div className="rounded-lg border border-edge bg-surface p-3 text-xs text-body">
          <p className="font-semibold uppercase tracking-wide text-muted">Risposte del datore (alias)</p>
          <ul className="mt-1 space-y-1">
            {(automation?.inbox || []).map((item) => (
              <li key={`${item.receivedAt}-${item.subject}`}>
                <strong>{INBOX_LABELS[item.category] || item.category}</strong> · {formatMs(item.receivedAt)} · {item.summaryIt || item.subject}
                {item.interviewWhen ? ` · quando: ${item.interviewWhen}` : ''}
                {item.forwarded === 'skipped' ? ' · letto dal runner (verifica account portale), non inoltrato' : item.forwarded !== 'sent' ? ' · inoltro al candidato NON riuscito' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(automation?.followup || automation?.interviewPrep) && (
        <div className="rounded-lg border border-edge bg-surface p-3 text-xs text-body">
          <p className="font-semibold uppercase tracking-wide text-muted">Dopo l’invio</p>
          {automation?.followup && (
            <p className="mt-1">
              <strong>Solleciti:</strong> {FOLLOWUP_STATES[automation.followup.state || ''] || automation.followup.state} · inviati {automation.followup.sent}/2
              {automation.followup.dueAt ? ` · prossimo passo ${formatMs(automation.followup.dueAt)}` : ''}
              {automation.followup.stopReason ? ` · motivo: ${automation.followup.stopReason}` : ''}
            </p>
          )}
          {automation?.followup?.pending && (
            <p className="mt-1 whitespace-pre-line rounded bg-surface-alt p-2 text-subtle">{automation.followup.pending.body}</p>
          )}
          {automation?.interviewPrep && (
            <p className="mt-1"><strong>Preparazione colloquio:</strong> {automation.interviewPrep.status}{automation.interviewPrep.sentAt ? ` il ${formatMs(automation.interviewPrep.sentAt)}` : ''} · {automation.interviewPrep.questions} domande, {automation.interviewPrep.stories} storie</p>
          )}
        </div>
      )}

      {(automation?.accounts || []).length > 0 && (
        <div className="rounded-lg border border-edge bg-surface p-3 text-xs text-body">
          <p className="font-semibold uppercase tracking-wide text-muted">Account sui portali (creati sull’alias)</p>
          <ul className="mt-1 space-y-1">
            {(automation?.accounts || []).map((account) => (
              <li key={account.host} className="flex flex-wrap items-center gap-2">
                <span><strong>{account.host}</strong> · {account.email} · creato {formatMs(account.createdAt)} · {account.verifiedAt ? `verificato ${formatMs(account.verifiedAt)}` : 'non verificato'}</span>
                {revealed[account.host]
                  ? <code className="rounded bg-surface-alt px-1.5 py-0.5 select-all">{revealed[account.host]}</code>
                  : (
                    <button type="button" className="rounded border border-edge px-2 py-0.5 hover:bg-surface-alt disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void reveal(account.host)}>
                      Mostra password
                    </button>
                  )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted">Per prendere in carico la candidatura sul portale. Ogni visualizzazione viene registrata.</p>
        </div>
      )}

      {flow && flow.feedback.length > 0 && (
        <div className="rounded-lg border border-warning-border bg-warning-subtle/50 p-3 text-xs text-body">
          <strong>Feedback del candidato:</strong>
          <ul className="mt-1 list-disc pl-4">{flow.feedback.map((item) => <li key={`${item.round}-${item.at}`}>giro {item.round}: {item.text}</li>)}</ul>
        </div>
      )}

      {draft && draft.status === 'ready' && (
        <div className="space-y-4">
          <div className="text-sm text-body">
            <p><strong>Verdetto:</strong> {VERDICT_LABELS[draft.verdict || ''] || '—'} · <strong>Canale:</strong> {draft.channel?.label || '—'}{draft.channel?.requiresAccount ? ' (richiede account)' : ''} · <strong>Lingua lettera:</strong> {draft.language || '—'} · <strong>CV letto con:</strong> {draft.cvTextMethod || '—'}</p>
            {draft.summaryIt && <p className="mt-1 text-subtle">{draft.summaryIt}</p>}
            {draft.checksIt.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-subtle">{draft.checksIt.map((item) => <li key={item}>{item}</li>)}</ul>}
            {draft.job?.applyUrl && <a className="mt-1 inline-block text-xs text-link hover:underline" href={draft.job.applyUrl} target="_blank" rel="noreferrer">Pagina di candidatura</a>}
          </div>

          {(draft.ats || draft.legitimacy || draft.tailoredCv) && (
            <div className="grid gap-2 text-xs text-body sm:grid-cols-2">
              {draft.ats && (
                <div className="rounded-lg border border-edge bg-surface p-3">
                  <p className="font-semibold uppercase tracking-wide text-muted">ATS (career-ops)</p>
                  <p className="mt-1">CV del candidato: <strong>{draft.ats.original.structural.grade}</strong> ({draft.ats.original.structural.score}/100) · parole chiave {draft.ats.original.keywords.coverage ?? '—'}%</p>
                  {draft.ats.tailored && <p>CV adattato: <strong>{draft.ats.tailored.structural.grade}</strong> ({draft.ats.tailored.structural.score}/100) · parole chiave {draft.ats.tailored.keywords.coverage ?? '—'}%</p>}
                  {draft.ats.original.keywords.missing.length > 0 && <p className="mt-1 text-muted">Mancano nel CV: {draft.ats.original.keywords.missing.join(', ')}</p>}
                  {draft.ats.original.structural.issues.length > 0 && <p className="text-muted">Problemi: {draft.ats.original.structural.issues.map((issue) => `${issue.code} (${issue.severity})`).join(', ')}</p>}
                </div>
              )}
              {draft.legitimacy && (
                <div className={`rounded-lg border p-3 ${draft.legitimacy.tier === 'suspicious' ? 'border-danger-border bg-danger-subtle/50' : 'border-edge bg-surface'}`}>
                  <p className="font-semibold uppercase tracking-wide text-muted">Legittimità annuncio (Block G)</p>
                  <p className="mt-1"><strong>{LEGITIMACY_TIERS[draft.legitimacy.tier] || draft.legitimacy.tier}</strong>{draft.legitimacy.ageDays !== null ? ` · ${draft.legitimacy.ageDays} giorni` : ' · data non nota'}</p>
                  <p className="text-muted">{draft.legitimacy.signals.filter((signal) => signal.weight !== 'neutral').map((signal) => `${signal.weight === 'positive' ? '+' : '−'} ${signal.key}`).join(' · ') || 'nessun segnale netto'}</p>
                  {draft.legitimacy.notes.length > 0 && <p className="text-muted">Note: {draft.legitimacy.notes.map((note) => (note.quote ? `${note.key} «${note.quote}»` : note.key)).join(' · ')}</p>}
                  {(flow?.heldBy || []).includes('legitimacy') && (
                    <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={Boolean(ackFlags.legitimacy)} onChange={(event) => setAckFlags((current) => ({ ...current, legitimacy: event.target.checked }))} /> Ho verificato l’annuncio: invia comunque</label>
                  )}
                </div>
              )}
              {draft.tailoredCv && (
                <div className="rounded-lg border border-edge bg-surface p-3 sm:col-span-2">
                  <p className="font-semibold uppercase tracking-wide text-muted">CV adattato ATS</p>
                  <p className="mt-1">
                    {TAILORED_CV_LABELS[draft.tailoredCv.status] || draft.tailoredCv.status} · scelta del candidato: {draft.cvChoice === 'original' ? 'CV originale' : 'CV adattato'}
                    {draft.tailoredCv.url && <> · <a className="text-link hover:underline" href={draft.tailoredCv.url} target="_blank" rel="noreferrer">apri il PDF</a></>}
                  </p>
                  {draft.tailoredCv.unsupported.length > 0 && <p className="text-muted">Fatti non trovati: {draft.tailoredCv.unsupported.map((item) => item.token).join(', ')}</p>}
                  {draft.tailoredCv.dropped.length > 0 && <p className="text-muted">Competenze scartate (non nel CV): {draft.tailoredCv.dropped.join(', ')}</p>}
                </div>
              )}
            </div>
          )}

          <details className="rounded-lg border border-edge bg-surface p-3 text-xs">
            <summary className="cursor-pointer font-semibold text-strong">Requisiti e prove ({draft.requirements.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {draft.requirements.map((requirement, index) => {
                const match = draft.matches.find((item) => item.index === index);
                return (
                  <li key={`${requirement.requirement}-${index}`}>
                    <span className={`font-semibold ${MATCH_STYLES[match?.status || 'missing']}`}>[{match?.status || 'n/d'}]</span>{' '}
                    {requirement.requirement} <span className="text-muted">({requirement.importance}{requirement.basis === 'inferred' ? ', dedotto' : ''})</span>
                    {match?.evidence && <span className="block text-muted">CV: «{match.evidence}»</span>}
                  </li>
                );
              })}
            </ul>
          </details>

          {draft.questions.length > 0 && (
            <div className="space-y-2 rounded-lg border border-edge bg-surface p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Domande per il candidato (puoi rispondere tu se te lo ha detto via email)</p>
              {draft.questions.map((question) => (
                <label key={question.id} className="block text-xs text-body">
                  {question.question}{question.required ? ' *' : ''}
                  <input value={answers[question.id] || ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} className="mt-1 w-full rounded border border-edge bg-surface-alt px-2 py-1.5 text-sm" />
                </label>
              ))}
              <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { void act('automationSetAnswers', { answers }, 'Risposte salvate.'); }}>
                {spinner('automationSetAnswers') || <Save size={14} aria-hidden="true" />} Salva risposte
              </button>
            </div>
          )}

          {unsupported.length > 0 && (
            <div className="rounded-lg border border-danger-border bg-danger-subtle/50 p-3 text-xs text-body">
              <p className="flex items-center gap-1 font-semibold text-danger"><AlertTriangle size={14} aria-hidden="true" /> Fatti non trovati nel CV o nell’annuncio</p>
              <ul className="mt-1 list-disc pl-4">{unsupported.map((item) => <li key={`${item.field}-${item.token}`}><strong>{item.token}</strong> ({item.kind}) — «{item.context}»</li>)}</ul>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ackFacts} onChange={(event) => setAckFacts(event.target.checked)} /> Ho verificato: sono corretti</label>
            </div>
          )}
          {draft.verdict === 'poor' && !draft.knockOutAcknowledgedAt && (
            <label className="flex items-center gap-2 text-xs text-body"><input type="checkbox" checked={ackKnockOut} onChange={(event) => setAckKnockOut(event.target.checked)} /> Il CV non soddisfa un requisito indispensabile: invia comunque</label>
          )}
          {/* The other owner flags: approving needs an explicit acknowledgement of each (409 owner_flags_open otherwise). */}
          {(flow?.heldBy || []).filter((flag) => OTHER_OWNER_FLAGS[flag]).map((flag) => (
            <label key={flag} className="flex items-center gap-2 text-xs text-body">
              <input type="checkbox" checked={Boolean(ackFlags[flag])} onChange={(event) => setAckFlags((current) => ({ ...current, [flag]: event.target.checked }))} /> {OTHER_OWNER_FLAGS[flag]}
            </label>
          ))}

          {(draft.candidateEditedAt || Object.keys(flow?.formOverrides || {}).length > 0) && (
            <p className="rounded-lg border border-info-border bg-info-subtle/60 px-3 py-2 text-xs text-body">
              Il candidato ha modificato {draft.candidateEditedAt ? `i testi (${formatMs(draft.candidateEditedAt)})` : 'i suoi dati'}
              {Object.keys(flow?.formOverrides || {}).length > 0 && `; campi: ${Object.keys(flow?.formOverrides || {}).join(', ')}`}.
            </p>
          )}
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
            Lettera ({draft.language})
            <textarea value={letter} onChange={(event) => setLetter(event.target.value)} rows={10} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm normal-case tracking-normal text-body" />
          </label>
          {draft.coverLetterUrl && <a className="inline-flex items-center gap-1 text-xs text-link hover:underline" href={draft.coverLetterUrl} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" /> PDF lettera</a>}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
              Email a (vuoto = portale)
              <input value={emailTo} onChange={(event) => setEmailTo(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm normal-case tracking-normal text-body" />
            </label>
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
              Oggetto
              <input value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm normal-case tracking-normal text-body" />
            </label>
          </div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
            Testo email
            <textarea value={emailBody} onChange={(event) => setEmailBody(event.target.value)} rows={6} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm normal-case tracking-normal text-body" />
          </label>
          <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { void act('automationEditDraft', { coverLetterText: letter, emailTo, emailSubject, emailBody }, 'Bozza aggiornata e ricontrollata.'); }}>
            {spinner('automationEditDraft') || <Save size={14} aria-hidden="true" />} Salva modifiche
          </button>
        </div>
      )}

      {flow && (
        <>
        {['owner_takeover', 'candidate_handoff'].includes(flow.state || '') && Boolean(draft?.portalAnswers?.answers?.length) && (
          <details className="rounded-lg border border-edge p-3 text-sm">
            <summary className="cursor-pointer font-medium">Già inserito nel portale ({draft?.portalAnswers?.answers.length} risposte)</summary>
            <dl className="mt-2 space-y-1">
              {draft?.portalAnswers?.answers.map((item) => (
                <div key={item.question} className="flex flex-col sm:flex-row sm:gap-2">
                  <dt className="text-muted sm:w-1/2">{item.question}</dt>
                  <dd className="break-words sm:w-1/2">{item.answer}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        <div className="flex flex-wrap gap-2 border-t border-edge pt-3">
          {flow.state === 'owner_review' && (
            <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => { void act('automationApprove', { acknowledgeFactWarnings: ackFacts, acknowledgeKnockOut: ackKnockOut, acknowledgeFlags: Object.keys(ackFlags).filter((flag) => ackFlags[flag]) }, 'Approvata: ora tocca al candidato (12 ore).'); }}>
              {spinner('automationApprove') || <Send size={14} aria-hidden="true" />} Approva ora
            </button>
          )}
          {['owner_review', 'owner_takeover', 'candidate_review'].includes(flow.state || '') && (
            <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { void act('automationRegenerate', {}, 'Nuova bozza richiesta.'); }}>
              {spinner('automationRegenerate') || <RefreshCw size={14} aria-hidden="true" />} Rigenera
            </button>
          )}
          {['owner_takeover', 'candidate_handoff'].includes(flow.state || '') && draft?.round === flow.round && (
            <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => { void act('automationRetrySubmit', {}, 'Invio automatico rilanciato: parte entro pochi minuti.'); }}>
              {spinner('automationRetrySubmit') || <Send size={14} aria-hidden="true" />} Riprova l’invio automatico
            </button>
          )}
          {flow.state === 'owner_takeover' && draft?.round === flow.round && portalUrl && (extensionVersion ? (
            <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => { void fillWithExtension(); }}>
              {spinner('automationFillKit') || <Wand2 size={14} aria-hidden="true" />} Compila con l’estensione
            </button>
          ) : (
            <p className="w-full text-xs text-subtle">Per compilare il portale con un clic installa l’estensione «Compila candidatura» (cartella <code>scripts/assisted-application/extension</code>, istruzioni nel README).</p>
          ))}
          {flow.state === 'owner_takeover' && draft?.round === flow.round && (
            <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { if (window.confirm('Confermi che la candidatura è stata inviata sul portale? Il cliente riceverà l’email di conferma.')) void act('automationMarkSubmitted', {}, 'Candidatura segnata come inviata: il cliente riceve la conferma.'); }}>
              {spinner('automationMarkSubmitted') || <CheckCircle2 size={14} aria-hidden="true" />} Segna come inviata
            </button>
          )}
          {flow.state === 'owner_takeover' && draft?.round === flow.round && (
            <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { if (window.confirm('Il candidato riceverà un’email per completare lui l’invio sul portale. Procedere?')) void act('automationHandoff', {}, 'Affidata al candidato: riceve link, risposte e documenti.'); }}>
              {spinner('automationHandoff') || <UserCheck size={14} aria-hidden="true" />} Affida al candidato
            </button>
          )}
          {flow.state === 'owner_takeover' ? (
            <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { void act('automationResume', {}, 'Automazione ripresa.'); }}>
              {spinner('automationResume') || <CheckCircle2 size={14} aria-hidden="true" />} Riprendi automazione
            </button>
          ) : flow.state !== 'submitted' && (
            <button type="button" className={secondary} disabled={Boolean(busy)} onClick={() => { void act('automationTakeover', {}, 'Automazione sospesa: la gestisci tu.'); }}>
              {spinner('automationTakeover') || <Pause size={14} aria-hidden="true" />} Prendi in carico
            </button>
          )}
        </div>
        </>
      )}
    </div>
  );
}
