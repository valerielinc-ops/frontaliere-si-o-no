/**
 * JobOrphanView — view for slugs with no metadata in expired-jobs.json.
 *
 * Shown for GSC orphan slugs, legacy URLs, or true 404s that have a static
 * HTML page (from orphan soft-landing generation) but no job data available.
 *
 * Layout: header card with derived title → grey banner → static content in
 * styled card sections → sign-in block → AdSense → CTA button
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Briefcase, Building2, Loader2, Mail, MapPin, Search } from 'lucide-react';
import { useLocale } from '@/services/i18n';
import { renderGoogleButton, isLinkedInSignInAvailable, signInWithLinkedIn, saveAuthJobContext } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import { upsertNewsletterSubscriber } from '@/services/newsletterSubscribers';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import AdSenseUnit from '@/components/shared/AdSenseUnit';

interface JobOrphanViewProps {
  slug: string;
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
  it: 'Iscriviti agli alert',
  en: 'Subscribe to alerts',
  de: 'Benachrichtigungen abonnieren',
  fr: 'S\'abonner aux alertes',
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

/** Extract links from the "Posizioni attive recenti" section of static HTML. */
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

export default function JobOrphanView({ slug, onBack, hasAccess: hasAccessProp }: JobOrphanViewProps) {
  const [locale] = useLocale();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [googleButtonReady, setGoogleButtonReady] = useState(false);
  const [linkedInAvailable, setLinkedInAvailable] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Hide login block if user is already authenticated (prop) or has email access (localStorage)
  const alreadySignedIn = hasAccessProp || !!localStorage.getItem(JOB_EMAIL_ACCESS_KEY);

  const [staticBodyHtml] = useState(() => getStaticBodyHtml());

  const prefix = PREFIX_BY_LOCALE[locale] ?? '';
  const sectionSlug = SECTION_BY_LOCALE[locale] ?? SECTION_BY_LOCALE.it;
  const listingPath = `${prefix}/${sectionSlug}/`.replace(/\/+/g, '/');

  const slugParts = useMemo(() => parseSlug(slug), [slug]);
  const activeJobLinks = useMemo(
    () => staticBodyHtml ? extractActiveJobLinks(staticBodyHtml) : [],
    [staticBodyHtml],
  );

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

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {onBack && (
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} />
          {locale === 'it' ? 'Torna alla lista' : locale === 'de' ? 'Zurück zur Liste' : locale === 'fr' ? 'Retour à la liste' : 'Back to list'}
        </button>
      )}

      {/* Job header card */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/80 overflow-hidden">
        {/* Amber status bar */}
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 px-5 py-2.5 flex items-center gap-2">
          <Briefcase size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-sm text-amber-800 dark:text-amber-300">
            {BANNER_COPY[locale] ?? BANNER_COPY.it}
          </span>
        </div>
        {/* Title + metadata */}
        <div className="px-5 py-4">
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 leading-snug">
            {slugParts.title}
          </h1>
          {(slugParts.company || slugParts.location) && (
            <div className="flex flex-wrap gap-3 mt-2.5 text-sm text-slate-600 dark:text-slate-400">
              {slugParts.company && (
                <span className="flex items-center gap-1.5">
                  <Building2 size={14} className="text-slate-500 dark:text-slate-400" />
                  {slugParts.company}
                </span>
              )}
              {slugParts.location && (
                <span className="flex items-center gap-1.5">
                  <MapPin size={14} className="text-slate-500 dark:text-slate-400" />
                  {slugParts.location}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Active jobs cards (extracted from static HTML) */}
      {activeJobLinks.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {locale === 'it' ? 'Posizioni attive simili' : locale === 'de' ? 'Ähnliche offene Stellen' : locale === 'fr' ? 'Postes similaires ouverts' : 'Similar active jobs'}
          </h2>
          <ul className="space-y-2">
            {activeJobLinks.slice(0, 5).map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 hover:border-indigo-300 dark:hover:border-indigo-600 hover:shadow-sm transition-[color,background-color,border-color,box-shadow]"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-sm text-slate-800 dark:text-slate-100 truncate">{link.title}</span>
                    {link.company && (
                      <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{link.company}</span>
                    )}
                  </span>
                  <ArrowRight size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sign-in / alert block — hidden when user is already authenticated */}
      {!alreadySignedIn && (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-gradient-to-b from-slate-50 to-white dark:from-slate-900/60 dark:to-slate-900/40 p-5 text-center space-y-3">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {SIGNUP_COPY[locale] ?? SIGNUP_COPY.it}
        </p>
        <div ref={googleButtonRef} className="flex justify-center" />
        {!googleButtonReady && (
          <a
            href={`/?redirect=${encodeURIComponent(window.location.pathname)}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            {locale === 'it' ? 'Accedi' : locale === 'de' ? 'Anmelden' : locale === 'fr' ? 'Se connecter' : 'Sign in'}
          </a>
        )}

        {linkedInAvailable && (
          <button
            type="button"
            onClick={() => { saveAuthJobContext({ slug, company: slugParts.company, location: slugParts.location }); signInWithLinkedIn(); }}
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#0A66C2] hover:bg-[#004182] text-white text-sm font-semibold transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
          </button>
        )}

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
          <span className="text-xs text-slate-500 dark:text-slate-400">{EMAIL_OR_COPY[locale] ?? EMAIL_OR_COPY.it}</span>
          <div className="flex-1 h-px bg-slate-300/50 dark:bg-slate-600/50" />
        </div>
        <form onSubmit={handleEmailSubmit} className="space-y-2">
          <EmailInput
            value={emailInput}
            onChange={setEmailInput}
            placeholder={EMAIL_PLACEHOLDER_COPY[locale] ?? EMAIL_PLACEHOLDER_COPY.it}
            className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={emailBusy || !emailInput.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
          >
            {emailBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            {EMAIL_CTA_COPY[locale] ?? EMAIL_CTA_COPY.it}
          </button>
        </form>
        {emailError && <p className="text-xs text-red-600 dark:text-red-300">{emailError}</p>}
      </div>
      )}

      {/* AdSense */}
      <AdSenseUnit slot="5196931137" className="my-2" />

      {/* Informational content from static HTML (SEO-friendly, collapsed) */}
      {staticBodyHtml && (
        <details className="group rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/80 overflow-hidden">
          <summary className="px-5 py-3.5 text-sm font-semibold text-slate-700 dark:text-slate-300 cursor-pointer select-none hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors list-none flex items-center gap-2">
            <Search size={14} className="text-slate-500 dark:text-slate-400" />
            {locale === 'it' ? 'Informazioni per frontalieri' : locale === 'de' ? 'Informationen für Grenzgänger' : locale === 'fr' ? 'Informations pour frontaliers' : 'Information for cross-border workers'}
            <ArrowRight size={12} className="ml-auto text-slate-500 dark:text-slate-400 transition-transform group-open:rotate-90" />
          </summary>
          <div
            className="px-5 pb-4 prose prose-sm dark:prose-invert max-w-none text-slate-600 dark:text-slate-400 [&_h1]:hidden [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-slate-700 [&_h2]:dark:text-slate-300 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_section]:border-t [&_section]:border-slate-100 [&_section]:dark:border-slate-800 [&_section]:pt-3 [&_section:first-of-type]:border-0 [&_a]:text-indigo-600 [&_a]:dark:text-indigo-400 [&_ul]:pl-0 [&_ul]:list-none [&_li]:pl-0"
            dangerouslySetInnerHTML={{ __html: staticBodyHtml }}
          />
        </details>
      )}

      {/* CTA button */}
      <a
        href={listingPath}
        className="flex items-center justify-center gap-2 w-full py-3 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold transition-colors"
      >
        <Search size={16} />
        {CTA_COPY[locale] ?? CTA_COPY.it}
      </a>
    </div>
  );
}
