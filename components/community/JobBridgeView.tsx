/**
 * JobBridgeView — view for job pages where the URL has changed (bridge pages).
 *
 * Shown when window.__BRIDGE_TARGET_SLUG__ is set by the plugin's static HTML
 * template, meaning the old slug is still indexed by Google but the job is
 * active under a new slug. Redirects automatically after a countdown.
 *
 * Layout: blue banner → countdown + direct link → job header →
 * Google Sign-In → AdSense → related jobs → CTA
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Clock, Euro, Loader2, Mail, MapPin, Shield } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseUnit from '@/components/shared/AdSenseUnit';

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

interface BridgeJobData {
 title?: string;
 titleByLocale?: Record<string, string>;
 company?: string;
 location?: string;
}

interface JobBridgeViewProps {
 targetSlug: string;
 jobData?: BridgeJobData;
 relatedJobs?: RelatedJob[];
 onBack?: () => void;
 /** When true the user is already authenticated — hide the sign-in block. */
 hasAccess?: boolean;
}

const SECTION_BY_LOCALE: Record<string, string> = {
 it: 'cerca-lavoro-ticino',
 en: 'find-jobs-ticino',
 de: 'jobs-im-tessin',
 fr: 'trouver-emploi-tessin',
};
const PREFIX_BY_LOCALE: Record<string, string> = { it: '', en: '/en', de: '/de', fr: '/fr' };

const COMPANY_ROUTE_PREFIX: Record<string, string> = { it: 'azienda', en: 'company', de: 'unternehmen', fr: 'entreprise' };
function slugifyCompanyName(name: string): string {
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
 it: 'Questo annuncio è stato aggiornato — ti portiamo alla versione corrente.',
 en: 'This job listing has been updated — redirecting you to the current version.',
 de: 'Diese Stellenanzeige wurde aktualisiert — Sie werden zur aktuellen Version weitergeleitet.',
 fr:"Cette offre a été mise à jour — vous allez être redirigé vers la version actuelle.",
};
const REDIRECT_COPY: Record<string, string> = {
 it: 'Reindirizzamento in {n} secondi…',
 en: 'Redirecting in {n} seconds…',
 de: 'Weiterleitung in {n} Sekunden…',
 fr: 'Redirection dans {n} secondes…',
};
const GO_NOW_COPY: Record<string, string> = {
 it:"Vai all'annuncio aggiornato",
 en: 'Go to updated listing',
 de: 'Zur aktuellen Stelle',
 fr:"Voir l'offre mise à jour",
};
const SIGNUP_COPY: Record<string, string> = {
 it: 'Accedi per ricevere offerte simili via email',
 en: 'Sign in to receive similar job alerts by email',
 de: 'Anmelden für ähnliche Stellenangebote per E-Mail',
 fr:"Connectez-vous pour recevoir des alertes d'emplois similaires",
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
 fr:"Toutes les offres d'emploi au Tessin",
};

const EMAIL_OR_COPY: Record<string, string> = {
 it: 'oppure con email',
 en: 'or with email',
 de: 'oder mit E-Mail',
 fr: 'ou par email',
};
const EMAIL_PLACEHOLDER_COPY: Record<string, string> = {
 it: 'La tua email',
 en: 'Your email',
 de: 'Ihre E-Mail',
 fr: 'Votre email',
};
const EMAIL_CTA_COPY: Record<string, string> = {
 it: 'Continua con email',
 en: 'Continue with email',
 de: 'Weiter mit E-Mail',
 fr: 'Continuer avec email',
};

const JOB_EMAIL_ACCESS_KEY = 'ft_job_email';
const COUNTDOWN_SECONDS = 3;

