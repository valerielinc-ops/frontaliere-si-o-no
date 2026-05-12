/**
 * JobOrphanView — view for slugs with no metadata in expired-jobs.json.
 *
 * Shown for GSC orphan slugs, legacy URLs, or true 404s that have a static
 * HTML page (from orphan soft-landing generation) but no job data available.
 *
 * Unauthenticated: 3-column ad grid (left rail | content | right rail) with
 * auth gate, Eye icon header, social proof, and AUTHGATE_* ad slots.
 *
 * Authenticated: single-column with JOBDETAIL_END_MULTIPLEX + inline mobile ad.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Briefcase, Building2, CheckCircle2, ChevronDown, Eye, Loader2, Mail, MapPin, Search, Shield } from 'lucide-react';
import { useLocale, t } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { CRAWLED_COMPANY_LOGOS, resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { handleCompanyLogoError } from '@/services/logoService';
import { AD_SLOTS } from '@/services/adsenseSlots';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseBanner from '@/components/shared/AdSenseBanner';
import JobAlertSection from '@/components/community/JobAlertSection';

interface JobOrphanViewProps {
 slug: string;
 onBack?: () => void;
 /** When true the user is already authenticated — hide the sign-in block. */
 hasAccess?: boolean;
 totalActiveJobs?: number;
 onNavigateToCompany?: (companySlug: string) => void;
 onNavigateToLocation?: (locationSlug: string) => void;
 onNavigateToJob?: (jobSlug: string) => void;
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

const BANNER_COPY: Record<string, string> = {
 it: 'Questo annuncio non è più disponibile o non è stato trovato.',
 en: 'This job listing is no longer available or was not found.',
 de: 'Diese Stellenanzeige ist nicht mehr verfügbar oder wurde nicht gefunden.',
 fr: 'Cette offre n\'est plus disponible ou n\'a pas été trouvée.',
};
const SIGNUP_COPY: Record<string, string> = {
 it: 'Ricevi offerte simili via email',
 en: 'Receive similar job alerts by email',
 de: 'Ähnliche Stellenangebote per E-Mail erhalten',
 fr: 'Recevez des alertes d\'emplois similaires',
};
const CTA_COPY: Record<string, string> = {
 it: 'Cerca tra tutte le offerte attive',
 en: 'Browse all active job openings',
 de: 'Alle aktiven Stellen durchsuchen',
 fr: 'Parcourir toutes les offres actives',
};

const JOB_EMAIL_ACCESS_KEY = 'ft_job_email';

/** Well-known company suffixes found in job slugs. */
const KNOWN_COMPANIES = [
 'eoc-ente-ospedaliero-cantonale', 'ubs', 'credit-suisse', 'abb', 'pwc',
 'swisscom', 'migros', 'coop', 'post', 'sbb', 'cornr-banca', 'corner-banca',
 'banca-stato', 'rsi', 'supsi', 'usi', 'franklin-university', 'lidl', 'aldi',
 'manor', 'denner', 'swatch', 'novartis', 'roche', 'lonza', 'stadler-rail',
 'mikron', 'helvetia', 'zurich-insurance', 'swiss-re', 'ems-chemie',
];

/** Known Swiss localities that appear at the end of job slugs. */
const KNOWN_LOCATIONS = [
 'lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'manno',
 'bioggio', 'stabio', 'novaggio', 'viganello', 'massagno', 'paradiso',
 'agno', 'mezzovico', 'taverne', 'rivera', 'cadenazzo', 'giubiasco',
 'arbedo', 'castione', 'gordola', 'minusio', 'muralto', 'ascona',
 'losone', 'maggia', 'faido', 'airolo', 'brig', 'zurich', 'bern',
 'basel', 'luzern', 'winterthur', 'st-gallen', 'chur', 'davos',
 'ticino', 'graubunden', 'svizzera',
];

interface SlugParts { title: string; company: string | null; location: string | null }

/** Extract structured info from a slug (best-effort heuristic). */
function parseSlug(slug: string): SlugParts {
 let remaining = slug;
 let company: string | null = null;
 let location: string | null = null;

 // Try to find known location at end
 for (const loc of KNOWN_LOCATIONS) {
 if (remaining.endsWith(`-${loc}`)) {
 location = loc.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
 remaining = remaining.slice(0, -(loc.length + 1));
 break;
 }
 }

 // Try to find known company
 for (const comp of KNOWN_COMPANIES) {
 const idx = remaining.indexOf(comp);
 if (idx > 0) {
 company = comp.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
 remaining = remaining.slice(0, idx - 1);
 break;
 }
 }

 // Clean up percentage suffixes and hash suffixes
 remaining = remaining.replace(/-[a-z0-9]{6}$/, '').replace(/-(\d{2,3})$/, ' ($1%)');

 const title = remaining
 .replace(/-/g, ' ')
 .replace(/\b\w/g, (c) => c.toUpperCase())
 .trim()
 .slice(0, 80);

 return { title, company, location };
}

