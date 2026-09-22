import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CarFront,
  ChevronRight,
  ExternalLink,
  MapPinned,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useTranslation } from "@/services/i18n";
import { getCantonLabel, CANTON_CODES } from "@/services/cantonList";
import {
  ASTRA_SOURCE_LINK,
  fetchAstraVehicleStats,
  type AstraVehicleStatsData,
  type MonthlyCantonVehicleMetrics,
  type VehicleFuelKey,
  type VehicleMetrics,
} from "@/services/astraVehicleStatsService";

type ObservatorySection = "switzerland" | "frontaliere";

const FUEL_COLORS: Record<VehicleFuelKey, string> = {
  electric: "bg-success",
  plugInHybrid: "bg-accent",
  hybrid: "bg-warning",
  petrol: "bg-orange-400",
  diesel: "bg-slate-500",
  gas: "bg-purple-500",
  other: "bg-slate-300 dark:bg-slate-600",
};

function formatNumber(value: number, locale: string): string {
  return Math.round(value).toLocaleString(locale || "it-IT");
}

function formatShare(value: number): string {
  return `${value.toFixed(1)}%`;
}

function electricShare(metrics: VehicleMetrics): number {
  return metrics.total > 0 ? (metrics.electric / metrics.total) * 100 : 0;
}

function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-edge bg-surface-alt/60 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 font-display text-2xl font-bold tabular-nums text-heading">
        {value}
      </p>
      {detail && <p className="mt-1 text-xs text-subtle">{detail}</p>}
    </div>
  );
}

function FuelMix({
  metrics,
  t,
}: {
  metrics: VehicleMetrics;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-3">
      {metrics.fuelMix
        .filter((item) => item.count > 0)
        .map((item) => (
          <div key={item.key}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold text-body">
                {t(`stats.vehicleFuel.${item.key}`)}
              </span>
              <span className="tabular-nums text-muted">
                {formatNumber(item.count, "it-IT")} · {formatShare(item.share)}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-alt"
              aria-hidden="true"
            >
              <div
                className={`h-full rounded-full ${FUEL_COLORS[item.key]}`}
                style={{ width: `${Math.max(item.share, 1)}%` }}
              />
            </div>
          </div>
        ))}
    </div>
  );
}

function sortCantonRows(
  rows: MonthlyCantonVehicleMetrics[],
): MonthlyCantonVehicleMetrics[] {
  const order = new Map(CANTON_CODES.map((code, index) => [code, index]));
  return [...rows].sort((left, right) => {
    const totalDelta = right.stock.total - left.stock.total;
    if (totalDelta !== 0) return totalDelta;
    return (order.get(left.code) ?? 99) - (order.get(right.code) ?? 99);
  });
}

