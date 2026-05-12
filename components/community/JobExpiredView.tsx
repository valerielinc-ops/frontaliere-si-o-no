/**
 * JobExpiredView — view for jobs found in /data/expired-jobs.json.
 *
 * Renders with the same layout as active job auth-gate pages:
 * 3-column ad grid, blurred description teaser, full auth gate with
 * social proof, and an orange expired banner at the top.
 *
 * When logged in, renders a 2-column layout (content + sidebar) with
 * full description and 5 ad slots, matching the active job detail view.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Briefcase, Building2, Calendar, CheckCircle2, ChevronDown, Clock, Euro, Eye, Loader2, Mail, MapPin, Search, Shield, Users } from 'lucide-react';
import { useLocale, t } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { handleCompanyLogoError } from '@/services/logoService';
import { AD_SLOTS } from '@/services/adsenseSlots';
import { getJobLocationSnapshot } from '@/services/jobLocationSnapshot';
import { buildPath } from '@/services/router';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseBanner from '@/components/shared/AdSenseBanner';
import Callout from '@/components/shared/Callout';
import JobAlertSection from '@/components/community/JobAlertSection';
import type { ExpiredJob } from '@/hooks/useExpiredJob';

interface RelatedJob {
 slug: string;
 title?: string;
 titleByLocale?: Record<string, string>;
 company?: string;
 companyKey?: string;
 companyDomain?: string;
 url?: string;
 location?: string;
 canton?: string;
 contract?: string;
 postedDate?: string;
 crawledAt?: string;
 salaryMin?: number;
 salaryMax?: number;
 currency?: string;
 featured?: boolean;
}

interface JobExpiredViewProps {
 job: ExpiredJob;
 relatedJobs?: RelatedJob[];
 onBack?: () => void;
 /** When true the user is already authenticated — hide the sign-in block. */
 hasAccess?: boolean;
 /** Total active jobs count for social proof in auth gate. */
 totalActiveJobs?: number;
 /** SPA navigation: navigate to company filter page. */
 onNavigateToCompany?: (companySlug: string) => void;
 /** SPA navigation: navigate to location filter page. */
 onNavigateToLocation?: (locationSlug: string) => void;
 /** SPA navigation: navigate to a job detail or listing (empty string = listing root). */
 onNavigateToJob?: (jobSlug: string) => void;
 /** SPA navigation: open the "publish a job" flow. If omitted, the publish callout is hidden. */
 onPostJob?: () => void;
 /** SPA navigation: jump to a job-board search term (populates listing search). */
 onNavigateToSearch?: (term: string) => void;
}

const SECTION_BY_LOCALE: Record<string, string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
};
const PREFIX_BY_LOCALE: Record<string, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

