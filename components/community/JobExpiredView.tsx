import { isCrawlerVisitorAgent } from '@/functions/src/lib/returnVisit.js';
import { jobDisplayTitle } from '../../scripts/lib/job-title-identity.mjs';
import { resolveReportedPostingDate } from '../../scripts/lib/job-posting-date.mjs';
/**
 * JobExpiredView — view for jobs found in /data/expired-jobs.json.
 *
 * Reuses the active JobDetail header, metadata pills, description panels,
 * 8/4 content/sidebar grid, and ad rails. Expiry status and recovery CTAs
 * replace application actions without changing AuthGate or crawler access.
 */

import { Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Briefcase, Building2, Calendar, CheckCircle2, ChevronDown, Clock, Euro, Eye, Loader2, Mail, MapPin, Search, Shield, Users } from 'lucide-react';
import { useLocale, t, type Locale } from '@/services/i18n';
import EmployerHubCta from '@/components/community/EmployerHubCta';
import CompanyFollowCta from '@/components/community/CompanyFollowCta';
import { Analytics } from '@/services/analytics';
import { renderGoogleButton, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { useLinkedInSignInAvailable, linkedInPendingClass } from '@/hooks/useLinkedInSignInAvailable';
import { AUTHGATE_HEADLINE_EXPERIMENT_ID, useAuthGateHeadlineVariant } from '@/services/authGateExperiment';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertUnifiedEmailSubscriber } from '@/services/newsletterSubscribers';
import { currentJobGateAssignment, recordJobGateExposure, shouldBypassJobGateExperiment, useJobGateExperiment } from '@/hooks/useJobGateExperiment';
import { getJobGateSubscriberVariant, JOBGATE_EXPERIMENT_ID } from '@/services/jobGateExperiment';
import { jobGateSkin } from '@/components/community/jobGateSkin';
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { handleCompanyLogoError } from '@/services/logoService';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { AD_SLOTS, shouldPlaceInfeedAd } from '@/services/adsenseSlots';
import { getJobLocationSnapshot } from '@/services/jobLocationSnapshot';
import { buildPath } from '@/services/router';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useCaptureImpression } from '@/hooks/useCaptureImpression';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseBanner from '@/components/shared/AdSenseBanner';
import ArticleRailAdStack from '@/components/shared/ArticleRailAdStack';
import Callout from '@/components/shared/Callout';
import JobAlertSection from '@/components/community/JobAlertSection';
import type { ExpiredJob } from '@/hooks/useExpiredJob';
import { useRailGridCollapse, RAIL_GRID_CLASS_X, RAIL_ASIDE_CLASS_X } from '@/components/shared/useRailGridCollapse';
import { formatJobLocation } from '../../scripts/lib/job-location-display.mjs';
import { jobDescriptionPlainText, jobDescriptionPreview } from '@/services/jobs/descriptionPreview';
import { SECTION_LEGACY_TI } from '@/build-plugins/shared/cantonSection';
import { readBestEffortLocalStorage, writeBestEffortLocalStorage } from '@/services/storageAvailability';
import { renderJobDescriptionContent } from '@/build-plugins/shared/jobDescriptionContent';
import { formatDaysAgo, formatJobContractLabel, formatJobSalary } from '@/services/jobs/jobCardMetadata';
import { useJobCopyAttribution } from '@/hooks/useJobCopyAttribution';
import { JOB_COPY_SITE_ORIGIN } from '@/services/jobCopyAttribution';
import JobSaveButton from '@/components/community/JobSaveButton';
import { toSaveableJob } from '@/services/jobSaveGate';
import {
 JobDetailHeaderCard,
 JobDetailMetadataRow,
 JobDetailMetaPill,
 JOB_DETAIL_HEADER_CONTENT_CLASS,
 JOB_DETAIL_HEADER_COPY_CLASS,
 JOB_DETAIL_HEADER_LOGO_FRAME_CLASS,
 JOB_DETAIL_HEADER_LOGO_IMAGE_CLASS,
 JOB_DETAIL_HEADER_SUBTITLE_CLASS,
 JOB_DETAIL_HEADER_TITLE_CLASS,
} from '@/components/community/JobDetailPresentation';

