/**
 * EmployerInsightsPage — the cold-outreach insights centrepiece.
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
 * (reveal transitions are globally neutralised by the media query in
 * index.css). No new npm deps; charts are hand-rolled in SVG/CSS.
 *
 * SEO: per-company data is PRIVATE → the page forces `<meta name="robots"
 * content="noindex, nofollow">` (overriding the global indexable meta) for its
 * lifetime and restores the previous value on unmount. Title is set to
 * "{companyName} — i tuoi dati su Frontaliere Ticino".
 */
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Eye,
  FileText,
  Home,
  Loader2,
  MousePointerClick,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  fetchInsights,
  type EmployerInsights,
  type EmployerInsightsWindow,
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

type MetricValue = number | null | undefined;
type MetricState = 'observed' | 'zero-observed' | 'data-missing' | 'source-unavailable';

function windowLabel(window: EmployerInsightsWindow | null | undefined): string {
  if (!window?.from || !window.to) return 'finestra non disponibile';
  const timezone = window.timezone?.trim() || 'timezone non disponibile';
  const inclusive = window.inclusive ? ` · ${window.inclusive}` : '';
  return `${window.from} → ${window.to} · ${timezone}${inclusive}`;
}

function metricState(
  value: MetricValue,
  source: string | null | undefined,
  window: EmployerInsightsWindow | null | undefined,
): { display: string; state: MetricState; source: string } {
  const hasSource = typeof source === 'string' && source.trim().length > 0;
  const sourceLabel = hasSource ? source.trim() : 'sorgente non disponibile';
  if (!hasSource) {
    return { display: 'non disponibile', state: 'source-unavailable', source: sourceLabel };
  }
  if (!window?.from || !window.to || typeof value !== 'number' || !Number.isFinite(value)) {
    return { display: 'non disponibile', state: 'data-missing', source: sourceLabel };
  }
  if (value === 0) return { display: '0', state: 'zero-observed', source: sourceLabel };
  return { display: nf.format(value), state: 'observed', source: sourceLabel };
}

function metricStateLabel(state: MetricState): string {
  if (state === 'zero-observed') return 'zero osservato';
  if (state === 'data-missing') return 'dato assente';
  if (state === 'source-unavailable') return 'sorgente non disponibile';
  return 'dato osservato';
}

function MetricCard({
  icon,
  label,
  description,
  value,
  source,
  window,
  compact = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: MetricValue;
  source: string | null | undefined;
  window: EmployerInsightsWindow | null | undefined;
  compact?: boolean;
}): React.ReactElement {
  const metric = metricState(value, source, window);
  const displayWindow = windowLabel(window);
  return (
    <div
      className={`rounded-2xl border border-edge bg-surface-raised ${compact ? 'p-4' : 'px-4 py-5'}`}
      aria-label={`${label}: ${metric.display}`}
    >
      <span className="text-accent mb-2 inline-flex" aria-hidden="true">
        {icon}
      </span>
      <p className={`${compact ? 'text-2xl' : 'text-3xl sm:text-4xl'} font-bold font-display text-strong tabular-nums`}>
        {metric.display}
      </p>
      <p className="text-xs sm:text-sm text-subtle mt-1">{label}</p>
      <p className="text-xs text-muted mt-2">{metricStateLabel(metric.state)}</p>
      <dl className="mt-3 space-y-1 text-[0.7rem] leading-snug text-muted">
        <div>
          <dt className="inline font-semibold">Finestra: </dt>
          <dd className="inline">{displayWindow}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Sorgente: </dt>
          <dd className="inline">{metric.source}</dd>
        </div>
      </dl>
      <p className="text-xs text-body mt-3">{description}</p>
    </div>
  );
}