const COMPANY_ROUTE_PREFIX: Record<string, string> = { it: 'azienda', en: 'company', de: 'unternehmen', fr: 'entreprise' };
const LOCATION_ROUTE_PREFIX: Record<string, string> = { it: 'localita', en: 'location', de: 'standort', fr: 'localite' };
function slugifyCompanyName(name: string): string {
 return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function slugifyLocationName(name: string): string {
 return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const CONTRACT_COPY: Record<string, Record<string, string>> = {
 'full-time': { it: 'Tempo pieno', en: 'Full-time', de: 'Vollzeit', fr: 'Temps plein' },
 'part-time': { it: 'Part-time', en: 'Part-time', de: 'Teilzeit', fr: 'Temps partiel' },
 temporary: { it: 'Temporaneo', en: 'Temporary', de: 'Temporär', fr: 'Temporaire' },
 internship: { it: 'Stage', en: 'Internship', de: 'Praktikum', fr: 'Stage' },
 apprenticeship: { it: 'Apprendistato', en: 'Apprenticeship', de: 'Lehrstelle', fr: 'Apprentissage' },
};
function formatContractLabel(contract: string | undefined, locale: string): string | null {
 if (!contract) return null;
 return CONTRACT_COPY[contract]?.[locale] ?? CONTRACT_COPY[contract]?.it ?? contract;
}
function formatDaysAgo(dateStr: string | undefined, locale: string): string | null {
 if (!dateStr) return null;
 const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
 if (diff < 0) return null;
 if (diff === 0) return locale === 'it' ? 'Oggi' : locale === 'de' ? 'Heute' : locale === 'fr' ? "Aujourd'hui" : 'Today';
 if (diff === 1) return locale === 'it' ? 'Ieri' : locale === 'de' ? 'Gestern' : locale === 'fr' ? 'Hier' : 'Yesterday';
 return locale === 'it' ? `${diff} giorni fa` : locale === 'de' ? `Vor ${diff} Tagen` : locale === 'fr' ? `Il y a ${diff} jours` : `${diff} days ago`;
}
function formatRelatedSalary(rj: RelatedJob): string | null {
 if (!rj.salaryMin) return null;
 const min = (rj.salaryMin / 1000).toFixed(0);
 const max = rj.salaryMax ? (rj.salaryMax / 1000).toFixed(0) : null;
 return max ? `${rj.currency ?? 'CHF'} ${min}k – ${max}k` : `${rj.currency ?? 'CHF'} ${min}k+`;
}

const BANNER_COPY: Record<string, string> = {
 it: 'Questa posizione non è più attiva.',
 en: 'This position is no longer active.',
 de: 'Diese Stelle ist nicht mehr aktiv.',
 fr: 'Ce poste n\'est plus actif.',
};
const RELATED_COPY: Record<string, string> = {
 it: 'Offerte simili attive',
 en: 'Similar active jobs',
 de: 'Ähnliche offene Stellen',
 fr: 'Postes similaires ouverts',
};
const CTA_COPY: Record<string, string> = {
 it: 'Tutte le offerte di lavoro in Ticino',
 en: 'All job openings in Ticino',
 de: 'Alle offenen Stellen im Tessin',
 fr: 'Toutes les offres d\'emploi au Tessin',
};
const EXPIRED_AT_COPY: Record<string, string> = {
 it: 'Scaduta il',
 en: 'Expired on',
 de: 'Abgelaufen am',
 fr: 'Expirée le',
};

const SEARCH_PREFIX_BY_LOCALE: Record<string, string> = {
 it: 'ricerca',
 en: 'search',
 de: 'suche',
 fr: 'recherche',
};
function slugifySearchTerm(term: string): string {
 return term.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function buildLocalSearchSlug(term: string, locale: string): string {
 const prefix = SEARCH_PREFIX_BY_LOCALE[locale] ?? SEARCH_PREFIX_BY_LOCALE.it;
 const core = slugifySearchTerm(term) || 'lavoro';
 return `${prefix}-${core}`;
}

const JOB_EMAIL_ACCESS_KEY = 'ft_job_email';

export default function JobExpiredView({ job, relatedJobs = [], onBack, hasAccess: hasAccessProp, totalActiveJobs, onNavigateToCompany, onNavigateToLocation, onNavigateToJob, onPostJob, onNavigateToSearch }: JobExpiredViewProps) {
 const [locale] = useLocale();
 const isDesktopXl = useMediaQuery('(min-width: 1280px)');
 const isDesktopLg = useMediaQuery('(min-width: 1024px)');
 const googleButtonRef = useRef<HTMLDivElement>(null);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [emailInput, setEmailInput] = useState('');
 const [emailBusy, setEmailBusy] = useState(false);
 const [emailError, setEmailError] = useState<string | null>(null);
 const [linkedInBusy, setLinkedInBusy] = useState(false);

 // Hide login block if user is already authenticated (prop) or has email access (localStorage)
 const alreadySignedIn = hasAccessProp || !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY);

 const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
 const prefix = PREFIX_BY_LOCALE[locale] ?? '';
 const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');

 const localizedTitle = job.titleByLocale?.[locale] ?? job.title;
 const description = job.descriptionByLocale?.[locale] ?? '';
 const descriptionPlain = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
 const descriptionPreview = descriptionPlain.slice(0, 220);

 const expiredDate = job.expiredAt
 ? new Date(job.expiredAt).toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
 : null;

 const logoUrl = resolveCompanyLogoUrl({ company: job.company, companyKey: job.companyKey });
 const jobLocation = job.addressLocality ?? job.location ?? '';

 const companySlug = job.company ? `${COMPANY_ROUTE_PREFIX[locale] || 'azienda'}-${slugifyCompanyName(job.company)}` : '';
 const companyHref = companySlug ? `${prefix}/${sectionSlug}/${companySlug}/`.replace(/\/+/g, '/') : '';
 const locationSlug = jobLocation ? `${LOCATION_ROUTE_PREFIX[locale] || 'localita'}-${slugifyLocationName(jobLocation)}` : '';
 const locationHref = locationSlug ? `${prefix}/${sectionSlug}/${locationSlug}/`.replace(/\/+/g, '/') : '';

 // ── Analytics ──

 useEffect(() => {
 Analytics.trackSelectContent('job_expired_view', job.slug);
 }, [job.slug]);

 useEffect(() => {
 if (alreadySignedIn) return;
 Analytics.trackJobAuthFunnel('gate_view', {
 company: job.company,
 jobTitle: localizedTitle,
 location: jobLocation,
 });
 }, [job.slug, alreadySignedIn]);

 // ── Auth setup ──

 useEffect(() => {
 if (alreadySignedIn) return;
 const container = googleButtonRef.current;
 if (!container) return;
 let cancelled = false;

 sessionStorage.setItem('auth_redirect_path', window.location.pathname);

 container.innerHTML = '';
 renderGoogleButton(container, { theme: 'outline', size: 'large', text: 'signin_with' })
 .then(() => {
 if (!cancelled) setGoogleButtonReady(container.children.length > 0);
 })
 .catch((err) => {
 if (!cancelled) reportCaughtError(err, 'jobExpiredView.renderGoogleButton');
 });
 return () => { cancelled = true; };
 }, [alreadySignedIn, listingPath]);

 useEffect(() => {
 if (alreadySignedIn) return;
 isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, [alreadySignedIn]);

 const handleEmailSubmit = async (e: { preventDefault(): void }) => {
 e.preventDefault();
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) return;
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'email', company: job.company, jobTitle: localizedTitle });
 setEmailBusy(true);
 setEmailError(null);
 try {
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const firestore = getFirestore(await getApp());
 await upsertNewsletterSubscriber(firestore, {
 email,
 source: 'job_expired',
 sourceChannel: 'job_gate',
 sourcePage: window.location.pathname,
 sourceCta: 'job_expired_email_unlock',
 sourceComponent: 'JobExpiredView',
 sourceRouteFamily: 'job-board',
 isActive: false,
 status: 'pending',
 });
 localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 window.location.reload();
 } catch {
 setEmailError(locale === 'it' ? 'Errore, riprova.' : 'Error, please retry.');
 } finally {
 setEmailBusy(false);
 }
 };

 // ── SPA navigation helpers ──

 const handleCompanyClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToCompany || !companySlug) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_board_company_filter_open', job.company);
 onNavigateToCompany(companySlug);
 };

 const handleLocationClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToLocation || !locationSlug) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_board_location_filter_open', jobLocation);
 onNavigateToLocation(locationSlug);
 };

 const handleRelatedJobClick = (e: { preventDefault(): void }, rjSlug: string) => {
 if (!onNavigateToJob) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_expired_related_click', rjSlug);
 onNavigateToJob(rjSlug);
 };

 const handleCtaClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToJob) return;
 e.preventDefault();
 onNavigateToJob('');
 };

 // ── Shared elements ──

 const backButton = onBack && (
 <button
 onClick={onBack}
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>
 );

 const expiredBanner = (
 <div className="rounded-xl bg-warning-subtle border border-warning-border px-4 py-3 text-xs text-warning">
 {BANNER_COPY[locale] ?? BANNER_COPY.it}
 </div>
 );

 const jobHeader = (
 <div className="flex items-start gap-4">
 {logoUrl && (
 <img
 src={logoUrl}
 alt={job.company}
 width={48}
 height={48}
 className="w-12 h-12 rounded-lg object-contain bg-surface-alt flex-shrink-0"
 loading="lazy"
 onError={handleCompanyLogoError}
 />
 )}
 <div className="flex-1 min-w-0">
 <h1 className="text-xl font-bold font-display text-heading leading-tight">{localizedTitle}</h1>
 <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5 text-sm leading-tight text-subtle">
 {job.company && companyHref && (
 <a
 href={companyHref}
 onClick={handleCompanyClick}
 className="inline-flex items-center gap-1 hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 <Building2 size={14} />
 {job.company}
 </a>
 )}
 {jobLocation && locationHref && (
 <a
 href={locationHref}
 onClick={handleLocationClick}
 className="inline-flex items-center gap-1 hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 <MapPin size={14} />
 {jobLocation}
 </a>
 )}
 {expiredDate && (
 <span className="inline-flex items-center gap-1">
 <Calendar size={14} />
 {EXPIRED_AT_COPY[locale] ?? EXPIRED_AT_COPY.it} {expiredDate}
 </span>
 )}
 </div>
 </div>
 </div>
 );

 const companyBanner = job.company && companyHref && (
 <a
 href={companyHref}
 onClick={handleCompanyClick}
 className="block rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 rounded-lg bg-surface border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {logoUrl ? (
 <img src={logoUrl} alt={`Logo ${job.company}`} className="w-7 h-7 object-contain" width={28} height={28} loading="lazy" onError={handleCompanyLogoError} />
 ) : (
 <Building2 className="w-4 h-4 text-muted" />
 )}
 </div>
 <div className="min-w-0">
 <h3 className="text-sm font-bold text-heading">{t('jobBoard.companyHeading')}</h3>
 <p className="text-sm text-subtle mt-1">{job.company} · {jobLocation}</p>
 <p className="text-sm text-muted mt-2">
 {locale === 'it' ? 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.' : locale === 'de' ? 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.' : locale === 'fr' ? 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' : 'Frontaliere Ticino discovered this opportunity through company monitoring.'}
 </p>
 </div>
 </div>
 </a>
 );

 const relatedJobsSection = relatedJobs.length > 0 && (
 <div className="space-y-2">
 <h2 className="text-base font-semibold font-display text-strong">{RELATED_COPY[locale] ?? RELATED_COPY.it}</h2>
 <div className="space-y-2">
 {relatedJobs.slice(0, 6).map((rj) => {
 const rjSlug = rj.slug;
 const rjTitle = rj.titleByLocale?.[locale] ?? rj.title ?? rjSlug;
 const rjPath = `${prefix}/${sectionSlug}/${rjSlug}/`.replace(/\/+/g, '/');
 const rjLogo = resolveCompanyLogoUrl({ company: rj.company, companyKey: rj.companyKey, companyDomain: rj.companyDomain, url: rj.url });
 const rjSalary = formatRelatedSalary(rj);
 const rjContract = formatContractLabel(rj.contract, locale);
 const rjPosted = formatDaysAgo(rj.postedDate ?? rj.crawledAt, locale);
 return (
 <article
 key={rjSlug}
 className={`rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 rj.featured ? 'border-warning-border bg-warning-subtle hover:border-warning' : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
 <a href={rjPath} onClick={(e) => handleRelatedJobClick(e, rjSlug)} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg">
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0">
 {rjLogo ? (
 <img src={rjLogo} alt={`Logo ${rj.company}`} className="w-7 h-7 sm:w-10 sm:h-10 object-contain" width={40} height={40} loading="lazy" onError={handleCompanyLogoError} />
 ) : (
 <Building2 className="w-5 h-5 text-muted" />
 )}
 </div>
 <div className="min-w-0 flex-1">
 <h3 className="text-sm sm:text-base font-bold text-heading leading-tight">{rjTitle}</h3>
 <p className="text-xs sm:text-sm text-subtle mt-0.5 line-clamp-2">
 {rj.company}{rj.location ? ` · ${rj.location}${rj.canton ? ` (${rj.canton})` : ''}` : ''}
 </p>
 {rjSalary && (
 <span className="mt-1 inline-flex items-center gap-1 text-xs sm:text-sm font-semibold text-success">
 <Euro className="w-3.5 h-3.5" />{rjSalary}
 </span>
 )}
 </div>
 </div>
 <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-2 sm:gap-1.5 text-xs text-muted">
 {rj.location && (
 <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{rj.location}</span>
 )}
 {rjContract && (
 <span className="px-1.5 py-0.5 rounded bg-surface-raised text-subtle">{rjContract}</span>
 )}
 {rjPosted && (
 <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{rjPosted}</span>
 )}
 </div>
 </a>
 </article>
 );
 })}
 </div>
 </div>
 );

 const ctaLink = (
 <a
 href={listingPath}
 onClick={handleCtaClick}
 className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline text-sm"
 >
 <ArrowRight size={14} />
 {CTA_COPY[locale] ?? CTA_COPY.it}
 </a>
 );

 // ── Logged-in view: 2-column layout matching active job detail ──

 if (alreadySignedIn) {
 const locationSnapshot = getJobLocationSnapshot({
 location: job.location,
 addressLocality: job.addressLocality,
 });
 const relatedSearchTerms: string[] = Array.from(
 new Set(
 [job.sector, jobLocation, 'frontaliere']
 .map((v) => (v || '').trim())
 .filter((v): v is string => v.length > 0)
 )
 ).slice(0, 3);

 const handleSearchTermClick = (e: { preventDefault(): void }, term: string) => {
 if (!onNavigateToSearch) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_expired_related_search_click', term);
 onNavigateToSearch(term);
 };

 return (
 <div className="space-y-5">
 {backButton}
 {expiredBanner}

 <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
 {/* ── Main content (8 cols) ── */}
 <article className="lg:col-span-8 space-y-5">
 <div className="rounded-stripe border border-edge bg-surface p-5">
 {jobHeader}
 {job.sector && (
 <div className="mt-4 flex flex-wrap gap-2 text-xs">
 <span className="px-2 py-1 rounded-full bg-surface-raised text-body">{job.sector}</span>
 </div>
 )}
 </div>

 {descriptionPlain && (
 <div className="prose prose-sm dark:prose-invert max-w-none text-body" dangerouslySetInnerHTML={{ __html: description }} />
 )}

 {/* Mobile/tablet in-article ad */}
 {!isDesktopLg && AD_SLOTS.ARTICLE_INLINE_MOBILE.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}
 adFormat={AD_SLOTS.ARTICLE_INLINE_MOBILE.format}
 />
 )}

 {companyBanner}

 {/* Between-sections ad */}
 {AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS?.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS.slot}
 adFormat={AD_SLOTS.JOBDETAIL_BETWEEN_SECTIONS.format}
 />
 )}

 {relatedJobsSection}
 <JobAlertSection initialKeyword={job.title || ''} />
 {ctaLink}
 </article>

 {/* ── Sidebar (4 cols, desktop only) ── */}
 <aside className="hidden lg:block lg:col-span-4">
 <div className="sticky top-20 space-y-4">
 {/* Snapshot annuncio */}
 {(jobLocation || expiredDate || (locationSnapshot?.crossings && locationSnapshot.crossings.length > 0)) && (
 <Callout status="accent" icon={<Briefcase size={15} />} className="rounded-xl">
 <div className="text-sm font-bold font-display text-heading">
 {t('jobBoard.snapshotTitle')}
 </div>
 <div className="mt-3 space-y-2 text-xs text-subtle">
 {jobLocation && (
 <div className="flex items-center justify-between gap-2">
 <span>{t('jobBoard.snapshot.location')}</span>
 <div className="text-right">
 <div className="font-semibold font-display text-strong">
 {locationSnapshot?.locality || jobLocation}
 </div>
 {locationSnapshot?.postalCode && (
 <div className="text-[11px] text-muted leading-tight mt-0.5">
 {t('jobBoard.snapshot.postalCode')}: {locationSnapshot.postalCode}
 </div>
 )}
 </div>
 </div>
 )}
 {expiredDate && (
 <div className="flex items-center justify-between gap-2">
 <span>{EXPIRED_AT_COPY[locale] ?? EXPIRED_AT_COPY.it}</span>
 <span className="font-semibold font-display text-strong">{expiredDate}</span>
 </div>
 )}
 {locationSnapshot?.crossings && locationSnapshot.crossings.length > 0 && (
 <div className="pt-2 border-t border-edge/60">
 <div className="mb-1.5 text-xs font-semibold font-display uppercase tracking-wide text-muted">
 {t('jobBoard.snapshot.borderCrossings')}
 </div>
 <div className="space-y-1">
 {locationSnapshot.crossings.map((crossing) => (
 <a
 key={crossing.id}
 href={buildPath({ activeTab: 'guida', guidaSubTab: 'border', borderCrossing: crossing.id }, locale)}
 className="flex items-center justify-between gap-2 rounded-lg px-2 py-2.5 min-h-[44px] lg:min-h-0 lg:py-1.5 bg-surface-alt hover:bg-surface-raised/50 text-body transition-colors"
 >
 <span className="font-medium font-display leading-tight">{crossing.name}</span>
 <ArrowUpRight className="w-3 h-3 text-muted" />
 </a>
 ))}
 </div>
 </div>
 )}
 </div>
 </Callout>
 )}

 {/* Advice (expired variant) */}
 <Callout status="success" icon={<Users size={15} />} className="rounded-xl">
 <div className="text-sm font-bold font-display text-heading">
 {t('jobBoard.adviceTitle')}
 </div>
 <p className="mt-2 text-sm leading-relaxed text-subtle">
 {t('jobBoard.adviceDescription')}
 </p>
 <button
 type="button"
 onClick={handleCtaClick}
 className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display bg-success-strong hover:bg-success-strong-hover text-on-accent rounded-lg"
 >
 {t('jobBoard.expiredAdviceCta')}
 </button>
 </Callout>

 {/* Related searches — only when we can actually navigate */}
 {onNavigateToSearch && relatedSearchTerms.length > 0 && (
 <Callout status="accent" icon={<Search size={15} />} className="rounded-xl">
 <div className="text-sm font-bold font-display text-heading">
 {RELATED_COPY[locale] ?? RELATED_COPY.it}
 </div>
 <div className="mt-2 flex flex-wrap gap-2">
 {relatedSearchTerms.map((term, i) => {
 const href = buildPath(
 { activeTab: 'job-board', jobSlug: buildLocalSearchSlug(term, locale) },
 locale,
 );
 return (
 <a
 key={i}
 href={href}
 onClick={(e) => handleSearchTermClick(e, term)}
 className="text-xs px-2.5 py-1.5 min-h-[44px] inline-flex items-center rounded-full bg-accent-subtle text-accent border border-accent-border"
 >
 {term}
 </a>
 );
 })}
 </div>
 </Callout>
 )}

 {/* Sidebar ad */}
 {AD_SLOTS.JOBDETAIL_SIDEBAR.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_SIDEBAR.slot}
 adFormat={AD_SLOTS.JOBDETAIL_SIDEBAR.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_SIDEBAR.fullWidthResponsive}
 />
 )}

 {/* Publish job CTA — only when handler is wired */}
 {onPostJob && (
 <Callout status="accent" icon={<Mail size={15} />} className="rounded-xl">
 <div className="text-sm font-bold font-display text-heading">
 {t('jobBoard.publishTitle')}
 </div>
 <p className="mt-2 text-sm leading-relaxed text-subtle">
 {t('jobBoard.publishDescription', { canton: 'Ticino' })}
 </p>
 <button
 type="button"
 onClick={onPostJob}
 className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 min-h-[44px] text-sm font-semibold font-display border border-accent-border text-accent rounded-lg hover:bg-accent-subtle"
 >
 {t('jobBoard.publishCta')}
 </button>
 </Callout>
 )}
 </div>
 </aside>
 </div>

 {/* End multiplex */}
 {AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.format}
 className="mt-2"
 />
 )}
 </div>
 );
 }

 // ── Auth gate view: matches active job layout ──

 return (
 <div className="space-y-5" data-no-auto-ads="inside">
 {backButton}
 {expiredBanner}

 {/* 3-column grid: left rail | content | right rail (desktop xl only) */}
 <div className="xl:grid xl:grid-cols-[180px_1fr_180px] xl:gap-6">

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className="hidden xl:block" />

 {/* ── Center content ── */}
 <div className="space-y-4">

 {/* Job header card */}
 <div className="rounded-stripe border border-edge bg-surface p-4 sm:p-5">
 {jobHeader}

 {/* Readable description teaser — shows first ~200 chars to create information
 scent and an "open loop" that motivates signup. Fades out at the bottom.
 Hidden on landscape phones (≤540dvh) so the gate CTAs land above the fold. */}
 {descriptionPreview && (
 <div className="relative mt-3 w-full overflow-hidden rounded-stripe [@media(max-height:540px)]:hidden" style={{ maxHeight: 'clamp(0px, calc(100dvh - 540px), 80px)' }}>
 <p className="px-3 py-2 text-sm text-body leading-relaxed sm:py-3">
 {descriptionPreview}...
 </p>
 <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />
 </div>
 )}

 {/* Auth gate — expired-context headline (job not applicable → promise is "similar listings") */}
 <div id="job-auth-gate" role="region" aria-label={t('jobBoard.gate.title')} className="relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-4 sm:p-6">
 <h2 className="flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-heading leading-tight">
 <Eye className="w-5 h-5 mt-0.5 text-accent flex-shrink-0" aria-hidden="true" />
 <span>{locale === 'it' ? 'Sblocca annunci simili' : locale === 'de' ? 'Ähnliche Stellen freischalten' : locale === 'fr' ? 'Débloquer les offres similaires' : 'Unlock similar listings'}</span>
 </h2>

 {/* Trust signals — 2 lines at text-sm (matches active job gate) */}
 <ul className="mt-3 space-y-1.5 text-sm text-subtle">
 <li className="flex items-center gap-2">
 <CheckCircle2 size={14} className="text-success flex-shrink-0" aria-hidden="true" />
 <span>{locale === 'it' ? 'Gratis · Per sempre' : locale === 'de' ? 'Kostenlos · Für immer' : locale === 'fr' ? 'Gratuit · Pour toujours' : 'Free · Forever'}</span>
 </li>
 <li className="flex items-center gap-2">
 <Shield size={14} className="text-success flex-shrink-0" aria-hidden="true" />
 <span>{t('jobBoard.gate.privacyNote')}</span>
 </li>
 </ul>

 {/* Social proof */}
 {totalActiveJobs != null && totalActiveJobs > 0 && (
 <p className="mt-3 text-xs font-medium text-accent">
 {totalActiveJobs.toLocaleString()}+ {locale === 'it' ? 'annunci disponibili' : locale === 'de' ? 'verfügbare Stellenangebote' : locale === 'fr' ? 'offres disponibles' : 'listings available'}
 </p>
 )}

 <div className="mt-4 space-y-3">
 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
 {!googleButtonReady && (
 <button
 type="button"
 onClick={() => {
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'google', company: job.company, jobTitle: localizedTitle });
 }}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-surface border border-edge hover:bg-surface-raised text-strong text-sm font-semibold shadow-sm transition-colors"
 >
 {t('newsletter.popup.googleSignIn')}
 </button>
 )}
 </div>
 {linkedInAvailable && (
 <button
 type="button"
 disabled={linkedInBusy}
 onClick={() => {
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'linkedin', company: job.company, jobTitle: localizedTitle });
 setLinkedInBusy(true);
 saveAuthJobContext({ slug: job.slug, company: job.company, location: job.location || job.addressLocality, category: job.sector });
 signInWithLinkedIn().catch(() => setLinkedInBusy(false));
 }}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-brand-linkedin hover:bg-brand-linkedin-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {linkedInBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 )}
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}
 {/* Email — wrapped in <details open>: default expanded so the
 email channel stays visible, but user can collapse it. */}
 <details open className="group">
 <summary className="flex items-center gap-3 cursor-pointer list-none py-1 -my-1 [&::-webkit-details-marker]:hidden">
 <div className="flex-1 h-px bg-surface-raised/50" />
 <span className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-subtle transition-colors">
 {t('jobBoard.authGateOrEmail')}
 <ChevronDown size={14} className="transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
 </span>
 <div className="flex-1 h-px bg-surface-raised/50" />
 </summary>
 <form onSubmit={handleEmailSubmit} className="mt-3 space-y-2">
 <EmailInput
 value={emailInput}
 onChange={setEmailInput}
 placeholder={t('jobBoard.authGateEmailPlaceholder')}
 className="w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
 />
 <button
 type="submit"
 disabled={emailBusy || !emailInput.trim()}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
 {t('jobBoard.gate.emailCta')}
 </button>
 </form>
 </details>
 </div>

 {emailError && <p className="text-sm text-danger mt-2">{emailError}</p>}
 </div>
 </div>

 {/* AdSense — below auth gate */}
 {AD_SLOTS.JOBDETAIL_AUTH_GATE.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_AUTH_GATE.slot}
 adFormat={AD_SLOTS.JOBDETAIL_AUTH_GATE.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_AUTH_GATE.fullWidthResponsive}
 />
 )}
 </div>

 {/* ── Right Rail (desktop xl only) ── */}
 <aside className="hidden xl:block" />

 </div>

 {/* AdSense — end multiplex below 3-column layout */}
 {AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.AUTHGATE_END_MULTIPLEX.format}
 className="mt-2"
 />
 )}

 {/* Company banner */}
 {companyBanner}

 {/* Related active jobs */}
 {relatedJobsSection}

 {/* Job alert opt-in */}
 <JobAlertSection initialKeyword={job.title || ''} />

 {/* CTA */}
 {ctaLink}
 </div>
 );
}