function SwitzerlandPanel({
  data,
  locale,
  t,
}: {
  data: AstraVehicleStatsData;
  locale: string;
  t: (key: string) => string;
}) {
  const monthly = data.monthly.latest;
  const rows = useMemo(
    () => sortCantonRows(monthly.byCanton),
    [monthly.byCanton],
  );
  const electricNationalShare = electricShare(monthly.national.stock);

  return (
    <section aria-labelledby="vehicle-switzerland-title" className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
          {t("stats.vehicleSwitzerlandEyebrow")}
        </p>
        <h3
          id="vehicle-switzerland-title"
          className="mt-1 font-display text-2xl font-bold tracking-tight text-heading"
        >
          {t("stats.vehicleSwitzerlandTitle")}
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-subtle">
          {t("stats.vehicleSwitzerlandIntro")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={t("stats.vehicleStock")}
          value={formatNumber(monthly.national.stock.total, locale)}
          detail={monthly.period}
          icon={<CarFront className="h-4 w-4 text-accent" />}
        />
        <MetricCard
          label={t("stats.vehicleNew")}
          value={formatNumber(monthly.national.newRegistrations.total, locale)}
          detail={t("stats.vehicleNewDetail")}
          icon={<CalendarDays className="h-4 w-4 text-success" />}
        />
        <MetricCard
          label={t("stats.vehicleImports")}
          value={formatNumber(monthly.national.usedImports.total, locale)}
          detail={t("stats.vehicleImportsDetail")}
          icon={<ChevronRight className="h-4 w-4 text-warning" />}
        />
        <MetricCard
          label={t("stats.vehicleElectricShare")}
          value={formatShare(electricNationalShare)}
          detail={t("stats.vehicleElectricDetail")}
          icon={<Zap className="h-4 w-4 text-success" />}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-edge">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-edge bg-surface-alt/60 px-4 py-3">
          <div>
            <h4 className="font-semibold text-heading">
              {t("stats.vehicleCantonTableTitle")}
            </h4>
            <p className="mt-1 text-xs text-subtle">
              {t("stats.vehicleCantonTableIntro")}
            </p>
            <p className="mt-1 text-xs text-subtle">
              {t("stats.vehicleCantonDetail")}
            </p>
          </div>
          <span className="text-xs font-semibold text-muted">
            {rows.length}/26
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-surface-alt text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-3">{t("stats.vehicleCanton")}</th>
                <th className="px-4 py-3 text-right">
                  {t("stats.vehicleStock")}
                </th>
                <th className="px-4 py-3 text-right">
                  {t("stats.vehicleNewShort")}
                </th>
                <th className="px-4 py-3 text-right">
                  {t("stats.vehicleImportsShort")}
                </th>
                <th className="px-4 py-3 text-right">
                  {t("stats.vehicleElectricShort")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {rows.map((row) => (
                <tr key={row.code} className="text-body">
                  <th
                    scope="row"
                    className="px-4 py-3 font-semibold text-heading"
                  >
                    {row.code}{" "}
                    <span className="ml-1 font-normal text-subtle">
                      {getCantonLabel(
                        row.code,
                        locale as "it" | "en" | "de" | "fr",
                      )}
                    </span>
                  </th>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatNumber(row.stock.total, locale)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatNumber(row.newRegistrations.total, locale)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatNumber(row.usedImports.total, locale)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-success">
                    {formatShare(electricShare(row.stock))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function TicinoPanel({
  data,
  locale,
  t,
}: {
  data: AstraVehicleStatsData;
  locale: string;
  t: (key: string) => string;
}) {
  const monthly = data.monthly.latest;
  const ticino = monthly.byCanton.find((row) => row.code === "TI");
  const weekly = data.weekly.latest;
  const history = data.weekly.history.slice(-12);
  const maxWeekly = Math.max(...history.map((item) => item.ticinoTotal), 1);
  if (!ticino) return null;

  return (
    <section aria-labelledby="vehicle-frontaliere-title" className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
          {t("stats.vehicleFrontaliereEyebrow")}
        </p>
        <h3
          id="vehicle-frontaliere-title"
          className="mt-1 font-display text-2xl font-bold tracking-tight text-heading"
        >
          {t("stats.vehicleFrontaliereTitle")}
        </h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-subtle">
          {t("stats.vehicleFrontaliereIntro")}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={t("stats.vehicleTicinoStock")}
          value={formatNumber(ticino.stock.total, locale)}
          detail={monthly.period}
          icon={<MapPinned className="h-4 w-4 text-accent" />}
        />
        <MetricCard
          label={t("stats.vehicleTicinoWeekly")}
          value={formatNumber(weekly.byCanton.TI?.total || 0, locale)}
          detail={weekly.period}
          icon={<CalendarDays className="h-4 w-4 text-warning" />}
        />
        <MetricCard
          label={t("stats.vehicleTicinoNew")}
          value={formatNumber(ticino.newRegistrations.total, locale)}
          detail={t("stats.vehicleNewDetail")}
          icon={<CarFront className="h-4 w-4 text-success" />}
        />
        <MetricCard
          label={t("stats.vehicleTicinoElectric")}
          value={formatShare(electricShare(ticino.stock))}
          detail={t("stats.vehicleElectricDetail")}
          icon={<Zap className="h-4 w-4 text-success" />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(260px,.85fr)]">
        <div className="rounded-2xl border border-edge bg-surface-alt/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-heading">
                {t("stats.vehicleWeeklyHistory")}
              </h4>
              <p className="mt-1 text-xs text-subtle">
                {t("stats.vehicleWeeklyProvisional")}
              </p>
            </div>
            <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] font-semibold text-warning">
              {t("stats.vehicleProvisional")}
            </span>
          </div>
          <div className="mt-5 space-y-3">
            {history.map((point) => (
              <div
                key={point.period}
                className="grid grid-cols-[72px_1fr_auto] items-center gap-3 text-xs"
              >
                <span className="text-muted">{point.period}</span>
                <div className="h-2 overflow-hidden rounded-full bg-surface">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{
                      width: `${Math.max(3, (point.ticinoTotal / maxWeekly) * 100)}%`,
                    }}
                  />
                </div>
                <span className="min-w-16 text-right font-semibold tabular-nums text-heading">
                  {formatNumber(point.ticinoTotal, locale)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-edge bg-surface-alt/40 p-4">
          <h4 className="font-semibold text-heading">
            {t("stats.vehicleTicinoFuelTitle")}
          </h4>
          <p className="mt-1 text-xs text-subtle">
            {t("stats.vehicleTicinoFuelIntro")}
          </p>
          <div className="mt-5">
            <FuelMix metrics={ticino.stock} t={t} />
          </div>
        </div>
      </div>

      <div className="flex gap-2 rounded-2xl border border-accent-border bg-accent-subtle/50 p-4 text-sm leading-6 text-subtle">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-accent"
          aria-hidden="true"
        />
        <p>{t("stats.vehicleWeeklyNote")}</p>
      </div>
    </section>
  );
}

export default function VehicleObservatory() {
  const { t, locale } = useTranslation();
  const [section, setSection] = useState<ObservatorySection>("switzerland");
  const [data, setData] = useState<AstraVehicleStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (force = false) => {
    if (force) setRefreshing(true);
    setError(null);
    try {
      const result = await fetchAstraVehicleStats({ force });
      if (!result.data)
        throw new Error(result.error || t("stats.vehicleDataUnavailable"));
      setData(result.data);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("stats.vehicleDataUnavailable"),
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section
      className="mt-8 rounded-3xl border border-edge bg-surface p-4 shadow-sm sm:p-6"
      aria-labelledby="vehicle-observatory-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-edge pb-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
            {t("stats.vehicleEyebrow")}
          </p>
          <h2
            id="vehicle-observatory-title"
            className="mt-1 font-display text-2xl font-bold tracking-tight text-heading"
          >
            {t("stats.vehicleTitle")}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-subtle">
            {t("stats.vehicleIntro")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-link transition-colors hover:border-accent disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw
            className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            aria-hidden="true"
          />
          {t("stats.vehicleRefresh")}
        </button>
      </div>

      <div
        className="mt-5 flex flex-wrap gap-2"
        role="tablist"
        aria-label={t("stats.vehicleSections")}
      >
        {(["switzerland", "frontaliere"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={section === value}
            onClick={() => setSection(value)}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${section === value ? "border-accent bg-accent text-on-accent" : "border-edge text-link hover:border-accent"}`}
          >
            {value === "switzerland"
              ? t("stats.vehicleSectionSwitzerland")
              : t("stats.vehicleSectionFrontaliere")}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {loading && (
          <div className="space-y-3" aria-busy="true">
            <div className="h-20 animate-pulse rounded-2xl bg-surface-alt" />
            <div className="h-64 animate-pulse rounded-2xl bg-surface-alt" />
          </div>
        )}
        {!loading && error && (
          <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-subtle">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            <p>{error}</p>
          </div>
        )}
        {!loading &&
          !error &&
          data &&
          (section === "switzerland" ? (
            <SwitzerlandPanel data={data} locale={locale} t={t} />
          ) : (
            <TicinoPanel data={data} locale={locale} t={t} />
          ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4 text-xs text-muted">
        <span>
          {t("stats.vehicleUpdated")}:{" "}
          {data?.lastUpdated
            ? new Date(data.lastUpdated).toLocaleDateString(locale)
            : "—"}
        </span>
        <a
          href={ASTRA_SOURCE_LINK}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-semibold text-link hover:underline"
        >
          {t("stats.vehicleSource")}{" "}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
