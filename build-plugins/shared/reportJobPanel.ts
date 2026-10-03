import fs from 'node:fs';
import path from 'node:path';
import { isReportedAnnualChfSalary, type SalaryCarrier } from './realSalaryMedian';

export interface ReportJob extends SalaryCarrier {
  id?: string;
  canton?: string;
  company?: string;
  location?: string;
  sector?: string;
  currency?: string;
  datePosted?: string;
  postedDate?: string;
  salaryPeriod?: string;
  baseSalary?: { value?: { unitText?: string } };
}

/** Calendar year in the source timezone, rejecting impossible calendar dates. */
export function isReportYearJob(job: ReportJob, year: number): boolean {
  const posted = job.datePosted ?? job.postedDate;
  if (job.canton !== 'TI' || typeof posted !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(posted)) return false;
  const timestamp = new Date(posted);
  const calendarPart = posted.slice(0, 10);
  const calendar = new Date(calendarPart);
  return Number.isFinite(timestamp.getTime()) && posted.slice(0, 4) === String(year)
    && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === calendarPart;
}

/** Report tables additionally require an explicit, unambiguous annual unit. */
export function isReportSalaryJob(job: ReportJob): boolean {
  const periods = [job.salaryPeriod, job.baseSalary?.value?.unitText].filter((value) => value != null);
  return periods.length > 0 && periods.every((period) => typeof period === 'string' && period.toUpperCase() === 'YEAR')
    && isReportedAnnualChfSalary(job);
}

/** Null means source unavailable; [] means a valid, empty observation set. */
export function loadReportJobPanel(rootDir: string, year: number): ReportJob[] | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(rootDir, 'data/jobs.json'), 'utf8'));
    if (!Array.isArray(raw)) return null;
    return raw.filter(isReportJob)
      .filter((job) => isReportYearJob(job, year));
  } catch {
    return null;
  }
}

/** Runtime JSON is untrusted even when the build's TypeScript callers are typed. */
function isReportJob(value: unknown): value is ReportJob {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const textFields = ['id', 'canton', 'company', 'location', 'sector', 'currency',
    'datePosted', 'postedDate', 'salarySource', 'salaryPeriod'];
  if (textFields.some((key) => row[key] != null && typeof row[key] !== 'string')) return false;
  if (['salaryMin', 'salaryMax'].some((key) => row[key] != null && typeof row[key] !== 'number')) return false;
  if (row.baseSalary != null) {
    if (typeof row.baseSalary !== 'object' || Array.isArray(row.baseSalary)) return false;
    const salary = row.baseSalary as Record<string, unknown>;
    if (salary.value != null) {
      if (typeof salary.value !== 'object' || Array.isArray(salary.value)) return false;
      const unit = (salary.value as Record<string, unknown>).unitText;
      if (unit != null && typeof unit !== 'string') return false;
    }
  }
  return true;
}
