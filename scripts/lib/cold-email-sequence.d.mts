/** Types for cold-email-sequence.mjs (pure ESM helper shared by scripts + SPA). */

export const PRICE: string;
export const OPTOUT_EMAIL: string;

export interface ColdEmailTouch {
  touch: number;
  gapDays: number;
  subject: string;
  body: string;
}

export interface BuildSequenceArgs {
  company?: string;
  metricValue?: number | null;
  metricLabel?: 'click per candidarsi' | 'segnali di interesse';
  periodLabel: string;
  contactName?: string;
  topRole?: string;
}

export function buildSequence(args: BuildSequenceArgs): ColdEmailTouch[];
export function bodyToHtml(body: string): string;
export function formatItalianPeriodLabel(periodLabel: string): string;
