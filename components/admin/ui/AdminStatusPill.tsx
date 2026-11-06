import { CheckCircle2, CircleAlert, Clock3, Loader2, MessageCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export type AdminStatusTone = 'success' | 'danger' | 'accent' | 'warning' | 'neutral' | 'info';

const TONE_STYLES: Record<AdminStatusTone, string> = {
  success: 'bg-success-subtle text-success',
  danger: 'bg-danger-subtle text-danger',
  accent: 'bg-accent-subtle text-accent',
  warning: 'bg-warning-subtle text-warning',
  neutral: 'bg-surface-raised text-subtle',
  info: 'bg-info-subtle text-info',
};

const TONE_ICONS: Record<AdminStatusTone, ReactNode> = {
  success: <CheckCircle2 size={14} aria-hidden="true" />,
  danger: <CircleAlert size={14} aria-hidden="true" />,
  accent: <Loader2 size={14} className="animate-spin" aria-hidden="true" />,
  warning: <Clock3 size={14} aria-hidden="true" />,
  neutral: null,
  info: <MessageCircle size={14} aria-hidden="true" />,
};

export function AdminStatusPill({ tone, children }: { tone: AdminStatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_STYLES[tone]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {TONE_ICONS[tone]}
      <span>{children}</span>
    </span>
  );
}
