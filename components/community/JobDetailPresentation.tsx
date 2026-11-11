import type { HTMLAttributes, ReactNode } from 'react';
import { Users, ExternalLink } from 'lucide-react';
import { getLinkedInPeopleSearchUrl } from '../../services/referralPeople';

export const JOB_DETAIL_HEADER_CONTENT_CLASS = 'flex items-start gap-3 sm:gap-4';
export const JOB_DETAIL_HEADER_LOGO_FRAME_CLASS = 'w-14 h-14 sm:w-20 sm:h-20 rounded-xl bg-surface/90 flex items-center justify-center overflow-hidden border border-edge shrink-0 shadow-sm';
export const JOB_DETAIL_HEADER_LOGO_IMAGE_CLASS = 'w-10 h-10 sm:w-14 sm:h-14 object-contain';
export const JOB_DETAIL_HEADER_COPY_CLASS = 'min-w-0 flex-1';
export const JOB_DETAIL_HEADER_TITLE_CLASS = 'text-xl sm:text-2xl md:text-3xl font-extrabold font-display text-heading leading-tight break-words [hyphens:auto]';
export const JOB_DETAIL_HEADER_SUBTITLE_CLASS = 'mt-1 text-sm text-body break-words';

const HEADER_CARD_CLASS = 'rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6';
const META_TONE_CLASSES = {
 neutral: 'bg-surface-raised text-body',
 accent: 'bg-accent-subtle text-accent',
 success: 'bg-success-subtle text-success',
 warning: 'bg-warning-subtle text-warning border border-warning-border',
} as const;

interface JobDetailHeaderCardProps extends HTMLAttributes<HTMLElement> {
 'data-no-auto-ads'?: string;
}

export function JobDetailHeaderCard({
 children,
 className = '',
 ...props
}: JobDetailHeaderCardProps) {
 return (
  <header
   {...props}
   className={`${HEADER_CARD_CLASS}${className ? ` ${className}` : ''}`}
   data-job-detail-header=""
  >
   {children}
  </header>
 );
}

export function JobDetailMetadataRow({
 children,
 className = '',
 ...props
}: HTMLAttributes<HTMLDivElement>) {
 return (
  <div
   {...props}
   className={`mt-4 flex flex-wrap gap-2 text-xs${className ? ` ${className}` : ''}`}
   data-job-detail-metadata=""
  >
   {children}
  </div>
 );
}

interface JobDetailMetaPillProps extends HTMLAttributes<HTMLSpanElement> {
 tone?: keyof typeof META_TONE_CLASSES;
 icon?: ReactNode;
}

export function JobDetailMetaPill({
 children,
 className = '',
 icon,
 tone = 'neutral',
 ...props
}: JobDetailMetaPillProps) {
 return (
  <span
   {...props}
   className={`px-2 py-1 rounded-full ${META_TONE_CLASSES[tone]}${icon ? ' inline-flex items-center gap-1' : ''}${className ? ` ${className}` : ''}`}
  >
   {icon}
   {children}
  </span>
 );
}

export interface JobDetailLinkedInPeopleButtonProps extends HTMLAttributes<HTMLAnchorElement> {
  companyName: string;
  linkedInUrl?: string | null;
}

export function JobDetailLinkedInPeopleButton({
  companyName,
  linkedInUrl,
  className = '',
  ...props
}: JobDetailLinkedInPeopleButtonProps) {
  const peopleUrl = getLinkedInPeopleSearchUrl(companyName, linkedInUrl);
  if (!peopleUrl) return null;

  return (
    <a
      {...props}
      href={peopleUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 dark:text-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 rounded-lg transition-colors border border-slate-200 dark:border-slate-700 ${className}`}
      aria-label={`Trova persone che lavorano in ${companyName} su LinkedIn`}
    >
      <Users className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
      <span>Trova colleghi su LinkedIn</span>
      <ExternalLink className="w-3 h-3 text-slate-400 shrink-0" />
    </a>
  );
}
