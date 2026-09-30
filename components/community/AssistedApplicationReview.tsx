import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Copy, ExternalLink, FileText, Loader2, MessageSquare, Pencil, Send, UserCheck } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { answerMessage, validateAnswer } from '@/functions/src/lib/answerRules.js';
import {
  fetchReview,
  ReviewRequestError,
  sendReviewAction,
  type FollowupPayload,
  type ReviewAction,
  type ReviewFormField,
  type ReviewPayload,
  type ReviewQuestion,
} from '@/services/assistedApplicationReviewService';

/**
 * Candidate review page of the automated assisted application, opened from
 * the signed link of the review e-mails (`?assisted_application_review=`).
 * The candidate approves, asks for changes, answers what only they know, or —
 * when a portal needs a human step — finishes on the portal with the kit and
 * confirms (career-ops "browser handoff").
 */

const WAITING_STATES = new Set(['drafting', 'regenerating', 'owner_review', 'submitting']);
const INTL: Record<string, string> = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };

function formatDeadline(ms: number | null, locale: string): string {
  if (!ms) return '';
  try {
    return new Intl.DateTimeFormat(INTL[locale] || 'it-CH', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}
      className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-2.5 text-xs font-semibold text-subtle hover:border-accent hover:text-link"
    >
      {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </button>
  );
}

function QuestionField({ question, value, onChange, disabled, error }: {
  question: ReviewQuestion;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const inputClass = 'mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-heading';
  return (
    <label className="block text-sm font-medium text-body">
      {question.question}{question.required && <span className="text-danger"> *</span>}
      {question.why && <span className="mt-0.5 block text-xs font-normal text-subtle">{question.why}</span>}
      {question.type === 'yes_no' ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className={inputClass}>
          <option value="">—</option>
          <option value={t('jobBoard.assisted.review.yes')}>{t('jobBoard.assisted.review.yes')}</option>
          <option value={t('jobBoard.assisted.review.no')}>{t('jobBoard.assisted.review.no')}</option>
        </select>
      ) : question.type === 'choice' && question.options.length ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className={inputClass}>
          <option value="">—</option>
          {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input
          // Numbers as text: "80'000" is a valid Swiss amount the number input would refuse.
          type={question.type === 'date' ? 'date' : 'text'}
          inputMode={question.type === 'number' ? 'decimal' : undefined}
          min={question.type === 'date' ? question.minDate || undefined : undefined}
          placeholder={question.validation?.example || undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          maxLength={question.validation?.maxLength || 500}
          className={inputClass}
          aria-invalid={error ? true : undefined}
        />
      )}
      {error && <span className="mt-1 block text-xs font-normal text-danger" role="alert">{error}</span>}
    </label>
  );
}

type EditDraft = { coverLetterText: string; emailSubject: string; emailBody: string; fields: Record<string, string> };

const TEXT_FIELDS = new Set(['motivationShort', 'whyCompany']);

function EditField({ field, value, onChange, disabled, error }: {
  field: ReviewFormField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const { t } = useTranslation();
  const label = t(`jobBoard.assisted.review.field.${field.key}`, field.label);
  const inputClass = 'mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-heading disabled:bg-surface-alt disabled:text-subtle';
  if (!field.editable) {
    return (
      <div className="text-sm">
        <p className="font-medium text-body">{label}</p>
        <p className="mt-1 break-words rounded-lg border border-edge bg-surface-alt px-3 py-2 text-subtle">{field.value || '—'}</p>
        {field.locked && (
          <p className="mt-1 text-xs text-subtle">
            {t(field.locked === 'alias' ? 'jobBoard.assisted.review.lockedAlias' : 'jobBoard.assisted.review.lockedQuestion')}
          </p>
        )}
      </div>
    );
  }
  const common = {
    value,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    disabled,
    maxLength: field.validation?.maxLength || 200,
    placeholder: field.validation?.example || undefined,
    className: inputClass,
    'aria-invalid': error ? true : undefined,
  };
  return (
    <label className="block text-sm font-medium text-body">
      {label}{field.required && <span className="text-danger"> *</span>}
      {TEXT_FIELDS.has(field.key) ? <textarea rows={3} {...common} /> : <input type={field.key === 'phone' ? 'tel' : 'text'} {...common} />}
      {error && <span className="mt-1 block text-xs font-normal text-danger" role="alert">{error}</span>}
    </label>
  );
}

export default function AssistedApplicationReview({ token }: { token: string }) {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the server refused on save, per question id.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Fields the candidate touched: their rule is checked as they type.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [followup, setFollowup] = useState<FollowupPayload | null>(null);
  // The candidate's own changes to the letter, the e-mail and the fields.
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<EditDraft>({ coverLetterText: '', emailSubject: '', emailBody: '', fields: {} });
  const [editTouched, setEditTouched] = useState<Record<string, boolean>>({});
  const [editServerErrors, setEditServerErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const payload = await fetchReview(token);
      if ('kind' in payload && payload.kind === 'followup') {
        setFollowup(payload);
        setError(null);
        return;
      }
      const review = payload as ReviewPayload;
      setData(review);
      // An empty start date shows the proposed one; it counts only once saved.
      const proposed = Object.fromEntries((review.questions || [])
        .filter((question) => question.suggested && !String(review.answers?.[question.id] || '').trim())
        .map((question) => [question.id, question.suggested as string]));
      setAnswers({ ...(review.answers || {}), ...proposed });
      setError(null);
    } catch (reason) {
      setError(reason instanceof ReviewRequestError ? reason.code : 'network');
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // While the agent works (drafting, sending) the page refreshes itself.
  useEffect(() => {
    if (!data || !WAITING_STATES.has(data.state)) return undefined;
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [data, load]);

  const run = async (action: ReviewAction, extra = {}): Promise<boolean> => {
    if (busy) return false;
    setBusy(action);
    setError(null);
    setFieldErrors({});
    setEditServerErrors({});
    try {
      await sendReviewAction(token, action, extra);
      setDone(action);
      await load();
      return true;
    } catch (reason) {
      setError(reason instanceof ReviewRequestError ? reason.code : 'network');
      if (reason instanceof ReviewRequestError) {
        // An edit's field keys may share a name with a question id (availability).
        if (action === 'edit') setEditServerErrors(reason.fields || {});
        else setFieldErrors(reason.fields || {});
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  // The same rules the server applies on save (functions/src/lib/answerRules.js).
  const clientErrors = useMemo(() => {
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const errors: Record<string, string> = {};
    for (const question of data?.questions || []) {
      const view = { ...question, required: false };
      const result = validateAnswer(answers[question.id] || '', view, { todayIso });
      if (!result.ok) errors[question.id] = answerMessage(result, view, locale || 'it');
    }
    return errors;
  }, [data, answers, locale]);

  const saveAnswers = () => {
    if (Object.keys(clientErrors).length) {
      setTouched(Object.fromEntries(Object.keys(clientErrors).map((id) => [id, true])));
      return;
    }
    void run('answers', { answers });
  };

  // Fields shown to the candidate: an e-mail application uses only the letter header.
  const shownFields = useMemo(
    () => (data?.formAnswers || []).filter((field) => (data?.job.channel === 'email' ? field.inLetter : true)),
    [data],
  );

  const startEditing = () => {
    if (!data) return;
    setEdits({
      coverLetterText: data.coverLetter?.text || '',
      emailSubject: data.applicationEmail?.subject || '',
      emailBody: data.applicationEmail?.body || '',
      fields: Object.fromEntries(shownFields.filter((field) => field.editable).map((field) => [field.key, field.value])),
    });
    setEditTouched({});
    setEditServerErrors({});
    setDone(null);
    setEditing(true);
  };

  // The same checks the server runs (assistedApplicationCandidateEdits.js).
  const editErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!editing || !data) return errors;
    const limits = data.editLimits;
    const checkText = (key: 'coverLetterText' | 'emailSubject' | 'emailBody', value: string) => {
      const limit = limits?.[key];
      const length = value.trim().length;
      if (limit && length < limit.min) errors[key] = t('jobBoard.assisted.review.textTooShort');
      else if (limit && length > limit.max) errors[key] = t('jobBoard.assisted.review.textTooLong');
    };
    checkText('coverLetterText', edits.coverLetterText);
    if (data.applicationEmail) {
      checkText('emailSubject', edits.emailSubject);
      checkText('emailBody', edits.emailBody);
    }
    for (const field of shownFields) {
      if (!field.editable || !(field.key in edits.fields)) continue;
      const value = edits.fields[field.key].trim();
      if (!value) {
        if (field.required) errors[field.key] = t('jobBoard.assisted.review.fieldRequired');
        continue;
      }
      if (field.validation && value.length > field.validation.maxLength) {
        errors[field.key] = t('jobBoard.assisted.review.textTooLong');
        continue;
      }
      const view = { type: 'text' as const, required: false, validation: field.validation };
      const result = validateAnswer(value, view);
      if (!result.ok) errors[field.key] = answerMessage(result, view, locale || 'it');
    }
    return errors;
  }, [editing, data, edits, shownFields, t, locale]);

  const editError = (key: string) => editServerErrors[key] || (editTouched[key] ? editErrors[key] : '');

  const saveEdits = async () => {
    if (Object.keys(editErrors).length) {
      setEditTouched(Object.fromEntries(Object.keys(editErrors).map((key) => [key, true])));
      return;
    }
    const saved = await run('edit', {
      coverLetterText: edits.coverLetterText,
      ...(data?.applicationEmail ? { emailSubject: edits.emailSubject, emailBody: edits.emailBody } : {}),
      fields: edits.fields,
    });
    if (saved) setEditing(false);
  };

  const changeEdit = (key: string, value: string, field = false) => {
    setEdits((current) => (field ? { ...current, fields: { ...current.fields, [key]: value } } : { ...current, [key]: value }));
    setEditTouched((current) => ({ ...current, [key]: true }));
    setEditServerErrors((current) => ({ ...current, [key]: '' }));
  };

  const openRequired = useMemo(
    () => (data?.questions || []).filter((question) => question.required && !String(answers[question.id] || '').trim()),
    [data, answers],
  );
  const pageLocale = data?.locale || locale || 'it';

  const errorText = error ? t(`jobBoard.assisted.review.error.${error}`, t('jobBoard.assisted.review.error.generic')) : null;

  // A follow-up to the employer (af1 link): send it now, or stop it.
  if (followup) {
    const followupLocale = followup.locale || locale || 'it';
    return (
      <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <section className="space-y-5 rounded-2xl border border-edge bg-surface p-5 sm:p-7">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">{t('jobBoard.assisted.pageEyebrow')}</p>
            <h1 className="mt-1 text-2xl font-bold font-display text-heading">{t('jobBoard.assisted.followup.title')}</h1>
            <p className="mt-1 text-sm text-subtle">{followup.job.title} — {followup.job.company}</p>
          </div>
          <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.followup.intro', { company: followup.job.company })}</p>
          <div className="whitespace-pre-line rounded-xl border border-edge bg-surface-alt p-4 text-sm leading-relaxed text-body">{followup.body}</div>
          {followup.state === 'awaiting_candidate' && (
            <p className="flex items-start gap-2 text-sm text-body">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              {t('jobBoard.assisted.followup.autoAt', { deadline: formatDeadline(followup.deadlineAt, followupLocale) })}
            </p>
          )}
          {followup.state === 'sent' && <p className="text-sm text-success" role="status">{t('jobBoard.assisted.followup.sent')}</p>}
          {followup.state === 'stopped' && <p className="text-sm text-subtle" role="status">{t('jobBoard.assisted.followup.stopped')}</p>}
          {!['awaiting_candidate', 'sent', 'stopped'].includes(followup.state) && <p className="text-sm text-subtle" role="status">{t('jobBoard.assisted.followup.gone')}</p>}
          {errorText && <p className="text-sm text-danger" role="alert">{errorText}</p>}
          {followup.can.send && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={Boolean(busy)} onClick={() => { void run('followup_send'); }} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
                {busy === 'followup_send' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />} {t('jobBoard.assisted.followup.send')}
              </button>
              <button type="button" disabled={Boolean(busy)} onClick={() => { void run('followup_skip'); }} className="inline-flex items-center gap-2 rounded-xl border border-edge px-4 py-2.5 text-sm font-semibold text-body hover:bg-surface-alt disabled:opacity-60">
                {t('jobBoard.assisted.followup.skip')}
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <section className="space-y-6 rounded-2xl border border-edge bg-surface p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">{t('jobBoard.assisted.pageEyebrow')}</p>
            <h1 className="mt-1 text-2xl font-bold font-display text-heading">{t('jobBoard.assisted.review.title')}</h1>
            {data && <p className="mt-1 text-sm text-subtle">{data.job.title} — {data.job.company}</p>}
          </div>
        </div>

        {!data && !error && (
          <div className="flex items-center gap-2 text-sm text-subtle" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('jobBoard.assisted.loading')}
          </div>
        )}

        {data?.stale && !data.preparingNext && (
          <div className="rounded-xl border border-warning-border bg-warning-subtle/60 p-4 text-sm text-body" role="status">
            {t('jobBoard.assisted.review.stale')}
          </div>
        )}

        {data && (!data.stale || data.preparingNext) && WAITING_STATES.has(data.state) && (
          // A waiting state is saved work in a queue, not a request in flight:
          // the candidate can close the page, the e-mail tells them what happened.
          data.state === 'submitting' ? (
            <div className="flex items-start gap-3 rounded-xl border border-success-border bg-success-subtle p-4" role="status">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
              <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.review.waiting.submitting')}</p>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-subtle/60 p-4" role="status">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
              <p className="text-sm leading-relaxed text-body">{t(`jobBoard.assisted.review.waiting.${data.state}`)}</p>
            </div>
          )
        )}

        {data && data.state === 'submitted' && (
          <div className="flex items-start gap-3 rounded-xl border border-success-border bg-success-subtle p-4" role="status">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.review.submitted')}</p>
          </div>
        )}

        {data && data.state === 'owner_takeover' && (
          <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-subtle/60 p-4" role="status">
            <UserCheck className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.review.takeover')}</p>
          </div>
        )}

        {data && !data.stale && data.state === 'candidate_review' && (
          <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-subtle/60 p-4">
            <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-body">
              {openRequired.length
                ? t('jobBoard.assisted.review.heldByQuestions')
                : t('jobBoard.assisted.review.autoApproveAt', { deadline: formatDeadline(data.deadlineAt, pageLocale) })}
            </p>
          </div>
        )}

        {data && data.can.answer && data.questions.length > 0 && (
          <form
            className="space-y-4 rounded-xl border border-edge bg-surface-alt p-4"
            onSubmit={(event) => { event.preventDefault(); saveAnswers(); }}
          >
            <h2 className="text-base font-bold text-heading">{t('jobBoard.assisted.review.questionsTitle')}</h2>
            {data.questions.map((question) => (
              <QuestionField
                key={question.id}
                question={question}
                value={answers[question.id] || ''}
                onChange={(value) => {
                  setAnswers((current) => ({ ...current, [question.id]: value }));
                  setTouched((current) => ({ ...current, [question.id]: true }));
                  setFieldErrors((current) => ({ ...current, [question.id]: '' }));
                }}
                disabled={Boolean(busy)}
                error={fieldErrors[question.id] || (touched[question.id] ? clientErrors[question.id] : '')}
              />
            ))}
            <button type="submit" disabled={Boolean(busy)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-accent px-4 text-sm font-semibold text-accent hover:bg-accent-subtle disabled:opacity-60">
              {busy === 'answers' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('jobBoard.assisted.review.saveAnswers')}
            </button>
            {done === 'answers' && (openRequired.length
              ? <p className="text-xs text-warning" role="status">{t('jobBoard.assisted.review.answersStillOpen')}</p>
              : <p className="text-xs text-success" role="status">{t('jobBoard.assisted.review.answersSaved')}</p>)}
          </form>
        )}

        {data && data.ready && (data.state === 'candidate_review' || data.state === 'candidate_handoff') && data.coverLetter && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold text-heading">{t('jobBoard.assisted.review.letterTitle')}</h2>
              <div className="flex flex-wrap items-center gap-3">
                {data.coverLetterUrl && (
                  <a href={data.coverLetterUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline">
                    <FileText className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.letterPdf')}
                  </a>
                )}
                {data.can.edit && !editing && (
                  <button type="button" onClick={startEditing} disabled={Boolean(busy)} className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-edge px-3 text-sm font-semibold text-body hover:border-accent hover:text-link disabled:opacity-60">
                    <Pencil className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.edit')}
                  </button>
                )}
              </div>
            </div>
            {done === 'edit' && !editing && <p className="text-xs text-success" role="status">{t('jobBoard.assisted.review.editsSaved')}</p>}
            {editing ? (
              <form className="space-y-4 rounded-xl border border-accent-border bg-accent-subtle/30 p-4" onSubmit={(event) => { event.preventDefault(); void saveEdits(); }}>
                <p className="text-sm text-body">{t(data.applicationEmail ? 'jobBoard.assisted.review.editIntroEmail' : 'jobBoard.assisted.review.editIntro')}</p>
                <label className="block text-sm font-medium text-body">
                  {t('jobBoard.assisted.review.letterLabel')}
                  <textarea
                    value={edits.coverLetterText}
                    onChange={(event) => changeEdit('coverLetterText', event.target.value)}
                    rows={14}
                    maxLength={data.editLimits?.coverLetterText.max || 8000}
                    disabled={Boolean(busy)}
                    className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm leading-relaxed text-heading"
                    aria-invalid={editError('coverLetterText') ? true : undefined}
                  />
                  {editError('coverLetterText') && <span className="mt-1 block text-xs font-normal text-danger" role="alert">{editError('coverLetterText')}</span>}
                </label>
                {data.applicationEmail && (
                  <div className="space-y-3">
                    <label className="block text-sm font-medium text-body">
                      {t('jobBoard.assisted.review.emailSubjectLabel')}
                      <input
                        type="text"
                        value={edits.emailSubject}
                        onChange={(event) => changeEdit('emailSubject', event.target.value)}
                        maxLength={data.editLimits?.emailSubject.max || 250}
                        disabled={Boolean(busy)}
                        className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-heading"
                        aria-invalid={editError('emailSubject') ? true : undefined}
                      />
                      {editError('emailSubject') && <span className="mt-1 block text-xs font-normal text-danger" role="alert">{editError('emailSubject')}</span>}
                    </label>
                    <label className="block text-sm font-medium text-body">
                      {t('jobBoard.assisted.review.emailBodyLabel')}
                      <textarea
                        value={edits.emailBody}
                        onChange={(event) => changeEdit('emailBody', event.target.value)}
                        rows={10}
                        maxLength={data.editLimits?.emailBody.max || 4000}
                        disabled={Boolean(busy)}
                        className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm leading-relaxed text-heading"
                        aria-invalid={editError('emailBody') ? true : undefined}
                      />
                      {editError('emailBody') && <span className="mt-1 block text-xs font-normal text-danger" role="alert">{editError('emailBody')}</span>}
                    </label>
                  </div>
                )}
                {shownFields.length > 0 && (
                  <fieldset className="space-y-3">
                    <legend className="text-sm font-semibold text-heading">{t('jobBoard.assisted.review.fieldsTitle')}</legend>
                    {shownFields.map((field) => (
                      <EditField
                        key={field.key}
                        field={field}
                        value={edits.fields[field.key] ?? field.value}
                        onChange={(value) => changeEdit(field.key, value, true)}
                        disabled={Boolean(busy)}
                        error={editError(field.key)}
                      />
                    ))}
                  </fieldset>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="submit" disabled={Boolean(busy)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60">
                    {busy === 'edit' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    {t('jobBoard.assisted.review.saveEdits')}
                  </button>
                  <button type="button" onClick={() => { setEditing(false); setEditServerErrors({}); }} disabled={Boolean(busy)} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-edge px-4 text-sm font-semibold text-subtle hover:border-accent hover:text-link disabled:opacity-60">
                    {t('jobBoard.assisted.review.cancelEdits')}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="max-h-96 overflow-y-auto whitespace-pre-line rounded-xl border border-edge bg-surface-alt p-4 text-sm leading-relaxed text-body">
                  {data.coverLetter.text}
                </div>
                {data.applicationEmail && (
                  <details className="rounded-xl border border-edge p-4 text-sm">
                    <summary className="cursor-pointer font-semibold text-heading">{t('jobBoard.assisted.review.emailTitle', { to: data.applicationEmail.to })}</summary>
                    <p className="mt-2 font-medium text-body">{data.applicationEmail.subject}</p>
                    <p className="mt-2 whitespace-pre-line text-subtle">{data.applicationEmail.body}</p>
                  </details>
                )}
                {data.state === 'candidate_review' && shownFields.some((field) => field.value) && (
                  <details className="rounded-xl border border-edge p-4 text-sm">
                    <summary className="cursor-pointer font-semibold text-heading">{t('jobBoard.assisted.review.fieldsTitle')}</summary>
                    <dl className="mt-2 space-y-2">
                      {shownFields.filter((field) => field.value).map((field) => (
                        <div key={field.key}>
                          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{t(`jobBoard.assisted.review.field.${field.key}`, field.label)}</dt>
                          <dd className="mt-0.5 break-words text-body">{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </>
            )}
            {data.tailoredCv && (
              <div className="space-y-2 rounded-xl border border-edge p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-heading">{t('jobBoard.assisted.review.cvTitle')}</h3>
                  {data.tailoredCv.url && (
                    <a href={data.tailoredCv.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-link hover:underline">
                      <FileText className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.cvPdf')}
                    </a>
                  )}
                </div>
                <p className="text-subtle">{t('jobBoard.assisted.review.cvIntro')}</p>
                {data.ats?.original && (
                  <p className="text-xs text-subtle">
                    {t('jobBoard.assisted.review.cvAts', {
                      before: data.ats.original.keywordCoverage ?? '—',
                      after: data.ats.tailored?.keywordCoverage ?? '—',
                    })}
                  </p>
                )}
                <fieldset className="space-y-1" disabled={!data.can.chooseCv || Boolean(busy)}>
                  {(['tailored', 'original'] as const).map((choice) => (
                    <label key={choice} className="flex items-center gap-2">
                      <input type="radio" name="cv-choice" checked={data.tailoredCv?.choice === choice} onChange={() => { void run('cv_choice', { cvChoice: choice }); }} />
                      {t(choice === 'tailored' ? 'jobBoard.assisted.review.cvChooseTailored' : 'jobBoard.assisted.review.cvChooseOriginal')}
                    </label>
                  ))}
                </fieldset>
              </div>
            )}
          </div>
        )}

        {data && data.state === 'candidate_handoff' && (
          <div className="space-y-4 rounded-xl border border-accent-border bg-accent-subtle/40 p-4">
            <h2 className="text-base font-bold text-heading">{t('jobBoard.assisted.review.handoffTitle')}</h2>
            <p className="text-sm leading-relaxed text-body">{t('jobBoard.assisted.review.handoffBody')}</p>
            {data.job.applyUrl && (
              <a href={data.job.applyUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover">
                <ExternalLink className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.openPortal')}
              </a>
            )}
            <ol className="space-y-2">
              {data.formAnswers.filter((field) => field.value).map((field, index) => (
                <li key={field.key} className="rounded-lg border border-edge bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{index + 1}. {t(`jobBoard.assisted.review.field.${field.key}`, field.label)}</p>
                      <p className="mt-1 break-words text-sm text-body">{field.value}</p>
                    </div>
                    <CopyButton value={field.value} label={t('jobBoard.assisted.review.copy')} />
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={() => { void run('confirm_submitted'); }}
              disabled={Boolean(busy) || !data.can.confirmSubmitted}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
            >
              {busy === 'confirm_submitted' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {t('jobBoard.assisted.review.confirmSubmitted')}
            </button>
          </div>
        )}

        {data && data.state === 'candidate_review' && !data.stale && (
          <div className="space-y-3 border-t border-edge pt-4">
            <button
              type="button"
              onClick={() => { void run('approve'); }}
              disabled={Boolean(busy) || !data.can.approve || editing}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
              {t('jobBoard.assisted.review.approve')}
            </button>
            {editing && <p className="text-xs text-subtle">{t('jobBoard.assisted.review.finishEditing')}</p>}
            {!showFeedback ? (
              <button type="button" onClick={() => setShowFeedback(true)} disabled={!data.can.reject} className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-edge px-4 text-sm font-semibold text-subtle hover:border-accent hover:text-link">
                <MessageSquare className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.requestChanges')}
              </button>
            ) : (
              <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run('reject', { feedback }); }}>
                <label className="block text-sm font-medium text-body">
                  {t('jobBoard.assisted.review.feedbackLabel')}
                  <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} maxLength={2000} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-heading" />
                </label>
                <p className="text-xs text-subtle">{t('jobBoard.assisted.review.roundsLeft', { count: String(data.roundsLeft) })}</p>
                <button type="submit" disabled={Boolean(busy) || feedback.trim().length < 5} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-accent px-4 text-sm font-semibold text-accent disabled:opacity-60">
                  {busy === 'reject' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {t('jobBoard.assisted.review.sendFeedback')}
                </button>
              </form>
            )}
          </div>
        )}

        {errorText && (
          <div role="alert" className="rounded-xl border border-danger-border bg-danger-subtle p-3 text-sm text-danger">{errorText}</div>
        )}
      </section>
    </main>
  );
}
