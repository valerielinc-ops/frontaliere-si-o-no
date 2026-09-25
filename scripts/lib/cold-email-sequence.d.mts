/** Types for cold-email-sequence.mjs (pure ESM helper shared by scripts + SPA). */

export const PRICE: string;
export const OPTOUT_EMAIL: string;
export const OUTREACH_METRIC_LABELS: Readonly<{
  applyClicks: 'click per candidarsi';
  interestSignals: 'segnali di interesse';
}>;

export interface ColdEmailTouch {
  touch: number;
  gapDays: number;
  subject: string;
  body: string;
}

export interface PeriodWindow {
  from: string;
  to: string;
  inclusive?: '[from,to)' | '[from,to]' | '(from,to)' | '(from,to]';
  timezone?: string;
}

export type PeriodLabel = string | PeriodWindow;

export interface BuildSequenceArgs {
  company?: string;
  metricValue?: number | null;
  metricLabel?: 'click per candidarsi' | 'segnali di interesse';
  periodLabel: PeriodLabel;
  contactName?: string;
  topRole?: string;
}

export function buildSequence(args: BuildSequenceArgs): ColdEmailTouch[];
export function bodyToHtml(body: string): string;
export function calendarParts(value: string, options?: { requireTimeZone?: boolean; timeZone?: string }): { year: number; month: number; day: number } | null;
export function formatItalianPeriodLabel(periodLabel: PeriodLabel, options?: { strict?: boolean }): string;
