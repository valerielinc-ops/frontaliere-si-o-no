import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Gauge, TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { useTranslation, useLocale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import ChartWrapper from '@/components/shared/ChartWrapper';
import { CHART_DATA_COLORS } from '@/hooks/useChartColors';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { fmtMinutes, fmtSignedMinutesDelta } from '@/services/borderWaitFormat';
import {
  fetchBorderWaitRanking,
  type BorderWaitRankingSnapshot,
  type BorderWaitRankingRow,
  type BorderWaitRankingMover,
} from '@/services/borderWaitRankingService';
import {
  BORDER_CROSSING_DISPLAY,
  buildOggiPath,
  buildRootHubPath,
  type BorderCrossingSlug,
} from '@/build-plugins/borderWaitData';

const MAX_SIDE = 5;

interface LocalizedLabels {
  heading: string;
  subtitle: string;
  weekOf: string;
  updated: string;
  statDelta: string;
  statHours: string;
  statDays: string;
  chartWait: string;
  legendFastest: string;
  legendSlowest: string;
  bestH: string;
  worstH: string;
  loading: string;
  errorTitle: string;
  errorBody: string;
  link: string;
  trendBetter: string;
  trendWorse: string;
  trendFlat: string;
  moversH: string;
  moverImproved: string;
  moverWorsened: string;
}

const LABELS: Record<'it' | 'en' | 'de' | 'fr', LocalizedLabels> = {
  it: {
    heading: 'Classifica live delle dogane — tempi di attesa',
    subtitle:
      'Le 5 dogane più veloci e le 5 più lente del Ticino, calcolate sulla media mobile degli ultimi 7 giorni.',
    weekOf: 'Settimana',
    updated: 'Aggiornato',
    statDelta: 'Differenza per passaggio',
    statHours: 'Ore perse all’anno',
    statDays: 'Giornate lavorative perse',
    chartWait: 'Attesa media',
    legendFastest: 'Più veloce',
    legendSlowest: 'Più lenta',
    bestH: 'Più veloci',
    worstH: 'Più lente',
    loading: 'Caricamento classifica live…',
    errorTitle: 'Classifica non disponibile',
    errorBody: 'Riprova tra qualche minuto — la classifica si aggiorna ogni settimana.',
    link: 'Vedi il traffico live di ogni dogana',
    trendBetter: 'in miglioramento',
    trendWorse: 'in peggioramento',
    trendFlat: 'stabile',
    moversH: 'Cosa è cambiato questa settimana',
    moverImproved: 'Migliorata di più',
    moverWorsened: 'Peggiorata di più',
  },
  en: {
    heading: 'Live border crossing ranking — wait times',
    subtitle:
      'The 5 fastest and 5 slowest Ticino border crossings, based on a rolling 7-day average.',
    weekOf: 'Week',
    updated: 'Updated',
    statDelta: 'Difference per crossing',
    statHours: 'Hours lost per year',
    statDays: 'Working days lost',
    chartWait: 'Avg. wait',
    legendFastest: 'Fastest',
    legendSlowest: 'Slowest',
    bestH: 'Fastest',
    worstH: 'Slowest',
    loading: 'Loading live ranking…',
    errorTitle: 'Ranking unavailable',
    errorBody: 'Try again in a few minutes — the ranking refreshes weekly.',
    link: 'See live traffic at every crossing',
    trendBetter: 'improving',
    trendWorse: 'worsening',
    trendFlat: 'stable',
    moversH: 'What changed this week',
    moverImproved: 'Biggest improvement',
    moverWorsened: 'Biggest worsening',
  },
  de: {
    heading: 'Live-Rangliste der Grenzübergänge — Wartezeiten',
    subtitle:
      'Die 5 schnellsten und 5 langsamsten Grenzübergänge im Tessin, auf Basis eines gleitenden 7-Tage-Durchschnitts.',
    weekOf: 'Woche',
    updated: 'Aktualisiert',
    statDelta: 'Unterschied pro Übertritt',
    statHours: 'Verlorene Stunden pro Jahr',
    statDays: 'Verlorene Arbeitstage',
    chartWait: 'Ø Wartezeit',
    legendFastest: 'Am schnellsten',
    legendSlowest: 'Am langsamsten',
    bestH: 'Am schnellsten',
    worstH: 'Am langsamsten',
    loading: 'Live-Rangliste wird geladen…',
    errorTitle: 'Rangliste nicht verfügbar',
    errorBody: 'Versuche es in ein paar Minuten erneut — die Rangliste wird wöchentlich aktualisiert.',
    link: 'Live-Verkehr an jedem Übergang ansehen',
    trendBetter: 'verbessert sich',
    trendWorse: 'verschlechtert sich',
    trendFlat: 'stabil',
    moversH: 'Was sich diese Woche geändert hat',
    moverImproved: 'Grösste Verbesserung',
    moverWorsened: 'Grösste Verschlechterung',
  },
  fr: {
    heading: 'Classement en direct des douanes — temps d’attente',
    subtitle:
      'Les 5 douanes les plus rapides et les 5 plus lentes du Tessin, sur une moyenne glissante de 7 jours.',
    weekOf: 'Semaine',
    updated: 'Mis à jour',
    statDelta: 'Différence par passage',
    statHours: 'Heures perdues par an',
    statDays: 'Jours ouvrés perdus',
    chartWait: 'Attente moy.',
    legendFastest: 'La plus rapide',
    legendSlowest: 'La plus lente',
    bestH: 'Les plus rapides',
    worstH: 'Les plus lentes',
    loading: 'Chargement du classement en direct…',
    errorTitle: 'Classement indisponible',
    errorBody: 'Réessayez dans quelques minutes — le classement est mis à jour chaque semaine.',
    link: 'Voir le trafic en direct de chaque douane',
    trendBetter: 'en amélioration',
    trendWorse: 'en dégradation',
    trendFlat: 'stable',
    moversH: 'Ce qui a changé cette semaine',
    moverImproved: 'Plus forte amélioration',
    moverWorsened: 'Plus forte dégradation',
  },
};

function crossingName(slug: BorderCrossingSlug): string {
  return BORDER_CROSSING_DISPLAY[slug] ?? slug;
}

function formatUpdatedAt(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale, {
    dateStyle: 'medium',
  }).format(date);
}