export default function JobBridgeView({ targetSlug, jobData, relatedJobs = [], onBack, hasAccess: hasAccessProp }: JobBridgeViewProps) {
 const [locale] = useLocale();
 const googleButtonRef = useRef<HTMLDivElement>(null);
 const [googleButtonReady, setGoogleButtonReady] = useState(false);
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
 const [emailInput, setEmailInput] = useState('');
 const [emailBusy, setEmailBusy] = useState(false);
 const [emailError, setEmailError] = useState<string | null>(null);
 const [linkedInBusy, setLinkedInBusy] = useState(false);

 // Hide login block if user is already authenticated (prop) or has email access (localStorage)
 const alreadySignedIn = hasAccessProp || !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY);

 const prefix = PREFIX_BY_LOCALE[locale] ?? '';
 const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
 const targetPath = `${prefix}/${sectionSlug}/${targetSlug}/`.replace(/\/+/g, '/');
 const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');
 const localizedTitle = jobData?.titleByLocale?.[locale] ?? jobData?.title;

 // Countdown redirect
 useEffect(() => {
 if (countdown <= 0) {
 window.location.href = targetPath;
 return;
 }
 const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
 return () => clearTimeout(timer);
 }, [countdown, targetPath]);

 useEffect(() => {
 const container = googleButtonRef.current;
 if (!container) return;
 let cancelled = false;

 // Save redirect path so One Tap / Google Sign-In navigates to the target job after auth
 sessionStorage.setItem('auth_redirect_path', targetPath);

 container.innerHTML = '';
 renderGoogleButton(container, { theme: 'outline', size: 'large', text: 'signin_with' })
 .then(() => {
 if (!cancelled) setGoogleButtonReady(container.children.length > 0);
 })
 .catch((err) => {
 if (!cancelled) reportCaughtError(err, 'jobBridgeView.renderGoogleButton');
 });
 return () => { cancelled = true; };
 }, [targetPath]);

 useEffect(() => {
 isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {});
 }, []);

 const redirectCopy = (REDIRECT_COPY[locale] ?? REDIRECT_COPY.it).replace('{n}', String(countdown));

 const handleEmailSubmit = async (e: { preventDefault(): void }) => {
 e.preventDefault();
 const email = emailInput.trim();
 if (!email || !validateEmailStrict(email).valid) return;
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
 source: 'job_bridge',
 sourceChannel: 'job_gate',
 sourcePage: window.location.pathname,
 sourceCta: 'job_bridge_email_unlock',
 sourceComponent: 'JobBridgeView',
 sourceRouteFamily: 'job-board',
 isActive: false,
 status: 'pending',
 });
 localStorage.setItem(JOB_EMAIL_ACCESS_KEY, email.toLowerCase());
 window.location.href = targetPath;
 } catch {
 setEmailError(locale === 'it' ? 'Errore, riprova.' : 'Error, please retry.');
 } finally {
 setEmailBusy(false);
 }
 };

 return (
 <div className="space-y-5 max-w-2xl mx-auto">
 {onBack && (
 <button
 onClick={onBack}
 className="inline-flex items-center gap-1.5 text-sm text-subtle hover:text-heading"
 >
 <ArrowLeft size={14} />
 {locale === 'it' ? 'Torna alla lista' : locale === 'de' ? 'Zurück zur Liste' : locale === 'fr' ? 'Retour à la liste' : 'Back to list'}
 </button>
 )}

 {/* Blue banner */}
 <div className="rounded-xl bg-accent-subtle border border-accent-border px-4 py-3 text-xs text-accent">
 {BANNER_COPY[locale] ?? BANNER_COPY.it}
 </div>

 {/* Countdown + direct link */}
 <div className="flex flex-col items-start gap-2">
 <p className="text-sm text-muted">{redirectCopy}</p>
 <a
 href={targetPath}
 className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline text-sm"
 >
 <ArrowRight size={14} />
 {GO_NOW_COPY[locale] ?? GO_NOW_COPY.it}
 </a>
 </div>

 {/* Job header */}
 {localizedTitle && (
 <div>
 <h1 className="text-xl font-bold font-display text-strong leading-snug">{localizedTitle}</h1>
 <div className="flex flex-wrap gap-3 mt-2 text-sm text-subtle">
 {jobData?.company && (
 <span className="flex items-center gap-1">
 <Building2 size={14} />
 {jobData.company}
 </span>
 )}
 {jobData?.location && (
 <span className="flex items-center gap-1">
 <MapPin size={14} />
 {jobData.location}
 </span>
 )}
 </div>
 </div>
 )}

 {/* Sign-in block — hidden when user is already authenticated */}
 {!alreadySignedIn && (
 <div role="region" aria-label={SIGNUP_COPY[locale] ?? SIGNUP_COPY.it} className="rounded-stripe border border-accent-border bg-accent-subtle p-5 space-y-3">
 <p className="text-sm font-semibold text-strong">
 {SIGNUP_COPY[locale] ?? SIGNUP_COPY.it}
 </p>
 {/* Trust signals */}
 <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-subtle">
 <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-success" />{locale === 'it' ? 'Accesso immediato' : locale === 'de' ? 'Sofortiger Zugang' : locale === 'fr' ? 'Accès immédiat' : 'Instant access'}</span>
 <span className="inline-flex items-center gap-1"><Shield size={12} className="text-success" />{locale === 'it' ? 'Niente spam' : locale === 'de' ? 'Kein Spam' : locale === 'fr' ? 'Pas de spam' : 'No spam'}</span>
 </div>
 <div ref={googleButtonRef} className="flex justify-center" />
 {!googleButtonReady && (
 <a
 href={`/?redirect=${encodeURIComponent(listingPath)}`}
 className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2.5 rounded-stripe border border-edge bg-surface text-sm font-semibold text-strong hover:bg-surface-raised transition-colors"
 >
 {locale === 'it' ? 'Accedi' : locale === 'de' ? 'Anmelden' : locale === 'fr' ? 'Se connecter' : 'Sign in'}
 </a>
 )}
 {linkedInAvailable && (
 <button
 type="button"
 disabled={linkedInBusy}
 onClick={() => {
 setLinkedInBusy(true);
 saveAuthJobContext({ slug: targetSlug, company: jobData?.company, location: jobData?.location });
 signInWithLinkedIn().catch(() => setLinkedInBusy(false));
 }}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-stripe bg-[#0A66C2] hover:bg-[#004182] disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {linkedInBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : (
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 )}
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}
 <div className="flex items-center gap-3">
 <div className="flex-1 h-px bg-surface-raised/50" />
 <span className="text-sm text-muted">{EMAIL_OR_COPY[locale] ?? EMAIL_OR_COPY.it}</span>
 <div className="flex-1 h-px bg-surface-raised/50" />
 </div>
 <form onSubmit={handleEmailSubmit} className="space-y-2">
 <EmailInput
 value={emailInput}
 onChange={setEmailInput}
 placeholder={EMAIL_PLACEHOLDER_COPY[locale] ?? EMAIL_PLACEHOLDER_COPY.it}
 className="w-full px-3 py-2.5 rounded-stripe border border-edge bg-surface text-sm text-heading placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
 />
 <button
 type="submit"
 disabled={emailBusy || !emailInput.trim()}
 className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-stripe bg-accent hover:bg-accent-hover disabled:opacity-60 text-on-accent text-sm font-semibold transition-colors"
 >
 {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
 {EMAIL_CTA_COPY[locale] ?? EMAIL_CTA_COPY.it}
 </button>
 </form>
 {emailError && <p className="text-sm text-danger">{emailError}</p>}
 </div>
 )} {/* AdSense */} <AdSenseUnit slot="5196931137" className="my-2" />

 {/* Company banner */}
 {jobData?.company && (() => {
 const companySlug = `${COMPANY_ROUTE_PREFIX[locale] || 'azienda'}-${slugifyCompanyName(jobData.company)}`;
 const companyHref = `${prefix}/${sectionSlug}/${companySlug}/`.replace(/\/+/g, '/');
 const companyLogo = resolveCompanyLogoUrl({ company: jobData.company });
 return (
 <a
 href={companyHref}
 className="block rounded-xl border border-edge bg-surface-alt/50 p-4 hover:border-accent-border hover:bg-surface-raised/70 transition-colors"
 >
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 rounded-lg bg-surface border border-edge flex items-center justify-center overflow-hidden shrink-0">
 {companyLogo ? (
 <img src={companyLogo} alt={`Logo ${jobData.company}`} className="w-7 h-7 object-contain" width={28} height={28} loading="lazy" onError={(e) => { const el = e.currentTarget; if (el.src.includes('logo.clearbit.com')) { el.src = `https://www.google.com/s2/favicons?domain=${el.src.replace('https://logo.clearbit.com/', '')}&sz=128`; } else { el.style.visibility = 'hidden'; } }} />
 ) : (
 <Building2 className="w-4 h-4 text-muted" />
 )}
 </div>
 <div className="min-w-0">
 <h3 className="text-sm font-bold text-heading">{locale === 'it' ? 'Azienda' : locale === 'de' ? 'Unternehmen' : locale === 'fr' ? 'Entreprise' : 'Company'}</h3>
 <p className="text-sm text-subtle mt-1">{jobData.company}{jobData.location ? ` · ${jobData.location}` : ''}</p>
 <p className="text-sm text-muted mt-2">
 {locale === 'it' ? 'Frontaliere Ticino ha scovato questa opportunità nel monitoraggio aziende.' : locale === 'de' ? 'Frontaliere Ticino hat diese Möglichkeit im Unternehmensmonitoring entdeckt.' : locale === 'fr' ? 'Frontaliere Ticino a repéré cette opportunité dans le suivi des entreprises.' : 'Frontaliere Ticino discovered this opportunity through company monitoring.'}
 </p>
 </div>
 </div>
 </a>
 );
 })()}

 {/* Related active jobs — listing-style cards */}
 {relatedJobs.length > 0 && (
 <div className="space-y-2">
 <h2 className="text-base font-semibold text-strong">{RELATED_COPY[locale] ?? RELATED_COPY.it}</h2>
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
 <a href={rjPath} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg">
 <div className="flex items-start gap-3">
 <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-lg bg-surface-raised flex items-center justify-center overflow-hidden border border-edge shrink-0">
 {rjLogo ? (
 <img src={rjLogo} alt={`Logo ${rj.company}`} className="w-7 h-7 sm:w-10 sm:h-10 object-contain" width={40} height={40} loading="lazy" onError={(e) => { const el = e.currentTarget; if (el.src.includes('logo.clearbit.com')) { el.src = `https://www.google.com/s2/favicons?domain=${el.src.replace('https://logo.clearbit.com/', '')}&sz=128`; } else { el.style.visibility = 'hidden'; } }} />
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
 )}

 {/* CTA */}
 <a
 href={listingPath}
 className="inline-flex items-center gap-1.5 font-semibold text-accent hover:underline text-sm"
 >
 <ArrowRight size={14} />
 {CTA_COPY[locale] ?? CTA_COPY.it}
 </a>
 </div>
 );
}
