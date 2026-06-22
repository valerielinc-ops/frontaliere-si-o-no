/**
 * EmployerInsightsPage — the cold-outreach conversion centrepiece.
 *
 * A private, per-company "wow" traffic report: we give companies free job-board
 * traffic on frontaliereticino.ch, and this page PROVES it with their real
 * numbers, then pushes them to claim a paid plan. It is reached from an outreach
 * link of the form `/azienda/<companyKey>/?t=<token>` (private, noindex).
 *
 * This file exports TWO things:
 *  1. `EmployerInsightsReport` — the pure presentational component. It takes the
 *     already-fetched `data: EmployerInsights` and renders the whole report.
 *     Use this directly if you fetch in a parent (the prompt's wrapper).
 *  2. `EmployerInsightsPage` (default) — the route-level wrapper. It reads the
 *     companyKey from the path and the `t` token from the query, calls
 *     `fetchInsights`, and renders loading / error / empty / report states.
 *
 * Styling: semantic Tailwind tokens only (no inline hex, no raw `dark:` color
 * classes), mobile-first, one <h1>. Animations honour prefers-reduced-motion
 * (count-up + reveal both no-op under reduced motion; CSS transitions are
 * globally neutralised by the media query in index.css). No new npm deps:
 * count-up via the shared `useCountUp` hook, charts hand-rolled in SVG/CSS.
 *
 * SEO: per-company data is PRIVATE → the page forces `<meta name="robots"
 * content="noindex, nofollow">` (overriding the global indexable meta) for its
 * lifetime and restores the previous value on unmount. Title is set to
 * "{companyName} — i tuoi dati su Frontaliere Ticino".
 */
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Eye,
  Users,
  Briefcase,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Sparkles,
  Target,
  Loader2,
  Home,
} from 'lucide-react';
import { useCountUp } from '@/hooks/useCountUp';
import {
  fetchInsights,
  type EmployerInsights,
  type FetchInsightsResult,
} from '@/services/employerInsights';
import { useReveal } from '@/components/insights/useReveal';
import { TopAdsChart } from '@/components/insights/TopAdsChart';
import { TrendSparkline } from '@/components/insights/TrendSparkline';

// Claim/publish flow target — trailing slash per site convention.
const CLAIM_HREF = '/pubblica-offerta/?claim=1&tier=azienda';

const nf = new Intl.NumberFormat('it-IT');

/* ────────────────────────────────────────────────────────────────────────── */
/* Small building blocks                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/** Animated count-up number that only starts once it scrolls into view. */
function CountStat({
  value,
  decimals = 0,
  suffix = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
}): React.ReactElement {
  const { ref, inView } = useReveal<HTMLSpanElement>();
  const display = useCountUp(value, { active: inView, decimals, durationMs: 1600 });
  const text =
    decimals > 0 ? display.toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : nf.format(Math.round(display));
  return (
    <span ref={ref} className="tabular-nums">
      {text}
      {suffix}
    </span>
  );
}

/** A hero KPI tile: big animated number + icon + label. */
function HeroStat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center text-center rounded-2xl border border-edge bg-surface-raised px-4 py-5">
      <span className="text-accent mb-2" aria-hidden="true">
        {icon}
      </span>
      <span className="text-3xl sm:text-4xl font-bold font-display text-strong">
        <CountStat value={value} />
      </span>
      <span className="text-xs sm:text-sm text-subtle mt-1">{label}</span>
    </div>
  );
}