interface RelatedJob {
 id?: string;
 category?: string;
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
 datePosted?: string;
 postingDateSource?: string;
 postedDate?: string;
 crawledAt?: string;
 salaryMin?: number;
 salaryMax?: number;
 salarySource?: string;
 currency?: string;
 salaryCurrency?: string;
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

// Canonical TI legacy section table — imported, never re-declared (issue #7491).
const SECTION_BY_LOCALE: Record<string, string> = SECTION_LEGACY_TI;
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
  const { headline: gateHeadline, variant: headlineVariant } = useAuthGateHeadlineVariant(locale, t('jobBoard.gate.title'));
 const isDesktopLg = useMediaQuery('(min-width: 1024px)');
 const googleButtonRef = useRef<HTMLDivElement>(null);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const linkedInAvailable = useLinkedInSignInAvailable();
 const [emailInput, setEmailInput] = useState('');
 const [emailBusy, setEmailBusy] = useState(false);
 const [emailError, setEmailError] = useState<string | null>(null);
 const [linkedInBusy, setLinkedInBusy] = useState(false);
 // Collapses the 300px xlw rail gutter when ArticleRailAdStack resolves an
 // all-empty verdict per side — shared with JobBoard/JobOrphanView/
 // BlogArticles (issue 4830).
 const { onLeftEmptyResolved, onRightEmptyResolved, style: railStyle } = useRailGridCollapse();

 // Hide login block if user is already authenticated (prop) or has email access (localStorage)
 const isCrawlerVisitor = isCrawlerVisitorAgent(navigator.userAgent || '');
 const alreadySignedIn = isCrawlerVisitor || hasAccessProp || !!readBestEffortLocalStorage(JOB_EMAIL_ACCESS_KEY);
  const jobGate = useJobGateExperiment(shouldBypassJobGateExperiment() || alreadySignedIn);
  const gateVariant = jobGate.enrolled ? jobGate.arm : headlineVariant;
  const gateExperimentId = jobGate.enrolled ? JOBGATE_EXPERIMENT_ID : AUTHGATE_HEADLINE_EXPERIMENT_ID;
  const gateSkin = jobGateSkin(jobGate.arm);

 const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
 const prefix = PREFIX_BY_LOCALE[locale] ?? '';
 const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');

 const localizedTitle = jobDisplayTitle(job) || job.title;
 const handleGateCopy = useJobCopyAttribution({
 enabled: !alreadySignedIn,
 jobTitle: localizedTitle,
 company: job.company,
 url: `${JOB_COPY_SITE_ORIGIN}${listingPath}${job.slug}/`,
 lead: t('jobBoard.copyAttribution.lead'),
 analyticsValue: `${job.company}_${localizedTitle}`,
 });
 const description = job.descriptionByLocale?.[locale] || job.descriptionByLocale?.it || job.description || '';
 const requirements = job.requirementsByLocale?.[locale] || job.requirements || [];
 const descriptionPlain = jobDescriptionPlainText(description);
 const descriptionPreview = jobDescriptionPreview(description);
 // The full description is crawler/ATS HTML. It used to be injected raw, so a
 // `<img onerror>`, an `on*` attribute or a `javascript:` link in the source
 // ran on this page. Render it with the same serializer as the static job
 // pages: markdown → AST, HTML → allowlist sanitizer
 // (build-plugins/shared/jobDescription/sanitizeHtml.ts).
 const descriptionHtml = renderJobDescriptionContent(description, locale, Array.isArray(requirements) ? requirements : []);

