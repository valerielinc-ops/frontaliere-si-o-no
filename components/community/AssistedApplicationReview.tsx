import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Copy, ExternalLink, FileText, Loader2, MessageSquare, Send, UserCheck } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
  fetchReview,
  ReviewRequestError,
  sendReviewAction,
  type FollowupPayload,
  type ReviewAction,
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

function QuestionField({ question, value, onChange, disabled }: {
  question: ReviewQuestion;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
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
          type={question.type === 'number' ? 'number' : question.type === 'date' ? 'date' : 'text'}
          min={question.type === 'date' ? question.minDate || undefined : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          maxLength={500}
          className={inputClass}
        />
      )}
    </label>
  );
}

export default function AssistedApplicationReview({ token }: { token: string }) {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [followup, setFollowup] = useState<FollowupPayload | null>(null);

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
      setAnswers(review.answers || {});
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

  const run = async (action: ReviewAction, extra = {}) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await sendReviewAction(token, action, extra);
      setDone(action);
      await load();
    } catch (reason) {
      setError(reason instanceof ReviewRequestError ? reason.code : 'network');
    } finally {
      setBusy(null);
    }
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
          <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-subtle/60 p-4" role="status">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-info" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-body">{t(`jobBoard.assisted.review.waiting.${data.state}`)}</p>
          </div>
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
            onSubmit={(event) => { event.preventDefault(); void run('answers', { answers }); }}
          >
            <h2 className="text-base font-bold text-heading">{t('jobBoard.assisted.review.questionsTitle')}</h2>
            {data.questions.map((question) => (
              <QuestionField
                key={question.id}
                question={question}
                value={answers[question.id] || ''}
                onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
                disabled={Boolean(busy)}
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
              {data.coverLetterUrl && (
                <a href={data.coverLetterUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold text-link hover:underline">
                  <FileText className="h-4 w-4" aria-hidden="true" /> {t('jobBoard.assisted.review.letterPdf')}
                </a>
              )}
            </div>
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
              disabled={Boolean(busy) || !data.can.approve}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
              {t('jobBoard.assisted.review.approve')}
            </button>
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