/** "27 giu – 3 lug 2026" — the actual 7-day data window, not just the generation date. */
function formatWeekRange(weekStart: string, weekEnd: string, locale: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '—';
  const intlLocale = locale === 'it' ? 'it-IT' : locale;
  const fmt = new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtWithYear = new Intl.DateTimeFormat(intlLocale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${fmt.format(start)} – ${fmtWithYear.format(end)}`;
}

interface ChartRow extends BorderWaitRankingRow {
  isWorst: boolean;
}

function buildChartData(ranking: BorderWaitRankingRow[]): ChartRow[] {
  const best = ranking.slice(0, MAX_SIDE);
  const worst = ranking.slice(-MAX_SIDE);
  const bySlug = new Map<string, ChartRow>();
  for (const row of best) bySlug.set(row.slug, { ...row, isWorst: false });
  for (const row of worst) bySlug.set(row.slug, { ...row, isWorst: true });
  return Array.from(bySlug.values()).sort((a, b) => a.avgMinutes - b.avgMinutes);
}

function TrendIcon({ trend, label }: { trend: BorderWaitRankingRow['trend']; label: string }) {
  if (trend === 'better') return <TrendingDown size={14} className="text-success" aria-label={label} />;
  if (trend === 'worse') return <TrendingUp size={14} className="text-danger" aria-label={label} />;
  return <Minus size={14} className="text-muted" aria-label={label} />;
}

export default function InlineBorderWaitRanking() {
  const { t: _t } = useTranslation();
  void _t;
  const [locale] = useLocale();
  const labels = LABELS[locale];
  const isNarrow = useMediaQuery('(max-width: 640px)');

  const [snapshot, setSnapshot] = useState<BorderWaitRankingSnapshot | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetchBorderWaitRanking()
      .then((data) => {
        if (cancelled) return;
        if (!data || data.ranking.length < 2) {
          setStatus('error');
          return;
        }
        setSnapshot(data);
        setStatus('idle');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading' && !snapshot) {
    return (
      <div
        data-testid="inline-border-wait-ranking-loading"
        className="mt-6 rounded-xl border border-edge bg-surface-alt/60 p-4 text-sm text-subtle"
      >
        <Gauge className="inline-block mr-2 align-text-bottom" size={16} aria-hidden="true" />
        {labels.loading}
      </div>
    );
  }

  if (status === 'error' || !snapshot) {
    return (
      <div
        data-testid="inline-border-wait-ranking-error"
        className="mt-6 rounded-xl border border-warning-border/60 bg-warning-subtle/40 p-4 text-sm text-warning"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{labels.errorTitle}</p>
            <p className="mt-1">{labels.errorBody}</p>
          </div>
        </div>
      </div>
    );
  }

  const { ranking, funFacts, movers } = snapshot;
  const chartData = buildChartData(ranking);
  const chartHeight = Math.max(240, chartData.length * 36 + 24);
  const best = ranking.slice(0, MAX_SIDE);
  const worst = ranking.slice(-MAX_SIDE).reverse();
  const trendLabel = (trend: BorderWaitRankingRow['trend']): string =>
    trend === 'better' ? labels.trendBetter : trend === 'worse' ? labels.trendWorse : labels.trendFlat;
  const topImproved: BorderWaitRankingMover | undefined = movers?.improved?.[0];
  const topWorsened: BorderWaitRankingMover | undefined = movers?.worsened?.[0];

  return (
    <section
      data-testid="inline-border-wait-ranking"
      aria-labelledby="inline-border-wait-ranking-heading"
      className="mt-6 rounded-xl border border-edge bg-surface-alt/60 overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-edge">
        <h3
          id="inline-border-wait-ranking-heading"
          className="text-lg font-bold text-strong flex items-center gap-2"
        >
          <Gauge size={20} className="text-accent" aria-hidden="true" />
          {labels.heading}
        </h3>
        <p className="mt-2 text-sm text-subtle">{labels.subtitle}</p>
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent-subtle px-3 py-1 text-xs font-semibold text-accent">
          {labels.weekOf}: {formatWeekRange(snapshot.weekStart, snapshot.weekEnd, locale)}
        </p>
        <p className="mt-2 text-xs text-muted">
          {labels.updated}: {formatUpdatedAt(snapshot.updatedAt, locale)}
        </p>
      </header>

      {funFacts && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 sm:p-5 border-b border-edge">
          <div className="rounded-lg bg-surface p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-strong">{fmtMinutes(funFacts.deltaMinutesPerCrossing)}</p>
            <p className="mt-1 text-xs text-muted">{labels.statDelta}</p>
          </div>
          <div className="rounded-lg bg-surface p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-strong">{funFacts.hoursPerYear}</p>
            <p className="mt-1 text-xs text-muted">{labels.statHours}</p>
          </div>
          <div className="rounded-lg bg-surface p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-strong">{funFacts.workingDaysLostPerYear}</p>
            <p className="mt-1 text-xs text-muted">{labels.statDays}</p>
          </div>
        </div>
      )}

      {(topImproved || topWorsened) && (
        <div className="p-4 sm:p-5 border-b border-edge">
          <h4 className="text-sm font-bold text-strong mb-2">{labels.moversH}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {topImproved && (
              <div className="flex items-center gap-2 rounded-lg border border-success-border bg-success-subtle px-3 py-2 text-sm">
                <TrendingDown size={16} className="text-success shrink-0" aria-hidden="true" />
                <span className="text-strong">
                  <span className="text-xs font-semibold text-success block">{labels.moverImproved}</span>
                  {crossingName(topImproved.slug)} — {fmtSignedMinutesDelta(topImproved.deltaMinutes)}
                </span>
              </div>
            )}
            {topWorsened && (
              <div className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-subtle px-3 py-2 text-sm">
                <TrendingUp size={16} className="text-danger shrink-0" aria-hidden="true" />
                <span className="text-strong">
                  <span className="text-xs font-semibold text-danger block">{labels.moverWorsened}</span>
                  {crossingName(topWorsened.slug)} — {fmtSignedMinutesDelta(topWorsened.deltaMinutes)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="p-4 sm:p-5">
        <div className="mb-3 flex items-center gap-4 text-xs font-medium text-subtle">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: CHART_DATA_COLORS.positive }}
              aria-hidden="true"
            />
            {labels.legendFastest}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: CHART_DATA_COLORS.negative }}
              aria-hidden="true"
            />
            {labels.legendSlowest}
          </span>
        </div>
        <ChartWrapper height={chartHeight}>
          {(colors) => (
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
              barSize={16}
              onClick={() => Analytics.trackChartInteraction('border_wait_ranking', 'click')}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} horizontal={false} />
              <XAxis type="number" tick={{ fill: colors.tick, fontSize: 11 }} unit=" min" />
              <YAxis
                type="category"
                dataKey="slug"
                tickFormatter={(slug: string) => crossingName(slug as BorderCrossingSlug)}
                tick={{ fill: colors.tick, fontSize: isNarrow === false ? 12 : 11 }}
                width={isNarrow === false ? 150 : 108}
              />
              <Tooltip
                contentStyle={colors.tooltipStyle}
                formatter={(value: number) => [`${value} min`, labels.chartWait]}
                labelFormatter={(slug: string) => crossingName(slug as BorderCrossingSlug)}
              />
              <Bar dataKey="avgMinutes" radius={[0, 6, 6, 0]}>
                {chartData.map((row) => (
                  <Cell
                    key={row.slug}
                    fill={row.isWorst ? CHART_DATA_COLORS.negative : CHART_DATA_COLORS.positive}
                  />
                ))}
              </Bar>
            </BarChart>
          )}
        </ChartWrapper>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-edge/60 border-t border-edge">
        <div className="p-4 sm:p-5">
          <h4 className="text-sm font-bold text-strong mb-2">{labels.bestH}</h4>
          <ol className="space-y-1.5 text-sm">
            {best.map((row) => (
              <li key={row.slug} className="flex items-center justify-between gap-2">
                <a
                  href={buildOggiPath(locale, row.slug)}
                  className="text-link hover:underline font-medium truncate"
                >
                  {row.rank}. {crossingName(row.slug)}
                </a>
                <span className="flex items-center gap-1 text-muted shrink-0 tabular-nums">
                  {fmtMinutes(row.avgMinutes)}
                  {row.deltaMinutes != null && (
                    <span className="text-xs">({fmtSignedMinutesDelta(row.deltaMinutes)})</span>
                  )}
                  <TrendIcon trend={row.trend} label={trendLabel(row.trend)} />
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="p-4 sm:p-5">
          <h4 className="text-sm font-bold text-strong mb-2">{labels.worstH}</h4>
          <ol className="space-y-1.5 text-sm">
            {worst.map((row) => (
              <li key={row.slug} className="flex items-center justify-between gap-2">
                <a
                  href={buildOggiPath(locale, row.slug)}
                  className="text-link hover:underline font-medium truncate"
                >
                  {row.rank}. {crossingName(row.slug)}
                </a>
                <span className="flex items-center gap-1 text-muted shrink-0 tabular-nums">
                  {fmtMinutes(row.avgMinutes)}
                  {row.deltaMinutes != null && (
                    <span className="text-xs">({fmtSignedMinutesDelta(row.deltaMinutes)})</span>
                  )}
                  <TrendIcon trend={row.trend} label={trendLabel(row.trend)} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <footer className="p-4 sm:p-5 border-t border-edge">
        <a href={buildRootHubPath(locale)} className="text-sm text-link hover:underline font-medium">
          {labels.link} →
        </a>
      </footer>
    </section>
  );
}
