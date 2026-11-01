import { CheckCircle2, MessageSquare } from 'lucide-react';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { useTranslation } from '@/services/i18n';
import { parseEmployerResponse, type EmployerResponse } from '@/services/assistedApplicationEmployerResponse';

export function AssistedApplicationEmployerResponse({ response, timeline = [], compact = false }: { response?: EmployerResponse | null; timeline?: EmployerResponse[]; compact?: boolean }) {
  const { t, locale } = useTranslation();
  const updates = (timeline.length ? timeline : [response])
    .map(parseEmployerResponse)
    .filter((value): value is EmployerResponse => Boolean(value));
  const update = updates.at(-1) || parseEmployerResponse(response);
  if (!update) return null;
  const received = new Date(update.receivedAt);
  const Icon = update.category === 'auto_acknowledgement' ? CheckCircle2 : MessageSquare;
  return <div {...REPLAY_PRIVATE_ATTRS} className={`${REPLAY_PRIVATE_CLASS} min-w-0 rounded-lg border border-edge bg-surface-raised ${compact ? 'mt-2 p-3' : 'p-4'}`}>
    <div className="flex min-w-0 items-start gap-3">
      <Icon size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-subtle">{t('jobBoard.assisted.employerResponse.heading')}</p>
        <p className="break-words text-sm font-semibold text-heading">{t(`jobBoard.assisted.employerResponse.${update.category}`)}</p>
        <time dateTime={received.toISOString()} className="block text-xs tabular-nums text-subtle">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(received)}</time>
        {update.needsReply && <p className="text-sm font-medium text-body">{t('jobBoard.assisted.employerResponse.needsReply')}</p>}
        {!compact && <p className="pt-2 text-sm leading-relaxed text-subtle">{t('jobBoard.assisted.employerResponse.emailHint')}</p>}
        {updates.length > 1 && <div className="mt-3 border-t border-edge pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{t('jobBoard.assisted.employerResponse.timeline')}</p>
          <ol className="mt-2 space-y-2 border-l border-edge pl-3">
            {updates.map((item, index) => <li key={`${item.category}-${item.receivedAt}-${index}`} className="text-xs text-subtle">
              <span className="font-semibold text-body">{t(`jobBoard.assisted.employerResponse.${item.category}`)}</span>
              <time dateTime={new Date(item.receivedAt).toISOString()} className="ml-2 tabular-nums">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.receivedAt))}</time>
            </li>)}
          </ol>
        </div>}
      </div>
    </div>
  </div>;
}