 const expiredDate = job.expiredAt
 ? new Date(job.expiredAt).toLocaleDateString(locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
 : null;
 const jobSalary = formatJobSalary(job, locale);
 const jobContract = formatJobContractLabel(job.contract || job.employmentType || job.contractType, locale);
 const jobPosted = formatDaysAgo(resolveReportedPostingDate(job) ?? undefined, locale);

 const logoUrl = cdnImageUrl(resolveCompanyLogoUrl({ company: job.company, companyKey: job.companyKey }));
 const jobLocation = job.addressLocality ?? job.location ?? '';
 const newsletterJobContext = {
 slug: job.slug || null,
 company: job.company || null,
 location: jobLocation || null,
 category: job.sector || null,
 };

 const companySlug = job.company ? `${COMPANY_ROUTE_PREFIX[locale] || 'azienda'}-${slugifyCompanyName(job.company)}` : '';
 const companyHref = companySlug ? `${prefix}/${sectionSlug}/${companySlug}/`.replace(/\/+/g, '/') : '';
 // The evergreen `/aziende/<slug>/` hub for THIS employer is resolved inside
 // <EmployerHubCta> (see `employerHubCta` below): the hook lives with the
 // markup so no surface can hold the hub without rendering it the shared way.
 const locationSlug = jobLocation ? `${LOCATION_ROUTE_PREFIX[locale] || 'localita'}-${slugifyLocationName(jobLocation)}` : '';
 const locationHref = locationSlug ? `${prefix}/${sectionSlug}/${locationSlug}/`.replace(/\/+/g, '/') : '';

 // ── Analytics ──

 useEffect(() => {
 Analytics.trackSelectContent('job_expired_view', job.slug);
 }, [job.slug]);

 useEffect(() => {
 if (alreadySignedIn || !jobGate.ready) return;
 Analytics.trackJobAuthFunnel('gate_view', {
 company: job.company,
 jobTitle: localizedTitle,
 location: jobLocation,
 surface: 'expired',
 variant: gateVariant,
 experimentId: gateExperimentId,
 jobSlug: job.slug,
 });
  }, [job.slug, alreadySignedIn, jobGate.ready, gateVariant, gateExperimentId]);

 // Visible-gate impression, paired on cta_id with the email success below:
 // `job_auth_gate.expired.unknown.view` → `job_auth_gate.expired.email.success`.
 const gateImpressionRef = useCaptureImpression({
  page: 'job_auth_gate',
  section: 'expired',
  variant: 'view',
  ctaId: 'job_auth_gate.expired.unknown.view',
   enabled: !alreadySignedIn && jobGate.ready,
  emit: () => {
   recordJobGateExposure(jobGate);
   Analytics.trackJobAuthGate('view', {
    surface: 'expired',
    authState: 'anonymous',
    variant: gateVariant,
    experimentId: gateExperimentId,
    jobSlug: job.slug,
   });
  },
 });

 // ── Auth setup ──

 useEffect(() => {
 if (alreadySignedIn) return;
 const container = googleButtonRef.current;
 if (!container) return;
 let cancelled = false;

 sessionStorage.setItem('auth_redirect_path', window.location.pathname);

 container.innerHTML = '';
 renderGoogleButton(container, {
  theme: 'outline',
  size: 'large',
  text: 'signin_with',
  click_listener: () => {
   Analytics.trackJobAuthGate('method_click', {
    surface: 'expired',
    method: 'google',
    authState: 'anonymous',
    variant: gateVariant,
    experimentId: gateExperimentId,
    jobSlug: job.slug,
   });
   Analytics.trackJobAuthFunnel('auth_method_click', {
    method: 'google',
    company: job.company,
    jobTitle: localizedTitle,
    location: jobLocation,
    surface: 'expired',
    authState: 'anonymous',
    variant: gateVariant,
    experimentId: gateExperimentId,
    jobSlug: job.slug,
   });
   saveAuthJobContext({
    slug: job.slug,
    title: localizedTitle,
    company: job.company,
    location: job.location || job.addressLocality,
    category: job.sector,
    surface: 'expired',
    variant: gateVariant,
    experimentId: gateExperimentId,
   });
  },
 })
 .then(() => {
 if (!cancelled) setGoogleButtonReady(container.children.length > 0);
 })
 .catch((err) => {
 if (!cancelled) reportCaughtError(err, 'jobExpiredView.renderGoogleButton');
 });
 return () => { cancelled = true; };
 }, [alreadySignedIn, listingPath, gateVariant, gateExperimentId, job.slug, job.company, localizedTitle, jobLocation]);

 useEffect(() => {
 if (alreadySignedIn) return;
 }, [alreadySignedIn]);

 const handleEmailSubmit = async (e: { preventDefault(): void }) => {
 e.preventDefault();
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) return;
 Analytics.trackJobAuthGate('method_click', {
  surface: 'expired',
  method: 'email',
  authState: 'anonymous',
  variant: gateVariant,
  experimentId: gateExperimentId,
  jobSlug: job.slug,
 });
 Analytics.trackJobAuthFunnel('auth_method_click', {
  method: 'email',
  company: job.company,
  jobTitle: localizedTitle,
  location: jobLocation,
  surface: 'expired',
  authState: 'anonymous',
  variant: gateVariant,
  experimentId: gateExperimentId,
  jobSlug: job.slug,
 });
 setEmailBusy(true);
 setEmailError(null);
 try {
 const [{ getFirestore }, { getApp }] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 ]);
 const firestore = getFirestore(await getApp());
 const subscriberVariant = getJobGateSubscriberVariant(await currentJobGateAssignment());
 await upsertUnifiedEmailSubscriber(firestore, {
 email,
 source: 'job_expired',
 sourceChannel: 'job_gate',
 sourcePage: window.location.pathname,
 sourceCta: 'job_expired_email_unlock',
 sourceComponent: 'JobExpiredView',
 sourceRouteFamily: 'job-board',
 jobContext: newsletterJobContext,
 ...(subscriberVariant ? { variant: subscriberVariant } : {}),
 });
 Analytics.trackJobAuthGate('success', {
  surface: 'expired',
  method: 'email',
  authState: 'pending_email',
  variant: gateVariant,
  experimentId: gateExperimentId,
  jobSlug: job.slug,
 });
 Analytics.trackJobAuthFunnel('auth_success', {
  method: 'email',
  emailDomain: email.split('@')[1] || 'unknown',
  company: job.company,
  jobTitle: localizedTitle,
  location: jobLocation,
  surface: 'expired',
  authState: 'pending_email',
  variant: gateVariant,
  experimentId: gateExperimentId,
  jobSlug: job.slug,
 });
 Analytics.trackNewsletter('subscribe', email.split('@')[1] || 'unknown', {
  sourceChannel: 'job_gate',
  sourceCta: 'job_expired_email_unlock',
  sourcePage: window.location.pathname,
  jobSlug: job.slug,
  registrationMethod: 'email',
 });
 writeBestEffortLocalStorage(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 window.location.reload();
 } catch {
 setEmailError(locale === 'it' ? 'Errore, riprova.' : 'Error, please retry.');
 } finally {
 setEmailBusy(false);
 }
 };

 // ── SPA navigation helpers ──

 // Expired/Orphan views always route the company link through SPA in-app
 // navigation (a <button>, never an <a href>), because the viewed job is NOT
 // active: its company may have rotated out of the current build (zero active
 // jobs → no static hub emitted). A full navigation to the hub URL would 404
 // → 404.html saves the URL → location.replace('/') → SPA restore →
 // staticOverlay:true → BLANK PAGE (the burkhalter-group incident,
 // build-plugins/staticPagesPlugin.ts:~1341). SPA nav instead resolves to an
 // empty-but-browsable board (HTTP 200) — strictly safer. Using a <button>
 // (no href) makes this fail-safe by construction: middle-click / cmd-click /
 // "open in new tab" cannot bypass the handler into a possible-404 full-nav,
 // which an <a href> would allow. See issue #1183 / PR #1156 Non implementato.
 const handleCompanyClick = (e: MouseEvent<HTMLButtonElement>) => {
 if (!companySlug) return;
 e.preventDefault();
 e.stopPropagation();
 e.nativeEvent.stopImmediatePropagation?.();
 Analytics.trackSelectContent('job_board_company_filter_open', job.company);
 if (onNavigateToCompany) {
 onNavigateToCompany(companySlug);
 } else if (companyHref) {
 window.history.pushState({ route: { activeTab: 'job-board', jobSlug: companySlug } }, '', companyHref.split('?')[0]);
 window.dispatchEvent(new PopStateEvent('popstate'));
 window.scrollTo({ top: 0, behavior: 'smooth' });
 }
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
 className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-accent hover:underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 rounded-stripe"
 >
 <ArrowLeft size={14} />
 {t('jobBoard.backToList')}
 </button>
 );

 // Back link + top leaderboard share one row — same header as the active job
 // detail (JobBoard.tsx): the back link keeps its natural width, the desktop
 // banner fills the rest of the row. Banner is lg+ only.
 const topBannerRow = (
 <div className="flex flex-wrap items-center gap-3 sm:gap-4">
 {backButton}
 {isDesktopLg && AD_SLOTS.JOBDETAIL_TOP_BANNER.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_TOP_BANNER.slot}
 adFormat={AD_SLOTS.JOBDETAIL_TOP_BANNER.format}
 fullWidthResponsive={AD_SLOTS.JOBDETAIL_TOP_BANNER.fullWidthResponsive}
 className="flex-1 min-w-0"
 />
 )}
 </div>
 );

 /**
  * CompanyAlert (#5012) — «Segui questa azienda» on an EXPIRED ad.
  *
  * The highest-intent placement the feature has: the reader arrived for a job
  * that no longer exists, so "tell me when this employer posts again" is the
  * only action left that still does something for them. Rendered inside
  * `jobHeader`, right under the employer-hub link, in BOTH layouts — it used
  * to hang off the company banner further down, which (as that banner's own
  * comment notes) renders below the auth gate and the end-of-page ad in the
  * gated layout, i.e. out of reach of the logged-out reader this CTA exists
  * for. The component handles the anonymous case itself (email capture +
  * double opt-in), so no session is needed to take it.
  */
 const companyFollowCta = job.company ? (
   <Suspense fallback={null}>
     <CompanyFollowCta
       company={job.company}
       companyKey={job.companyKey ?? null}
       locale={locale as Locale}
       surface="company_follow_expired"
       sourceJobSlug={job.slug ?? null}
       sourceJobTitle={job.title ?? null}
     />
   </Suspense>
 ) : null;

 /**
  * The one link on this page that still leads somewhere permanent.
  *
  * The whole thing — the existence proof, the `<a href>`, the anchor and the
  * analytics label — lives in `components/community/EmployerHubCta.tsx`,
  * shared with JobOrphanView and with the ACTIVE ad in JobBoard. Read that
  * file for why it is an `<a href>` while the company NAME below stays a
  * `<button>`: the two are opposites on purpose, and only the hub has the
  * emitted-page proof that makes a full navigation safe.
  *
  * Rendered inside `jobHeader`, so it lands directly under the job title in
  * BOTH layouts — including the logged-out auth gate, where it is the only
  * useful destination a visitor can reach without signing in.
  */
 const employerHubCta = (
 <EmployerHubCta company={job.company} companyKey={job.companyKey} locale={locale as Locale} />
 );

 const jobHeader = (
 <JobDetailHeaderCard data-no-auto-ads="inside">
 <div className={JOB_DETAIL_HEADER_CONTENT_CLASS}>
 <div className={JOB_DETAIL_HEADER_LOGO_FRAME_CLASS} aria-hidden={!logoUrl}>
 {logoUrl ? (
 <img
 src={logoUrl}
 alt={job.company || ''}
 width={56}
 height={56}
 className={JOB_DETAIL_HEADER_LOGO_IMAGE_CLASS}
 decoding="async"
 onError={handleCompanyLogoError}
 />
 ) : (
 <Building2 className="w-9 h-9 text-muted" aria-hidden="true" />
 )}
 </div>
 <div className={JOB_DETAIL_HEADER_COPY_CLASS}>
 <h1 className={JOB_DETAIL_HEADER_TITLE_CLASS}>{localizedTitle}</h1>
 <p className={JOB_DETAIL_HEADER_SUBTITLE_CLASS}>
 {job.company && (companyHref ? (
 <button
 type="button"
 onClick={handleCompanyClick}
 className="hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 {job.company}
 </button>
 ) : job.company)}
 {job.company && jobLocation ? ' · ' : ''}
 {jobLocation && (locationHref ? (
 <a
 href={locationHref}
 onClick={handleLocationClick}
 className="hover:text-accent hover:underline underline-offset-2 transition-colors"
 >
 {jobLocation}
 </a>
 ) : jobLocation)}
 </p>
 </div>
 </div>
 <JobDetailMetadataRow>
 {job.sector && <JobDetailMetaPill tone="neutral">{job.sector}</JobDetailMetaPill>}
 {jobContract && <JobDetailMetaPill tone="accent">{jobContract}</JobDetailMetaPill>}
 {jobPosted && <JobDetailMetaPill tone="success" icon={<Clock className="w-3 h-3" aria-hidden="true" />}>{jobPosted}</JobDetailMetaPill>}
 {jobSalary && <JobDetailMetaPill tone="success" icon={<Euro className="w-3 h-3" aria-hidden="true" />}>{jobSalary}</JobDetailMetaPill>}
 {alreadySignedIn && (
 <JobDetailMetaPill tone="warning" icon={<Clock className="w-3 h-3" aria-hidden="true" />}>
 {BANNER_COPY[locale] ?? BANNER_COPY.it}
 </JobDetailMetaPill>
 )}
 {alreadySignedIn && expiredDate && (
 <JobDetailMetaPill tone="warning" icon={<Calendar className="w-3 h-3" aria-hidden="true" />}>
 {EXPIRED_AT_COPY[locale] ?? EXPIRED_AT_COPY.it} {expiredDate}
 </JobDetailMetaPill>
 )}
 </JobDetailMetadataRow>
 {employerHubCta}
 {/* And the follow CTA right under it: same employer, same question, and the
     one ask on this page that needs no account. It used to hang off the
     company banner further down — which, as the banner's own comment notes,
     renders BELOW the auth gate and the end-of-page ad in the gated layout,
     i.e. out of reach of exactly the logged-out visitor it was written for.
     Same move as the active ad in JobBoard, same reason. */}
 {companyFollowCta}
 </JobDetailHeaderCard>
 );


 // The banner deliberately keeps pointing at the in-app company FILTER, not at
 // the hub: it is a different destination (the live board, scoped to this
 // employer) and it is the only one that still resolves when no hub was emitted.
 // The hub link is `employerHubCta` above — one per page, and placed where a
 // logged-out visitor actually sees it, since this banner renders below the auth
 // gate and the end-of-page ad in the gated layout. `companyFollowCta` used to
 // hang off THIS banner and moved up beside the hub link for exactly the reason
 // this comment already gave: whatever sits here is below the gate.
 const companyBanner = job.company && companyHref && (
 <>
 <button
 type="button"
 onClick={handleCompanyClick}
 className="block w-full text-left rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
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
 </button>
 </>
 );

 const relatedJobsSection = relatedJobs.length > 0 && (
 <section className="rounded-2xl border border-edge bg-surface p-5">
 <h2 className="text-lg font-bold font-display text-heading mb-4">{RELATED_COPY[locale] ?? RELATED_COPY.it}</h2>
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-job-related-grid>
 {relatedJobs.slice(0, 6).flatMap((rj, rjIdx, rjArr) => {
 const rjSlug = rj.slug;
 const rjTitle = jobDisplayTitle(rj) || rjSlug;
 const rjLocation = formatJobLocation(rj.location, rj.canton);
 const rjPath = `${prefix}/${sectionSlug}/${rjSlug}/`.replace(/\/+/g, '/');
 const rjLogo = cdnImageUrl(resolveCompanyLogoUrl({ company: rj.company, companyKey: rj.companyKey, companyDomain: rj.companyDomain, url: rj.url }));
 const rjSalary = formatJobSalary(rj, locale);
 const rjContract = formatJobContractLabel(rj.contract, locale);
 const rjPosted = formatDaysAgo(resolveReportedPostingDate(rj) ?? undefined, locale);
 const card = (
 <article
 key={rjSlug}
 className={`relative rounded-xl border p-3 sm:p-4 transition-colors min-h-[72px] ${
 rj.featured ? 'border-warning-border bg-warning-subtle hover:border-warning' : 'border-edge bg-surface/50 hover:border-accent-border'
 }`}
 >
 {rj.id && <JobSaveButton job={toSaveableJob({ ...rj, id: rj.id, title: rj.title || rjTitle, company: rj.company || '' })} surface="card_related" />}
 <a href={rjPath} onClick={(e) => handleRelatedJobClick(e, rjSlug)} className="block pr-9 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg">
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
 {rj.company}{rjLocation ? ` · ${rjLocation}` : ''}
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
 // Keep the standard job-detail cadence: one in-feed ad after each third
 // related card, spanning the complete card grid, never after the last.
 if (rjIdx + 1 < rjArr.length && shouldPlaceInfeedAd(rjIdx + 1)) {
 const adCfg = isDesktopLg ? AD_SLOTS.JOBLIST_INFEED_DESKTOP : AD_SLOTS.JOBLIST_INFEED_MOBILE;
 return [
 card,
 // The banner owns the reserve so terminal no-fill leaves no orphan wrapper.
 <div key={`rel-infeed-${rjSlug}`} className="col-span-full min-w-0" data-job-related-ad>
 <AdSenseBanner className="my-3" placement={`expired-related-${rjIdx}`} adSlot={adCfg.slot} adFormat={adCfg.format} fullWidthResponsive={adCfg.fullWidthResponsive} />
 </div>,
 ];
 }
 return [card];
 })}
 </div>
 </section>
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
 postalCode: job.postalCode,
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
 <div className="space-y-6" data-expired-layout="authenticated">
 {topBannerRow}

 {/* 3-column rail grid: left rail | content | right rail — same full-height
     side-rail layout as the active job detail. Rails 180px at xl (1280–1399),
     300px at xlw (≥1400) to host ArticleRailAd half-page creatives. */}
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <ArticleRailAdStack side="left" onEmptyResolved={onLeftEmptyResolved} />
 </aside>

 {/* ── Center content (12-col job-detail grid) ── */}
 <div className="min-w-0 w-full grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
 {/* ── Main content (8 cols) ── */}
 <article className="lg:col-span-8 lg:self-start space-y-4 sm:space-y-5">
 {jobHeader}

 {(descriptionPlain || requirements.length > 0) && (
 <div className="section rounded-2xl border border-edge bg-surface p-4 sm:p-5 prose prose-sm dark:prose-invert max-w-none text-body" data-job-detail-description dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
 )}

 <section aria-label={t('jobBoard.snapshotTitle')} className="lg:hidden rounded-2xl border border-edge bg-surface p-4 space-y-3" data-job-detail-mobile-sidebar>
 <dl className="grid grid-cols-2 gap-2 text-xs">
 {jobLocation && (
  <div className="rounded-lg bg-surface-alt p-2 text-center">
   <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.location')}</dt>
   <dd className="font-semibold font-display text-strong mt-0.5 leading-tight truncate">{locationSnapshot?.locality || jobLocation}</dd>
  </div>
 )}
 {expiredDate && (
  <div className="rounded-lg bg-surface-alt p-2 text-center">
   <dt className="uppercase tracking-wide text-[10px] text-muted">{EXPIRED_AT_COPY[locale] ?? EXPIRED_AT_COPY.it}</dt>
   <dd className="font-semibold font-display text-strong mt-0.5 leading-tight">{expiredDate}</dd>
  </div>
 )}
 {jobContract && (
  <div className="rounded-lg bg-surface-alt p-2 text-center">
   <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.contract')}</dt>
   <dd className="font-semibold font-display text-strong mt-0.5 leading-tight">{jobContract}</dd>
  </div>
 )}
 {jobPosted && (
  <div className="rounded-lg bg-surface-alt p-2 text-center">
   <dt className="uppercase tracking-wide text-[10px] text-muted">{t('jobBoard.snapshot.published')}</dt>
   <dd className="font-semibold font-display text-strong mt-0.5 leading-tight">{jobPosted}</dd>
  </div>
 )}
 </dl>
 <a
  href={listingPath}
  onClick={handleCtaClick}
  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 min-h-[48px] text-base font-semibold font-display bg-success-strong hover:bg-success-strong-hover text-on-accent rounded-lg"
 >
  {t('jobBoard.expiredAdviceCta')}
 </a>
 </section>

 {/* Mobile/tablet in-article ad */}
 {!isDesktopLg && AD_SLOTS.ARTICLE_INLINE_MOBILE.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}
 adFormat={AD_SLOTS.ARTICLE_INLINE_MOBILE.format}
 adLayout={AD_SLOTS.ARTICLE_INLINE_MOBILE.layout}
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

 <JobAlertSection initialKeyword={job.title || ''} />
 </article>

 {/* ── Sidebar (4 cols, desktop only) ── */}
 <aside className="hidden lg:block lg:col-span-4">
 <div className="sticky top-20 space-y-4">
 {/* Snapshot annuncio */}
 {(jobLocation || expiredDate || jobContract || jobPosted || (locationSnapshot?.crossings && locationSnapshot.crossings.length > 0)) && (
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
 {jobContract && (
 <div className="flex items-center justify-between gap-2">
 <span>{t('jobBoard.snapshot.contract')}</span>
 <span className="font-semibold font-display text-strong">{jobContract}</span>
 </div>
 )}
 {jobPosted && (
 <div className="flex items-center justify-between gap-2">
 <span>{t('jobBoard.snapshot.published')}</span>
 <span className="font-semibold font-display text-strong">{jobPosted}</span>
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

 {/* ── Right Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <ArticleRailAdStack side="right" onEmptyResolved={onRightEmptyResolved} />
 </aside>
 </div>

 {/* End multiplex and related jobs follow the same full-width order as the
     active job detail, below its 8/4 content-and-sidebar grid. */}
 {AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.JOBDETAIL_END_MULTIPLEX.format}
 className="mt-2"
 />
 )}
 {relatedJobsSection}
 </div>
 );
 }

 // ── Auth gate view: matches active job layout ──

 return (
 <div className="space-y-6" data-no-auto-ads="inside" data-expired-layout="gated">
 {topBannerRow}
 {/* Status banner ("no longer active") deferred until sign-in: a logged-out
     visitor sees the gate, not the dead-job notice. Shown in the logged-in view. */}

 {/* 3-column grid: left rail | content | right rail. 180px at xl (1280–1399),
     300px at xlw (≥1400) to host ArticleRailAd half-page creatives. */}
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>

 {/* ── Left Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <ArticleRailAdStack side="left" onEmptyResolved={onLeftEmptyResolved} />
 </aside>

 {/* ── Center content ── */}
 <div className="min-w-0 w-full space-y-5" data-expired-gated-content>

 {/* Job header card */}
 <div onCopy={handleGateCopy}>
 <div className="rounded-stripe border border-edge bg-surface p-5 sm:p-6 shadow-stripe-sm">
 {jobHeader}

 {/* Readable description teaser — shows first ~200 chars to create information
 scent and an "open loop" that motivates signup. Fades out at the bottom.
 Hidden on landscape phones (≤540px viewport) so the gate CTAs land above the fold.
 svh, NOT dvh: dvh re-resolves on mobile URL-bar collapse/expand, oscillating
 maxHeight 0↔80px and shifting the gate below on every scroll direction change. */}
 {descriptionPreview && (
 <div className="relative mt-5 w-full overflow-hidden rounded-stripe border border-edge bg-surface-alt/60 [@media(max-height:540px)]:hidden max-h-[clamp(0px,calc(100svh_-_500px),112px)]">
 <p data-job-description-preview className="px-3 py-2.5 text-sm text-body leading-relaxed whitespace-pre-line sm:px-4 sm:py-3">
 {descriptionPreview}
 </p>
 <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-alt/95 to-transparent" />
 </div>
 )}
 </div>

 {/* Auth gate */}
 <div ref={gateImpressionRef} id="job-auth-gate" role="region" aria-label={t('jobBoard.gate.title')} className={gateSkin.container} data-jobgate-arm={jobGate.enrolled ? jobGate.arm : undefined}>
 <h2 className={gateSkin.heading}>
 <Eye className={gateSkin.headingIcon} aria-hidden="true" />
 <span>{gateHeadline}</span>
 </h2>

 {/* Trust signals — 2 lines at text-sm (matches active job gate) */}
 <ul className={gateSkin.trustList}>
 <li className="flex items-center gap-2">
 <CheckCircle2 size={14} className={gateSkin.trustIcon} aria-hidden="true" />
 <span>{locale === 'it' ? 'Gratis · Per sempre' : locale === 'de' ? 'Kostenlos · Für immer' : locale === 'fr' ? 'Gratuit · Pour toujours' : 'Free · Forever'}</span>
 </li>
 <li className="flex items-center gap-2">
 <Shield size={14} className={gateSkin.trustIcon} aria-hidden="true" />
 <span>{t('jobBoard.gate.privacyNote')}</span>
 </li>
 </ul>

 {/* Social proof */}
 {totalActiveJobs != null && totalActiveJobs > 0 && (
 <p className="mt-3 text-xs font-medium text-accent">
 {totalActiveJobs.toLocaleString()}+ {locale === 'it' ? 'annunci disponibili' : locale === 'de' ? 'verfügbare Stellenangebote' : locale === 'fr' ? 'offres disponibles' : 'listings available'}
 </p>
 )}

 <div className={gateSkin.actionsFirst ? 'space-y-3' : 'mt-4 space-y-3'}>
 <div className="space-y-2">
 <div ref={googleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-stripe" />
 {!googleButtonReady && (
 <button
 type="button"
 onClick={() => {
  Analytics.trackJobAuthGate('method_click', {
   surface: 'expired',
   method: 'google',
   authState: 'anonymous',
   variant: gateVariant,
   experimentId: gateExperimentId,
   jobSlug: job.slug,
  });
  Analytics.trackJobAuthFunnel('auth_method_click', {
   method: 'google',
   company: job.company,
   jobTitle: localizedTitle,
   location: jobLocation,
   surface: 'expired',
   authState: 'anonymous',
   variant: gateVariant,
   experimentId: gateExperimentId,
   jobSlug: job.slug,
  });
 }}
 className={gateSkin.googleFallbackButton}
 >
 {t('newsletter.popup.googleSignIn')}
 </button>
 )}
 </div>
 {linkedInAvailable !== false && (
 <button
 type="button"
 disabled={linkedInBusy}
 onClick={() => {
  Analytics.trackJobAuthGate('method_click', {
   surface: 'expired',
   method: 'linkedin',
   authState: 'anonymous',
   variant: gateVariant,
   experimentId: gateExperimentId,
   jobSlug: job.slug,
  });
  Analytics.trackJobAuthFunnel('auth_method_click', {
   method: 'linkedin',
   company: job.company,
   jobTitle: localizedTitle,
   location: jobLocation,
   surface: 'expired',
   authState: 'anonymous',
   variant: gateVariant,
   experimentId: gateExperimentId,
   jobSlug: job.slug,
  });
 setLinkedInBusy(true);
 saveAuthJobContext({ slug: job.slug, title: localizedTitle, company: job.company, location: job.location || job.addressLocality, category: job.sector, surface: 'expired', variant: gateVariant, experimentId: gateExperimentId });
 signInWithLinkedIn().catch(() => setLinkedInBusy(false));
 }}
 className={`${gateSkin.linkedInButton}${linkedInPendingClass(linkedInAvailable)}`}
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
 <div className={gateSkin.divider} />
 <span className={gateSkin.dividerLabel}>
 {t('jobBoard.authGateOrEmail')}
 <ChevronDown size={14} className="transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
 </span>
 <div className={gateSkin.divider} />
 </summary>
 <form onSubmit={handleEmailSubmit} className="mt-3 space-y-2">
 <EmailInput
 value={emailInput}
 onChange={setEmailInput}
 placeholder={t('jobBoard.authGateEmailPlaceholder')}
 className={gateSkin.emailInput}
 />
 <button
 type="submit"
 disabled={emailBusy || (gateSkin.emailSubmitDisabledWhenEmpty && !emailInput.trim())}
 className={gateSkin.emailSubmit}
 >
 {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
 {t('jobBoard.gate.emailCta')}
 </button>
 </form>
 <EmailConsentCheckbox
   id="job-expired-email-consent"
   consentKey="communicationsOptIn"
   locale={locale}
   className="mt-2 flex items-start gap-2 cursor-pointer"
   noticeClassName="text-[10px] text-muted leading-snug"
 />
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

 {/* Keep the remaining detail content inside the same full-width center
     column as the gate and between the desktop ad rails. */}
 {companyBanner}
 {relatedJobsSection}
 <JobAlertSection initialKeyword={job.title || ''} />
 {ctaLink}
 </div>

 {/* ── Right Rail (desktop xl only) ── */}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <ArticleRailAdStack side="right" onEmptyResolved={onRightEmptyResolved} />
 </aside>
 </div>

 {/* AdSense — end multiplex below 3-column layout */}
 {AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.AUTHGATE_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.AUTHGATE_END_MULTIPLEX.format}
 className="mt-2"
 />
 )}

 </div>
 );
}
