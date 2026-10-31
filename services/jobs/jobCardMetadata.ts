import type { Locale } from '@/services/i18n';
import { salaryProvenanceSuffix } from '@/build-plugins/shared/salaryEstimateSuffix';

export interface JobSalaryMetadata {
 salaryMin?: number;
 salaryMax?: number;
 salarySource?: string;
 currency?: string;
 salaryCurrency?: string;
}

const CONTRACT_COPY: Record<string, Record<Locale, string>> = {
 'full-time': { it: 'Tempo pieno', en: 'Full-time', de: 'Vollzeit', fr: 'Temps plein' },
 'part-time': { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' },
 temporary: { it: 'Temporaneo', en: 'Temporary', de: 'Temporär', fr: 'Temporaire' },
 contract: { it: 'Contratto/Progetto', en: 'Contract/Project', de: 'Vertrag/Projekt', fr: 'Contrat/Projet' },
 internship: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' },
 apprenticeship: { it: 'Apprendistato', en: 'Apprenticeship', de: 'Lehrstelle', fr: 'Apprentissage' },
};

export function formatJobSalary(job: JobSalaryMetadata, locale: Locale): string | null {
 const salaryMin = Number(job.salaryMin);
 if (!Number.isFinite(salaryMin) || salaryMin <= 0) return null;
 const salaryMax = Number(job.salaryMax);
 const min = (salaryMin / 1000).toFixed(0);
 const max = Number.isFinite(salaryMax) && salaryMax > 0 ? (salaryMax / 1000).toFixed(0) : null;
 const currency = job.currency ?? job.salaryCurrency ?? 'CHF';
 const range = max ? `${currency} ${min}k – ${max}k` : `${currency} ${min}k+`;
 const suffix = salaryProvenanceSuffix(job.salarySource, locale);
 return suffix ? `${range} ${suffix}` : range;
}

export function formatJobContractLabel(contract: string | undefined, locale: Locale): string | null {
 if (!contract) return null;
 return CONTRACT_COPY[contract]?.[locale] ?? CONTRACT_COPY[contract]?.it ?? contract;
}

export function formatDaysAgo(dateStr: string | undefined, locale: Locale): string | null {
 if (!dateStr) return null;
 const timestamp = new Date(dateStr).getTime();
 if (!Number.isFinite(timestamp)) return null;
 const diff = Math.floor((Date.now() - timestamp) / 86400000);
 if (diff < 0) return null;
 if (diff === 0) return locale === 'it' ? 'Oggi' : locale === 'de' ? 'Heute' : locale === 'fr' ? "Aujourd'hui" : 'Today';
 if (diff === 1) return locale === 'it' ? 'Ieri' : locale === 'de' ? 'Gestern' : locale === 'fr' ? 'Hier' : 'Yesterday';
 return locale === 'it' ? `${diff} giorni fa` : locale === 'de' ? `Vor ${diff} Tagen` : locale === 'fr' ? `Il y a ${diff} jours` : `${diff} days ago`;
}