function additionalWindowLabel(key: string): string {
  return key.endsWith('d') ? `${key.slice(0, -1)} giorni` : key;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The report (presentational — takes already-fetched data)                     */
/* ────────────────────────────────────────────────────────────────────────── */

export function EmployerInsightsReport({ data }: { data: EmployerInsights }): React.ReactElement {
  const { totals, trend, ads } = data;
  const eventSource = data.source;
  const applicationSource = data.applicationsCoverage?.source;
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
          Dati di interazione per {data.companyName}
        </h1>
        <p className="mt-3 text-base sm:text-lg text-subtle max-w-xl mx-auto text-pretty">
          Il periodo principale documentabile è cumulativo. Le viste aggiuntive non sostituiscono
          questa finestra.
        </p>
        <p className="mt-2 text-xs text-muted">Finestra principale: {windowLabel(data.window)}</p>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <MetricCard
            icon={<MousePointerClick className="w-5 h-5" />}
            value={totals.applyClicks}
            label="Click per candidarsi"
            description="Segnale di intento; non è un invio di candidatura."
            source={eventSource}
            window={data.window}
          />
          <MetricCard
            icon={<FileText className="w-5 h-5" />}
            value={totals.applications}
            label="Candidature inviate"
            description="Invii registrati dalla sorgente delle candidature; non si sommano ai click."
            source={applicationSource}
            window={data.window}
          />
          <MetricCard
            icon={<Building2 className="w-5 h-5" />}
            value={totals.profileViews}
            label="Visualizzazioni profilo azienda"
            description="Visite al profilo azienda, separate dalle visualizzazioni annuncio."
            source={eventSource}
            window={data.window}
          />
          <MetricCard
            icon={<Eye className="w-5 h-5" />}
            value={totals.views}
            label="Visualizzazioni annuncio"
            description="Eventi di visualizzazione dell'annuncio."
            source={eventSource}
            window={data.window}
          />
        </div>
      </header>

      {/* ── Top ads bar chart ───────────────────────────────────────────── */}
      {ads.length > 0 && (
        <RevealSection ariaLabelledby="insights-topads-heading">
          <h2
            id="insights-topads-heading"
            className="text-xl sm:text-2xl font-bold font-display text-strong mb-1"
          >
            Annunci con più visualizzazioni registrate
          </h2>
          <p className="text-sm text-subtle mb-5">
            I primi 10 annunci per visualizzazioni{data.topAd ? `, con «${data.topAd.title}» in testa` : ''}.
          </p>
          <p className="text-xs text-muted mb-4">
            Finestra: {windowLabel(data.window)} · Sorgente: {typeof eventSource === 'string' && eventSource.trim() ? eventSource : 'sorgente non disponibile'}
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
              Andamento delle visualizzazioni registrate
            </h2>
          </div>
          <p className="text-sm text-subtle mb-2">
            {trendUp ? 'Le visualizzazioni registrate sono in crescita.' : 'Le visualizzazioni registrate sono in calo.'}
          </p>
          <p className="text-xs text-muted mb-4">
            Finestra: {windowLabel(data.window)} · Sorgente: {typeof eventSource === 'string' && eventSource.trim() ? eventSource : 'sorgente non disponibile'}
          </p>
          <TrendSparkline trend={trend} />
        </RevealSection>
      )}

      {data.additionalWindows && Object.entries(data.additionalWindows).length > 0 && (
        <RevealSection ariaLabelledby="insights-additional-heading">
          <h2 id="insights-additional-heading" className="text-xl sm:text-2xl font-bold font-display text-strong mb-1">
            Viste aggiuntive
          </h2>
          <p className="text-sm text-subtle mb-5">
            Le finestre da 30 e 90 giorni sono confronti aggiuntivi e non sostituiscono il periodo principale.
          </p>
          <div className="space-y-6">
            {Object.entries(data.additionalWindows).map(([key, summary]) => (
              <div key={key}>
                <h3 className="text-base font-semibold text-strong mb-3">{additionalWindowLabel(key)}</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <MetricCard
                    compact
                    icon={<MousePointerClick className="w-4 h-4" />}
                    value={summary.totals.applyClicks}
                    label="Click per candidarsi"
                    description="Intento"
                    source={eventSource}
                    window={summary.window}
                  />
                  <MetricCard
                    compact
                    icon={<FileText className="w-4 h-4" />}
                    value={summary.totals.applications}
                    label="Candidature inviate"
                    description="Invii"
                    source={applicationSource}
                    window={summary.window}
                  />
                  <MetricCard
                    compact
                    icon={<Building2 className="w-4 h-4" />}
                    value={summary.totals.profileViews}
                    label="Visualizzazioni profilo azienda"
                    description="Profilo"
                    source={eventSource}
                    window={summary.window}
                  />
                  <MetricCard
                    compact
                    icon={<Eye className="w-4 h-4" />}
                    value={summary.totals.views}
                    label="Visualizzazioni annuncio"
                    description="Annuncio"
                    source={eventSource}
                    window={summary.window}
                  />
                </div>
              </div>
            ))}
          </div>
        </RevealSection>
      )}

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <RevealSection
        ariaLabelledby="insights-cta-heading"
        className="rounded-3xl bg-surface-inverted px-6 py-10 sm:px-10 sm:py-12 text-center"
      >
        <h2
          id="insights-cta-heading"
          className="text-2xl sm:text-3xl font-bold font-display text-on-accent text-balance"
        >
          Dai seguito ai segnali registrati
        </h2>
        <p className="mt-3 text-sm sm:text-base text-on-accent/80 max-w-md mx-auto text-pretty">
          Rivendica il profilo di {data.companyName}, metti gli annunci in evidenza e porta il
          pubblico verso il tuo processo di candidatura con una misura più chiara. Setup in pochi minuti.
        </p>
        <a
          href={CLAIM_HREF}
          className="mt-7 inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl shadow-sm transition-colors no-underline"
        >
          Rivendica i tuoi annunci
          <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </a>
      </RevealSection>

      {/* Save-as-PDF: lets the company keep its own copy without us emailing an
          attachment (attachments hurt cold-email deliverability). Browser
          print-to-PDF; hidden in the printed output itself. */}
      <div className="text-center print:hidden">
        <button
          type="button"
          onClick={() => { if (typeof window !== 'undefined') window.print(); }}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-body bg-surface-alt hover:bg-surface-muted border border-edge rounded-xl transition-colors"
        >
          Salva questi dati in PDF
        </button>
      </div>

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
