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
import {
  fetchBorderWaitRanking,
  type BorderWaitRankingSnapshot,
  type BorderWaitRankingRow,
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
  updated: string;
  statDelta: string;
  statHours: string;
  statDays: string;
  chartWait: string;
  bestH: string;
  worstH: string;
  loading: string;
  errorTitle: string;
  errorBody: string;
  link: string;
  trendBetter: string;
  trendWorse: string;
  trendFlat: string;
}

const LABELS: Record<'it' | 'en' | 'de' | 'fr', LocalizedLabels> = {
  it: {
    heading: 'Classifica live delle dogane — tempi di attesa',
    subtitle:
      'Le 5 dogane più veloci e le 5 più lente del Ticino, calcolate sulla media mobile degli ultimi 7 giorni.',
    updated: 'Aggiornato',
    statDelta: 'Differenza per passaggio',
    statHours: 'Ore perse all’anno',
    statDays: 'Giornate lavorative perse',
    chartWait: 'Attesa media',
    bestH: 'Più veloci',
    worstH: 'Più lente',
    loading: 'Caricamento classifica live…',
    errorTitle: 'Classifica non disponibile',
    errorBody: 'Riprova tra qualche minuto — la classifica si aggiorna ogni settimana.',
    link: 'Vedi il traffico live di ogni dogana',
    trendBetter: 'in miglioramento',
    trendWorse: 'in peggioramento',
    trendFlat: 'stabile',
  },
  en: {
    heading: 'Live border crossing ranking — wait times',
    subtitle:
      'The 5 fastest and 5 slowest Ticino border crossings, based on a rolling 7-day average.',
    updated: 'Updated',
    statDelta: 'Difference per crossing',
    statHours: 'Hours lost per year',
    statDays: 'Working days lost',
    chartWait: 'Avg. wait',
    bestH: 'Fastest',
    worstH: 'Slowest',
    loading: 'Loading live ranking…',
    errorTitle: 'Ranking unavailable',
    errorBody: 'Try again in a few minutes — the ranking refreshes weekly.',
    link: 'See live traffic at every crossing',
    trendBetter: 'improving',
    trendWorse: 'worsening',
    trendFlat: 'stable',
  },
  de: {
    heading: 'Live-Rangliste der Grenzübergänge — Wartezeiten',
    subtitle:
      'Die 5 schnellsten und 5 langsamsten Grenzübergänge im Tessin, auf Basis eines gleitenden 7-Tage-Durchschnitts.',
    updated: 'Aktualisiert',
    statDelta: 'Unterschied pro Übertritt',
    statHours: 'Verlorene Stunden pro Jahr',
    statDays: 'Verlorene Arbeitstage',
    chartWait: 'Ø Wartezeit',
    bestH: 'Am schnellsten',
    worstH: 'Am langsamsten',
    loading: 'Live-Rangliste wird geladen…',
    errorTitle: 'Rangliste nicht verfügbar',
    errorBody: 'Versuche es in ein paar Minuten erneut — die Rangliste wird wöchentlich aktualisiert.',
    link: 'Live-Verkehr an jedem Übergang ansehen',
    trendBetter: 'verbessert sich',
    trendWorse: 'verschlechtert sich',
    trendFlat: 'stabil',
  },
  fr: {
    heading: 'Classement en direct des douanes — temps d’attente',
    subtitle:
      'Les 5 douanes les plus rapides et les 5 plus lentes du Tessin, sur une moyenne glissante de 7 jours.',
    updated: 'Mis à jour',
    statDelta: 'Différence par passage',
    statHours: 'Heures perdues par an',
    statDays: 'Jours ouvrés perdus',
    chartWait: 'Attente moy.',
    bestH: 'Les plus rapides',
    worstH: 'Les plus lentes',
    loading: 'Chargement du classement en direct…',
    errorTitle: 'Classement indisponible',
    errorBody: 'Réessayez dans quelques minutes — le classement est mis à jour chaque semaine.',
    link: 'Voir le trafic en direct de chaque douane',
    trendBetter: 'en amélioration',
    trendWorse: 'en dégradation',
    trendFlat: 'stable',
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

  const { ranking, funFacts } = snapshot;
  const chartData = buildChartData(ranking);
  const best = ranking.slice(0, MAX_SIDE);
  const worst = ranking.slice(-MAX_SIDE).reverse();
  const trendLabel = (trend: BorderWaitRankingRow['trend']): string =>
    trend === 'better' ? labels.trendBetter : trend === 'worse' ? labels.trendWorse : labels.trendFlat;

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
        <p className="mt-2 text-xs text-muted">
          {labels.updated}: {formatUpdatedAt(snapshot.updatedAt, locale)}
        </p>
      </header>

      {funFacts && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 sm:p-5 border-b border-edge">
          <div className="rounded-lg bg-surface p-3 text-center">
            <p className="text-2xl font-bold tabular-nums text-strong">{funFacts.deltaMinutesPerCrossing}</p>
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

      <div className="p-4 sm:p-5">
        <ChartWrapper height={300}>
          {(colors) => (
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 48 }}
              barSize={18}
              onClick={() => Analytics.trackChartInteraction('border_wait_ranking', 'click')}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
              <XAxis
                dataKey="slug"
                tickFormatter={(slug: string) => crossingName(slug as BorderCrossingSlug)}
                tick={{ fill: colors.tick, fontSize: 10 }}
                angle={-35}
                textAnchor="end"
                interval={0}
                height={70}
              />
              <YAxis tick={{ fill: colors.tick, fontSize: 11 }} unit=" min" />
              <Tooltip
                contentStyle={colors.tooltipStyle}
                formatter={(value: number) => [`${value} min`, labels.chartWait]}
                labelFormatter={(slug: string) => crossingName(slug as BorderCrossingSlug)}
              />
              <Bar dataKey="avgMinutes" radius={[6, 6, 0, 0]}>
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
                <span className="flex items-center gap-1 text-muted shrink-0">
                  {row.avgMinutes} min <TrendIcon trend={row.trend} label={trendLabel(row.trend)} />
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
                <span className="flex items-center gap-1 text-muted shrink-0">
                  {row.avgMinutes} min <TrendIcon trend={row.trend} label={trendLabel(row.trend)} />
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
