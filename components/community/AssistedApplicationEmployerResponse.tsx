import { CheckCircle2, MessageSquare } from 'lucide-react';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { useTranslation } from '@/services/i18n';
import { parseEmployerResponse, type EmployerResponse } from '@/services/assistedApplicationEmployerResponse';

export function AssistedApplicationEmployerResponse({ response, compact = false }: { response?: EmployerResponse | null; compact?: boolean }) {
  const { t, locale } = useTranslation();
  const update = parseEmployerResponse(response);
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
      </div>
    </div>
  </div>;
}