/** Generic scroll-reveal section wrapper (fade + slide up). */
function RevealSection({
  children,
  className = '',
  ariaLabelledby,
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabelledby?: string;
}): React.ReactElement {
  const { ref, inView } = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      aria-labelledby={ariaLabelledby}
      className={`transition-all duration-700 ease-out ${inView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'} ${className}`}
    >
      {children}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The report (presentational — takes already-fetched data)                     */
/* ────────────────────────────────────────────────────────────────────────── */

export function EmployerInsightsReport({ data }: { data: EmployerInsights }): React.ReactElement {
  const { totals, trend, ads, periodDays } = data;

  const conversionPct = totals.conversionRate * 100;
  const trendUp =
    trend.length >= 2 ? trend[trend.length - 1].views >= trend[0].views : true;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 sm:py-10 space-y-12 sm:space-y-16">
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <header className="text-center animate-fade-in-up">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-link bg-accent-subtle border border-accent-border mb-4">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          Report gratuito · Frontaliere Ticino
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold font-display text-heading leading-tight text-balance">
          {data.companyName} è già visibile sui frontalieri
        </h1>
        <p className="mt-3 text-base sm:text-lg text-subtle max-w-xl mx-auto text-pretty">
          Negli ultimi {periodDays} giorni, <strong className="text-body">gratis</strong>, da
          frontaliereticino.ch
        </p>

        <div className="mt-8 grid grid-cols-3 gap-3 sm:gap-4">
          <HeroStat
            icon={<Users className="w-5 h-5" />}
            value={totals.candidates}
            label="candidati inviati"
          />
          <HeroStat
            icon={<Eye className="w-5 h-5" />}
            value={totals.views}
            label="visualizzazioni"
          />
          <HeroStat
            icon={<Briefcase className="w-5 h-5" />}
            value={totals.adsCount}
            label="annunci pubblicati"
          />
        </div>
      </header>

      {/* ── Loss-aversion hammer ────────────────────────────────────────── */}
      <RevealSection
        ariaLabelledby="insights-loss-heading"
        className="rounded-3xl border border-danger-border bg-danger-subtle px-5 py-8 sm:px-8 sm:py-10 text-center"
      >
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-surface text-danger-strong mb-4 mx-auto"
          aria-hidden="true"
        >
          <AlertTriangle className="w-6 h-6" />
        </span>
        <p
          id="insights-loss-heading"
          className="text-sm sm:text-base font-semibold uppercase tracking-wide text-danger-strong"
        >
          Persone interessate che NON sono diventate candidature
        </p>
        <p className="mt-3 text-6xl sm:text-7xl font-bold font-display text-danger-strong leading-none">
          <CountStat value={totals.lost} />
        </p>
        <p className="mt-4 text-base text-body max-w-md mx-auto text-pretty">
          Hanno visto i tuoi annunci ma se ne sono andati senza candidarsi. Sono{' '}
          <strong>candidati lasciati sul tavolo</strong> — possiamo recuperarli.
        </p>
      </RevealSection>

      {/* ── Top ads bar chart ───────────────────────────────────────────── */}
      {ads.length > 0 && (
        <RevealSection ariaLabelledby="insights-topads-heading">
          <h2
            id="insights-topads-heading"
            className="text-xl sm:text-2xl font-bold font-display text-strong mb-1"
          >
            Gli annunci che lavorano per te
          </h2>
          <p className="text-sm text-subtle mb-5">
            I più visti{data.topAd ? `, guidati da «${data.topAd.title}»` : ''}.
          </p>
          <TopAdsChart ads={ads} limit={10} />
        </RevealSection>
      )}

      {/* ── Trend sparkline ─────────────────────────────────────────────── */}
      {trend.length >= 2 && (
        <RevealSection
          ariaLabelledby="insights-trend-heading"
          className="rounded-3xl border border-edge bg-surface-raised px-5 py-6 sm:px-7 sm:py-7"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={trendUp ? 'text-success' : 'text-warning-strong'} aria-hidden="true">
              {trendUp ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            </span>
            <h2
              id="insights-trend-heading"
              className="text-xl sm:text-2xl font-bold font-display text-strong"
            >
              Visualizzazioni settimana per settimana
            </h2>
          </div>
          <p className="text-sm text-subtle mb-4">
            {trendUp
              ? 'Il tuo interesse è in crescita — è il momento di trasformarlo.'
              : 'C’è un pubblico attivo da riattivare con annunci in evidenza.'}
          </p>
          <TrendSparkline trend={trend} />
        </RevealSection>
      )}

      {/* ── Conversion-rate stat ────────────────────────────────────────── */}
      <RevealSection
        ariaLabelledby="insights-conv-heading"
        className="rounded-3xl border border-accent-border bg-accent-subtle px-5 py-8 sm:px-8 sm:py-10"
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-5">
          <div className="flex items-center gap-4">
            <span
              className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-surface text-accent shrink-0"
              aria-hidden="true"
            >
              <Target className="w-6 h-6" />
            </span>
            <span className="text-5xl sm:text-6xl font-bold font-display text-strong leading-none">
              <CountStat value={conversionPct} decimals={conversionPct < 10 ? 1 : 0} suffix="%" />
            </span>
          </div>
          <div>
            <h2
              id="insights-conv-heading"
              className="text-lg sm:text-xl font-bold font-display text-strong"
            >
              diventa candidatura oggi
            </h2>
            <p className="mt-1 text-sm sm:text-base text-body text-pretty">
              Con annunci in evidenza, newsletter mirata e candidatura diretta possiamo{' '}
              <strong>alzarlo</strong>. Ogni punto in più sono candidati reali nella tua casella.
            </p>
          </div>
        </div>
      </RevealSection>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <RevealSection
        ariaLabelledby="insights-cta-heading"
        className="rounded-3xl bg-surface-inverted px-6 py-10 sm:px-10 sm:py-12 text-center"
      >
        <h2
          id="insights-cta-heading"
          className="text-2xl sm:text-3xl font-bold font-display text-on-accent text-balance"
        >
          Trasforma questi {nf.format(totals.views)} click in candidature dirette
        </h2>
        <p className="mt-3 text-sm sm:text-base text-on-accent/80 max-w-md mx-auto text-pretty">
          Rivendica il profilo di {data.companyName}, metti gli annunci in evidenza e ricevi le
          candidature direttamente. Setup in pochi minuti.
        </p>
        <a
          href={CLAIM_HREF}
          className="mt-7 inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl shadow-sm transition-colors no-underline"
        >
          Rivendica i tuoi annunci
          <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </a>
      </RevealSection>

      <p className="text-center text-xs text-muted">
        Dati relativi a {data.companyName} generati il{' '}
        {new Date(data.generatedAt).toLocaleDateString('it-IT')} · pagina privata, non indicizzata.
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* States: loading / error / empty                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function CenteredMessage({
  title,
  body,
  showHome = true,
}: {
  title: string;
  body: string;
  showHome?: boolean;
}): React.ReactElement {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <h1 className="text-2xl font-bold font-display text-strong mb-3">{title}</h1>
      <p className="text-base text-subtle text-pretty">{body}</p>
      {showHome && (
        <a
          href="/"
          className="mt-6 inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors no-underline"
        >
          <Home className="w-4 h-4" aria-hidden="true" />
          Vai alla home
        </a>
      )}
    </div>
  );
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Caricamento del report in corso…</span>
      <div className="flex justify-center mb-8" aria-hidden="true">
        <Loader2 className="w-7 h-7 text-accent animate-spin" />
      </div>
      <div className="space-y-6" aria-hidden="true">
        <div className="h-10 rounded-xl bg-surface-alt animate-pulse mx-auto w-3/4" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
        </div>
        <div className="h-40 rounded-3xl bg-surface-alt animate-pulse" />
        <div className="h-32 rounded-3xl bg-surface-alt animate-pulse" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Route wrapper — reads companyKey from path + token from query, fetches       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Pull `companyKey` from the path (`/azienda/<companyKey>/`) if not provided. */
function companyKeyFromPath(): string {
  if (typeof window === 'undefined') return '';
  const segs = window.location.pathname.split('/').filter(Boolean);
  const idx = segs.indexOf('azienda');
  return idx >= 0 && segs[idx + 1] ? decodeURIComponent(segs[idx + 1]) : '';
}

function tokenFromQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('t') ?? '';
}

/**
 * Set document.title and force noindex robots meta for the lifetime of the
 * report page; restore on unmount. Centralised so every state (and the wrapper)
 * keeps the page out of the index.
 */
function usePrivatePageHead(title: string): void {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;

    const meta = document.querySelector('meta[name="robots"]');
    const prevRobots = meta?.getAttribute('content') ?? null;
    let created = false;
    let el = meta as HTMLMetaElement | null;
    if (el) {
      el.setAttribute('content', 'noindex, nofollow');
    } else {
      el = document.createElement('meta');
      el.setAttribute('name', 'robots');
      el.setAttribute('content', 'noindex, nofollow');
      document.head.appendChild(el);
      created = true;
    }

    return () => {
      document.title = prevTitle;
      if (created && el) {
        el.remove();
      } else if (el && prevRobots != null) {
        el.setAttribute('content', prevRobots);
      }
    };
  }, [title]);
}