/** Read the static body HTML seeded by the build plugin (preserved across hydration). */
function getStaticBodyHtml(): string | null {
 try {
 const html = (window as unknown as Record<string, unknown>).__STATIC_BODY_HTML__;
 if (typeof html === 'string' && html.length > 0) return html;
 } catch { /* SSR or missing */ }
 return null;
}

/** Extract links from the"Posizioni attive recenti" section of static HTML. */
function extractActiveJobLinks(html: string): Array<{ href: string; title: string; company: string }> {
 const links: Array<{ href: string; title: string; company: string }> = [];
 // Match <li><a href="...">Title</a> — Company, Location</li>
 const liRegex = /<li><a href="([^"]+)"[^>]*>([^<]+)<\/a>\s*(?:—|&mdash;)\s*([^<]+)<\/li>/g;
 let match;
 while ((match = liRegex.exec(html)) !== null) {
 const fullText = match[3].trim();
 const parts = fullText.split(',');
 links.push({
 href: match[1].replace(/^https?:\/\/[^/]+/, ''),
 title: match[2].trim(),
 company: parts[0]?.trim() ?? '',
 });
 }
 return links;
}

export default function JobOrphanView({ slug, onBack, hasAccess: hasAccessProp, totalActiveJobs, onNavigateToCompany, onNavigateToLocation, onNavigateToJob }: JobOrphanViewProps) {
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

 const [staticBodyHtml] = useState(() => getStaticBodyHtml());

 const prefix = PREFIX_BY_LOCALE[locale] ?? '';
 const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
 const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');

 const slugParts = useMemo(() => parseSlug(slug), [slug]);

 // Derive companyKey from slug by matching the longest known key contained in it
 // (CRAWLED_COMPANY_LOGOS is keyed by the same companyKey used in adapters/jobs).
 const companyLogoUrl = useMemo(() => {
 const keys = Object.keys(CRAWLED_COMPANY_LOGOS).sort((a, b) => b.length - a.length);
 const derivedKey = keys.find((k) => slug.includes(k)) || '';
 return resolveCompanyLogoUrl({ company: slugParts.company || undefined, companyKey: derivedKey });
 }, [slug, slugParts.company]);
 const activeJobLinks = useMemo(
 () => staticBodyHtml ? extractActiveJobLinks(staticBodyHtml) : [],
 [staticBodyHtml],
 );

 const companySlug = slugParts.company
 ? `${COMPANY_ROUTE_PREFIX[locale] || 'azienda'}-${slugifyCompanyName(slugParts.company)}`
 : null;
 const companyHref = companySlug
 ? `${prefix}/${sectionSlug}/${companySlug}/`.replace(/\/+/g, '/')
 : null;

 const locationSlug = slugParts.location
 ? `${LOCATION_ROUTE_PREFIX[locale] || 'localita'}-${slugifyLocationName(slugParts.location)}`
 : null;
 const locationHref = locationSlug
 ? `${prefix}/${sectionSlug}/${locationSlug}/`.replace(/\/+/g, '/')
 : null;

 // ── Analytics ──

 useEffect(() => {
 Analytics.trackSelectContent('job_orphan_view', slug);
 }, [slug]);

 useEffect(() => {
 if (alreadySignedIn) return;
 Analytics.trackJobAuthFunnel('gate_view', {
 company: slugParts.company ?? undefined,
 jobTitle: slugParts.title,
 location: slugParts.location ?? undefined,
 });
 }, [alreadySignedIn, slug, slugParts.company, slugParts.title, slugParts.location]);

 // ── Auth methods ──

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
 if (!cancelled) reportCaughtError(err, 'jobOrphanView.renderGoogleButton');
 });
 return () => { cancelled = true; };
 }, [alreadySignedIn, listingPath]);

 useEffect(() => {
 if (alreadySignedIn) return;
 isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, [alreadySignedIn]);

 // ── Handlers ──

 const handleCompanyClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToCompany || !companySlug) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_board_company_filter_open', slugParts.company!);
 onNavigateToCompany(companySlug);
 };

 const handleLocationClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToLocation || !locationSlug) return;
 e.preventDefault();
 Analytics.trackSelectContent('job_board_location_filter_open', slugParts.location!);
 onNavigateToLocation(locationSlug);
 };

 const handleRelatedJobClick = (e: { preventDefault(): void }, linkHref: string) => {
 if (!onNavigateToJob) return;
 e.preventDefault();
 const jobSlug = linkHref.split('/').filter(Boolean).pop() || '';
 Analytics.trackSelectContent('job_orphan_related_click', jobSlug);
 onNavigateToJob(jobSlug);
 };

 const handleCtaClick = (e: { preventDefault(): void }) => {
 if (!onNavigateToJob) return;
 e.preventDefault();
 onNavigateToJob('');
 };

 const handleEmailSubmit = async (e: { preventDefault(): void }) => {
 e.preventDefault();
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) return;
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'email', company: slugParts.company ?? undefined, jobTitle: slugParts.title });
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
 source: 'job_orphan',
 sourceChannel: 'job_gate',
 sourcePage: window.location.pathname,
 sourceCta: 'job_orphan_email_unlock',
 sourceComponent: 'JobOrphanView',
 sourceRouteFamily: 'job-board',
 isActive: false,
 status: 'pending',
 });
 localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 window.location.href = listingPath;
 } catch {
 setEmailError(locale === 'it' ? 'Errore, riprova.' : 'Error, please retry.');
 } finally {
 setEmailBusy(false);
 }
 };

 // ── Shared elements ──

 const backButton = onBack && (
 <button
 onClick={onBack}
 className="inline-flex items-center gap-1.5 text-sm text-subtle hover:text-heading"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>
 );

 const jobHeaderCard = (
 <div className="rounded-xl border border-edge bg-surface/80 overflow-hidden">
 {/* Amber status bar */}
 <div className="bg-warning-subtle border-b border-warning-border px-5 py-2.5 flex items-center gap-2">
 <Briefcase size={14} className="text-warning shrink-0" />
 <span className="text-sm text-warning">
 {BANNER_COPY[locale] ?? BANNER_COPY.it}
 </span>
 </div>
 {/* Title + metadata */}
 <div className="px-4 py-3 sm:px-5 sm:py-4">
 <h1 className="text-xl font-bold font-display text-heading leading-snug">
 {slugParts.title}
 </h1>
 {(slugParts.company || slugParts.location) && (
 <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-2 text-sm leading-tight text-subtle">
 {slugParts.company && companyHref && (
 <a
 href={companyHref}
 onClick={handleCompanyClick}
 className="flex items-center gap-1.5 hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 <Building2 size={14} className="text-muted" />
 {slugParts.company}
 </a>
 )}
 {slugParts.location && locationHref && (
 <a
 href={locationHref}
 onClick={handleLocationClick}
 className="flex items-center gap-1.5 hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 <MapPin size={14} className="text-muted" />
 {slugParts.location}
 </a>
 )}
 </div>
 )}
 </div>
 </div>
 );

 const companyBanner = slugParts.company && companyHref && (
 <a
 href={companyHref}
 onClick={handleCompanyClick}
 className="block rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 rounded-lg bg-surface border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {companyLogoUrl ? (
 <img
 src={companyLogoUrl}
 alt={`Logo ${slugParts.company ?? ''}`.trim()}
 className="w-7 h-7 object-contain"
 width={28}
 height={28}
 loading="lazy"
 onError={handleCompanyLogoError}
 />
 ) : (
 <Building2 className="w-4 h-4 text-muted" />
 )}
 </div>
 <div className="min-w-0">
 <h3 className="text-sm font-bold text-heading">{t('jobBoard.companyHeading')}</h3>
 <p className="text-sm text-subtle mt-1">{slugParts.company}{slugParts.location ? ` · ${slugParts.location}` : ''}</p>
 <p className="text-sm text-muted mt-2">
 {locale === 'it' ? 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.' : locale === 'de' ? 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.' : locale === 'fr' ? 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' : 'Frontaliere Ticino discovered this opportunity through company monitoring.'}
 </p>
 </div>
 </div>
 </a>
 );

 const activeJobsSection = activeJobLinks.length > 0 && (
 <div className="space-y-3">
 <h2 className="text-base font-semibold font-display text-strong">
 {locale === 'it' ? 'Posizioni attive simili' : locale === 'de' ? 'Ähnliche offene Stellen' : locale === 'fr' ? 'Postes similaires ouverts' : 'Similar active jobs'}
 </h2>
 <ul className="space-y-2">
 {activeJobLinks.slice(0, 5).map((link) => (
 <li key={link.href}>
 <a
 href={link.href}
 onClick={(e) => handleRelatedJobClick(e, link.href)}
 className="flex items-center gap-3 rounded-xl border border-edge bg-surface px-4 py-3 hover:border-accent hover:shadow-sm transition-[color,background-color,border-color,box-shadow]"
 >
 <span className="flex-1 min-w-0">
 <span className="block font-medium text-sm text-strong truncate">{link.title}</span>
 {link.company && (
 <span className="block text-xs text-muted mt-0.5 truncate">{link.company}</span>
 )}
 </span>
 <ArrowRight size={14} className="text-muted shrink-0" />
 </a>
 </li>
 ))}
 </ul>
 </div>
 );

 const ctaLink = (
 <a
 href={listingPath}
 onClick={handleCtaClick}
 className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-xl bg-accent hover:bg-accent-hover text-on-accent text-sm font-semibold transition-colors"
 >
 <Search size={16} />
 {CTA_COPY[locale] ?? CTA_COPY.it}
 </a>
 );

 const staticContentDetails = staticBodyHtml && (
 <details className="group rounded-xl border border-edge bg-surface/80 overflow-hidden">
 <summary className="px-5 py-3.5 text-sm font-semibold text-body cursor-pointer select-none hover:bg-surface-raised/60 transition-colors list-none flex items-center gap-2">
 <Search size={14} className="text-muted" />
 {locale === 'it' ? 'Informazioni per frontalieri' : locale === 'de' ? 'Informationen für Grenzgänger' : locale === 'fr' ? 'Informations pour frontaliers' : 'Information for cross-border workers'}
 <ArrowRight size={12} className="ml-auto text-muted transition-transform group-open:rotate-90" />
 </summary>
 <div
 className="px-5 pb-4 prose prose-sm dark:prose-invert max-w-none text-subtle [&_h1]:hidden [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-body [&_h2]:mt-4 [&_h2]:mb-1.5 [&_section]:border-t [&_section]:border-edge [&_section]:pt-3 [&_section:first-of-type]:border-0 [&_a]:text-accent [&_ul]:pl-0 [&_ul]:list-none [&_li]:pl-0"
 dangerouslySetInnerHTML={{ __html: staticBodyHtml }}
 />
 </details>
 );

 // ── Logged-in view: single column with ads ──

 if (alreadySignedIn) {
 return (
 <div className="space-y-6 max-w-2xl mx-auto">
 {backButton}
 {jobHeaderCard}

 {/* Mobile/tablet in-article ad */}
 {!isDesktopLg && AD_SLOTS.ARTICLE_INLINE_MOBILE.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}
 adFormat={AD_SLOTS.ARTICLE_INLINE_MOBILE.format}
 />
 )}

 {companyBanner}
 {activeJobsSection}
 {staticContentDetails}
 <JobAlertSection initialKeyword={slugParts.title || ''} />
 {ctaLink}

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

 // ── Auth gate view: 3-column grid ──

 return (
 <div className="space-y-5">
 {backButton}

 {/* 3-column grid: left rail | content | right rail (desktop xl only) */}
 <div className="xl:grid xl:grid-cols-[180px_1fr_180px] xl:gap-6">

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className="hidden xl:block" />

 {/* ── Center content ── */}
 <div className="space-y-4">

 {/* Job header card */}
 {jobHeaderCard}

 {/* Company banner */}
 {companyBanner}

 {/* Active jobs */}
 {activeJobsSection}

 {/* Sign-in / alert block — orphan-context headline (slug has no job data → promise is "all active listings") */}
 <div id="job-auth-gate" role="region" aria-label={t('jobBoard.gate.title')} className="relative z-10 mt-3 scroll-mt-20 rounded-stripe border border-accent-border bg-accent-subtle p-4 sm:p-6">
 <h2 className="flex items-start gap-2 text-lg sm:text-xl font-bold font-display text-heading leading-tight">
 <Eye className="w-5 h-5 mt-0.5 text-accent flex-shrink-0" aria-hidden="true" />
 <span>{
 totalActiveJobs != null && totalActiveJobs > 0
 ? (locale === 'it' ? `Sblocca ${totalActiveJobs.toLocaleString()}+ annunci attivi` : locale === 'de' ? `${totalActiveJobs.toLocaleString()}+ aktive Stellen freischalten` : locale === 'fr' ? `Débloquer ${totalActiveJobs.toLocaleString()}+ offres actives` : `Unlock ${totalActiveJobs.toLocaleString()}+ active listings`)
 : (locale === 'it' ? 'Sblocca tutti gli annunci attivi' : locale === 'de' ? 'Alle aktiven Stellen freischalten' : locale === 'fr' ? 'Débloquer toutes les offres actives' : 'Unlock all active listings')
 }</span>
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

 <div className="mt-4 space-y-3">
 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
 {!googleButtonReady && (
 <button
 type="button"
 onClick={() => {
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'google', company: slugParts.company ?? undefined, jobTitle: slugParts.title });
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
 Analytics.trackJobAuthFunnel('auth_method_click', { method: 'linkedin', company: slugParts.company ?? undefined, jobTitle: slugParts.title });
 setLinkedInBusy(true);
 saveAuthJobContext({ slug, company: slugParts.company, location: slugParts.location });
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

 {/* Static content */}
 {staticContentDetails}

 {/* Job alert opt-in */}
 <JobAlertSection initialKeyword={slugParts.title || ''} />

 {/* CTA */}
 {ctaLink}
 </div>
 );
}