export interface EmployerInsightsPageProps {
  /** Override companyKey (else read from path). */
  companyKey?: string;
  /** Override token (else read from query `t`). */
  token?: string;
}

export function EmployerInsightsPage({
  companyKey: companyKeyProp,
  token: tokenProp,
}: EmployerInsightsPageProps = {}): React.ReactElement {
  const companyKey = companyKeyProp ?? companyKeyFromPath();
  const token = tokenProp ?? tokenFromQuery();

  const [result, setResult] = useState<FetchInsightsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchInsights(companyKey, token)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult({ status: 'error', reason: 'network' });
      });
    return () => {
      cancelled = true;
    };
  }, [companyKey, token]);

  const companyName =
    result?.status === 'ok' ? result.data.companyName : 'La tua azienda';
  usePrivatePageHead(`${companyName} — i tuoi dati su Frontaliere Ticino`);

  if (result === null) return <LoadingSkeleton />;

  if (result.status === 'error') {
    return (
      <CenteredMessage
        title="Link non valido o scaduto"
        body="Questo report è privato e raggiungibile solo dal link che ti abbiamo inviato. Il link potrebbe essere scaduto: scrivici e te ne mandiamo uno nuovo."
      />
    );
  }

  if (result.status === 'not-found') {
    return (
      <CenteredMessage
        title="Report in preparazione"
        body="Stiamo ancora raccogliendo i dati di traffico per la tua azienda. Riprova tra poco — nel frattempo puoi già pubblicare e mettere in evidenza i tuoi annunci."
      />
    );
  }

  return <EmployerInsightsReport data={result.data} />;
}

export default EmployerInsightsPage;
