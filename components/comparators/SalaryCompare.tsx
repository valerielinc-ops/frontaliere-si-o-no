import React, { useState, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import {
  TrendingUp, AlertTriangle, Download, BarChart3, Users,
  Briefcase, ChevronDown, ChevronUp, Search, BookOpen, Info,
} from 'lucide-react';
import { useExchangeRate } from '@/services/exchangeRateService';
import {
  SALARY_DATA, getSectorMedian, TOTAL_PROFESSIONS, TOTAL_SECTORS,
  type SalaryLevel,
} from '@/data/salaryData';

const SalarySurvey = lazy(() => import('@/components/community/SalarySurvey'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

// ── Net calculation helpers ──────────────────────────────────────────────────

const PPP_FACTOR = 0.65;
const CH_SOCIAL_RATE = 0.136;

function chWithholding(gross: number): number {
  if (gross <= 30000) return gross * 0.03;
  if (gross <= 60000) return gross * 0.065;
  if (gross <= 100000) return gross * 0.10;
  if (gross <= 150000) return gross * 0.14;
  return gross * 0.18;
}

function itIrpef(gross: number): number {
  const taxable = gross * 0.85;
  if (taxable <= 0) return 0;
  let tax = 0;
  const brackets: [number, number][] = [[28000, 0.23], [50000, 0.35], [Infinity, 0.43]];
  let remaining = taxable;
  let prev = 0;
  for (const [limit, rate] of brackets) {
    const slice = Math.min(remaining, limit - prev);
    tax += slice * rate;
    remaining -= slice;
    prev = limit;
    if (remaining <= 0) break;
  }
  return tax + gross * 0.0919 + taxable * 0.025;
}

function calcNetCH(gross: number): number {
  return Math.round(gross - gross * CH_SOCIAL_RATE - chWithholding(gross));
}

function calcNetIT(gross: number): number {
  return Math.round(gross - itIrpef(gross));
}

// ── Component ────────────────────────────────────────────────────────────────

type InternalTab = 'sectors' | 'professions' | 'survey';

export default function SalaryCompare() {
  const { t } = useTranslation();
  const { rate: exchangeRate } = useExchangeRate();
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<SalaryLevel>('mid');
  const [activeTab, setActiveTab] = useState<InternalTab>('sectors');
  const [expandedSectors, setExpandedSectors] = useState<Set<string>>(new Set());
  const [profSearch, setProfSearch] = useState('');

  const sectorName = (id: string) => t('salaryCompare.sector' + id);
  const profName = (id: string) => t('salaryCompare.prof.' + id);
  const levelLabel = (level: SalaryLevel) => t('salaryCompare.' + level);

  // ── Sector overview data ──
  const sectorTableData = useMemo(() => {
    const sectors = selectedSector
      ? SALARY_DATA.filter((s) => s.id === selectedSector)
      : SALARY_DATA;
    return sectors.map((s) => {
      const chGross = getSectorMedian(s, selectedLevel, 'ch');
      const itGross = getSectorMedian(s, selectedLevel, 'it');
      const chNet = calcNetCH(chGross);
      const itNet = calcNetIT(itGross);
      const chNetEUR = Math.round(chNet * exchangeRate);
      const ppp = Math.round(chNet * PPP_FACTOR * exchangeRate);
      const delta = chNetEUR - itNet;
      const deltaPercent = itNet > 0 ? Math.round((delta / itNet) * 100) : 0;
      return {
        id: s.id, name: sectorName(s.id),
        chGross, itGross, chNet, itNet, chNetEUR, ppp, delta, deltaPercent,
        professions: s.professions,
      };
    });
  }, [selectedSector, selectedLevel, t, exchangeRate]);

  // ── All professions flat for search tab ──
  const allProfessions = useMemo(() => {
    return SALARY_DATA.flatMap((s) =>
      s.professions.map((p) => ({
        ...p,
        sectorId: s.id,
        sectorName: sectorName(s.id),
        professionName: profName(p.id),
      })),
    );
  }, [t]);

  const filteredProfessions = useMemo(() => {
    let profs = allProfessions;
    if (selectedSector) profs = profs.filter((p) => p.sectorId === selectedSector);
    if (profSearch.trim()) {
      const q = profSearch.toLowerCase();
      profs = profs.filter(
        (p) =>
          p.professionName.toLowerCase().includes(q) ||
          p.sectorName.toLowerCase().includes(q),
      );
    }
    return profs;
  }, [allProfessions, selectedSector, profSearch]);

  const toggleSector = (id: string) => {
    setExpandedSectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── PDF export ──
  const handlePDF = async () => {
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(16);
    doc.text(t('salaryCompare.title'), 14, 20);
    doc.setFontSize(10);
    doc.text(
      levelLabel(selectedLevel) + ' \u2014 ' + t('salaryCompare.source'),
      14, 28,
    );
    autoTable(doc, {
      startY: 35,
      head: [[
        t('salaryCompare.sector'), t('salaryCompare.grossCH'),
        t('salaryCompare.grossIT'), t('salaryCompare.netCH'),
        t('salaryCompare.netIT'), t('salaryCompare.delta'),
        t('salaryCompare.ppp'),
      ]],
      body: sectorTableData.map((r) => [
        r.name,
        'CHF ' + r.chGross.toLocaleString(),
        '\u20AC ' + r.itGross.toLocaleString(),
        'CHF ' + r.chNet.toLocaleString(),
        '\u20AC ' + r.itNet.toLocaleString(),
        '\u20AC ' + (r.delta > 0 ? '+' : '') + r.delta.toLocaleString(),
        '\u20AC ' + r.ppp.toLocaleString(),
      ]),
    });
    // Per-sector profession pages
    SALARY_DATA.forEach((sector) => {
      doc.addPage();
      doc.setFontSize(14);
      doc.text(sectorName(sector.id), 14, 20);
      autoTable(doc, {
        startY: 28,
        head: [[
          t('salaryCompare.professions'),
          'CH Min', 'CH ' + t('salaryCompare.median'), 'CH Max',
          'IT Min', 'IT ' + t('salaryCompare.median'), 'IT Max',
        ]],
        body: sector.professions.map((p) => {
          const ch = p.ch[selectedLevel];
          const it = p.it[selectedLevel];
          return [
            profName(p.id),
            'CHF ' + ch[0].toLocaleString(),
            'CHF ' + ch[1].toLocaleString(),
            'CHF ' + ch[2].toLocaleString(),
            '\u20AC ' + it[0].toLocaleString(),
            '\u20AC ' + it[1].toLocaleString(),
            '\u20AC ' + it[2].toLocaleString(),
          ];
        }),
      });
    });
    doc.save('salary-comparison-detailed.pdf');
  };

  const maxVal = Math.max(
    ...sectorTableData.map((r) => Math.max(r.chNetEUR, r.itNet)),
  );

  // ── Tab config ──
  const tabConfig: {
    id: InternalTab; label: string; icon: React.ReactNode; cls: string;
  }[] = [
    { id: 'sectors', label: t('salaryCompare.tabSectors'), icon: <BarChart3 size={16} />, cls: 'text-amber-700 dark:text-amber-400' },
    { id: 'professions', label: t('salaryCompare.tabProfessions'), icon: <Briefcase size={16} />, cls: 'text-blue-700 dark:text-blue-400' },
    { id: 'survey', label: t('salary.title'), icon: <Users size={16} />, cls: 'text-blue-700 dark:text-blue-400' },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-lg p-6">
        <div className="flex items-center gap-3 mb-2">
          <TrendingUp className="text-amber-600 dark:text-amber-400" size={28} />
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">
            {t('salaryCompare.title')}
          </h2>
        </div>
        <p className="text-slate-600 dark:text-slate-400">
          {t('salaryCompare.subtitle')}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-3 leading-relaxed">
          {t('comparatori.salaryCompare.intro.p1')}
        </p>

        {/* Stats banner */}
        <div className="flex flex-wrap gap-4 mt-4">
          <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-1.5">
            <BarChart3 size={14} className="text-amber-700 dark:text-amber-400" />
            <span className="text-sm font-bold text-amber-800 dark:text-amber-300">
              {TOTAL_SECTORS} {t('salaryCompare.totalSectors')}
            </span>
          </div>
          <div className="flex items-center gap-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-1.5">
            <Briefcase size={14} className="text-blue-700 dark:text-blue-400" />
            <span className="text-sm font-bold text-blue-800 dark:text-blue-300">
              {TOTAL_PROFESSIONS} {t('salaryCompare.totalProfessions')}
            </span>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-1 bg-slate-100 dark:bg-slate-700 rounded-lg p-1 mt-4">
          {tabConfig.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={
                'flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition ' +
                (activeTab === tab.id
                  ? 'bg-white dark:bg-slate-600 ' + tab.cls + ' shadow'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white')
              }
              aria-label={tab.label}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Survey tab ── */}
      {activeTab === 'survey' ? (
        <Suspense
          fallback={
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
            </div>
          }
        >
          <SalarySurvey />
        </Suspense>
      ) : (
        <>
          {/* ── Controls ── */}
          <div className="bg-white dark:bg-slate-800 rounded-xl shadow p-4">
            <div className="flex flex-wrap gap-4 items-end">
              {/* Sector filter */}
              <div className="flex-1 min-w-[180px]">
                <label
                  htmlFor="sc-sector"
                  className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  {t('salaryCompare.sector')}
                </label>
                <select
                  id="sc-sector"
                  value={selectedSector || ''}
                  onChange={(e) => setSelectedSector(e.target.value || null)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-slate-800 dark:text-white"
                >
                  <option value="">{t('salaryCompare.allSectors')}</option>
                  {SALARY_DATA.map((s) => (
                    <option key={s.id} value={s.id}>
                      {sectorName(s.id)}
                    </option>
                  ))}
                </select>
              </div>

              {activeTab === 'professions' && (
                <div className="flex-1 min-w-[180px]">
                  <label
                    htmlFor="sc-search"
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    {t('salaryCompare.searchProfession')}
                  </label>
                  <div className="relative">
                    <Search
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400"
                    />
                    <input
                      id="sc-search"
                      type="text"
                      value={profSearch}
                      onChange={(e) => setProfSearch(e.target.value)}
                      placeholder={t('salaryCompare.searchProfession')}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 pl-9 pr-3 py-2 text-slate-800 dark:text-white placeholder:text-slate-500"
                    />
                  </div>
                </div>
              )}

              {/* Level selector */}
              <div className="flex gap-1 bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
                {(['junior', 'mid', 'senior'] as SalaryLevel[]).map((level) => (
                  <button
                    key={level}
                    onClick={() => setSelectedLevel(level)}
                    className={
                      'px-4 py-1.5 rounded-md text-sm font-medium transition ' +
                      (selectedLevel === level
                        ? 'bg-white dark:bg-slate-600 text-amber-700 dark:text-amber-400 shadow'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white')
                    }
                    aria-label={levelLabel(level)}
                  >
                    {levelLabel(level)}
                  </button>
                ))}
              </div>

              {/* PDF export */}
              <button
                onClick={handlePDF}
                className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 transition"
                aria-label="Export PDF"
              >
                <Download size={14} /> PDF
              </button>
            </div>
          </div>

          {/* ══════════════ SECTORS TAB ══════════════ */}
          {activeTab === 'sectors' && (
            <>
              {/* ── Mobile layout (< sm) ── */}
              <div className="block sm:hidden space-y-2">
                {sectorTableData.map((r) => (
                  <div
                    key={r.id}
                    className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
                  >
                    {/* Sector row — tappable */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={expandedSectors.has(r.id)}
                      onClick={() => toggleSector(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleSector(r.id);
                        }
                      }}
                      className="flex items-center gap-2 p-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
                    >
                      {/* Name */}
                      <span className="w-20 text-xs font-semibold text-slate-800 dark:text-white leading-tight flex-shrink-0">
                        {r.name}
                      </span>

                      {/* Bars + amounts */}
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] flex-shrink-0">{'\uD83C\uDDE8\uD83C\uDDED'}</span>
                          <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-red-500 rounded-full"
                              style={{ width: (r.chNetEUR / maxVal) * 100 + '%' }}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] flex-shrink-0">{'\uD83C\uDDEE\uD83C\uDDF9'}</span>
                          <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 rounded-full"
                              style={{ width: (r.itNet / maxVal) * 100 + '%' }}
                            />
                          </div>
                        </div>
                        <div className="flex justify-between text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                          <span>CH {'\u20AC'}{r.chNetEUR.toLocaleString()}</span>
                          <span>IT {'\u20AC'}{r.itNet.toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Delta % */}
                      <span className="w-11 text-right text-sm font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0">
                        {r.deltaPercent > 0 ? '+' : ''}{r.deltaPercent}%
                      </span>

                      {/* Chevron */}
                      <span className="w-4 flex justify-center text-slate-500 dark:text-slate-400 flex-shrink-0">
                        {expandedSectors.has(r.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </span>
                    </div>

                    {/* Expanded profession cards — 2-column grid */}
                    {expandedSectors.has(r.id) && (
                      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
                        {r.professions.map((p) => {
                          const ch = p.ch[selectedLevel]; // [min, median, max]
                          const it = p.it[selectedLevel]; // [min, median, max]
                          const chNet = calcNetCH(ch[1]);
                          const itNet = calcNetIT(it[1]);
                          const deltaEUR = Math.round(chNet * exchangeRate) - itNet;
                          const deltaPct = itNet > 0 ? Math.round((deltaEUR / itNet) * 100) : 0;
                          return (
                            <div
                              key={p.id}
                              className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2.5 border border-slate-100 dark:border-slate-700"
                            >
                              <p className="text-[11px] text-slate-600 dark:text-slate-300 mb-1.5 leading-tight">
                                {profName(p.id)}
                              </p>
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-mono font-bold text-xs text-slate-800 dark:text-white">
                                  CHF {chNet.toLocaleString()}
                                </span>
                                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                                  {deltaPct > 0 ? '+' : ''}{deltaPct}%
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* ── Desktop layout (sm+) — unchanged ── */}
              <div className="hidden sm:block space-y-6">
              <div className="bg-white dark:bg-slate-800 rounded-xl shadow overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-700">
                      <tr>
                        <th className="py-3 px-4 text-left text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.sector')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.grossCH')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.grossIT')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.netCH')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.netIT')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.delta')}
                        </th>
                        <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">
                          {t('salaryCompare.ppp')}
                        </th>
                        <th className="py-3 px-2 w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {sectorTableData.map((r) => (
                        <React.Fragment key={r.id}>
                          <tr
                            className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 cursor-pointer"
                            onClick={() => toggleSector(r.id)}
                          >
                            <td className="py-3 px-4 font-medium text-slate-800 dark:text-white">
                              {r.name}
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                              CHF {r.chGross.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                              {'\u20AC'} {r.itGross.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-bold text-slate-800 dark:text-white">
                              CHF {r.chNet.toLocaleString()}
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-bold text-slate-800 dark:text-white">
                              {'\u20AC'} {r.itNet.toLocaleString()}
                            </td>
                            <td
                              className={
                                'py-3 px-3 text-right font-mono font-bold ' +
                                (r.delta > 0
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-red-600 dark:text-red-400')
                              }
                            >
                              {r.delta > 0 ? '+' : ''}{'\u20AC'}{' '}
                              {r.delta.toLocaleString()}
                              <span className="text-xs ml-1 opacity-70">
                                ({r.deltaPercent > 0 ? '+' : ''}
                                {r.deltaPercent}%)
                              </span>
                            </td>
                            <td className="py-3 px-3 text-right font-mono text-slate-600 dark:text-slate-400">
                              {'\u20AC'} {r.ppp.toLocaleString()}
                            </td>
                            <td className="py-3 px-2 text-slate-500 dark:text-slate-400">
                              {expandedSectors.has(r.id) ? (
                                <ChevronUp size={16} />
                              ) : (
                                <ChevronDown size={16} />
                              )}
                            </td>
                          </tr>
                          {/* Expanded profession rows */}
                          {expandedSectors.has(r.id) &&
                            r.professions.map((p) => {
                              const ch = p.ch[selectedLevel];
                              const it = p.it[selectedLevel];
                              return (
                                <tr
                                  key={p.id}
                                  className="bg-slate-50/50 dark:bg-slate-700/20 border-b border-slate-100 dark:border-slate-700/30"
                                >
                                  <td className="py-2 pl-8 pr-4 text-sm text-slate-700 dark:text-slate-300">
                                    <span className="flex items-center gap-2">
                                      <Briefcase
                                        size={12}
                                        className="text-blue-600 dark:text-blue-400"
                                      />
                                      {profName(p.id)}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right text-xs font-mono text-slate-600 dark:text-slate-400">
                                    <span className="block">
                                      CHF {ch[1].toLocaleString()}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">
                                      {ch[0].toLocaleString()}-
                                      {ch[2].toLocaleString()}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right text-xs font-mono text-slate-600 dark:text-slate-400">
                                    <span className="block">
                                      {'\u20AC'} {it[1].toLocaleString()}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">
                                      {it[0].toLocaleString()}-
                                      {it[2].toLocaleString()}
                                    </span>
                                  </td>
                                  <td className="py-2 px-3 text-right text-xs font-mono text-slate-700 dark:text-slate-300">
                                    CHF {calcNetCH(ch[1]).toLocaleString()}
                                  </td>
                                  <td className="py-2 px-3 text-right text-xs font-mono text-slate-700 dark:text-slate-300">
                                    {'\u20AC'} {calcNetIT(it[1]).toLocaleString()}
                                  </td>
                                  <td className="py-2 px-3 text-right text-xs font-mono text-emerald-700 dark:text-emerald-400">
                                    {(() => {
                                      const d =
                                        Math.round(
                                          calcNetCH(ch[1]) * exchangeRate,
                                        ) - calcNetIT(it[1]);
                                      return (
                                        (d > 0 ? '+' : '') +
                                        '\u20AC ' +
                                        d.toLocaleString()
                                      );
                                    })()}
                                  </td>
                                  <td colSpan={2} />
                                </tr>
                              );
                            })}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Visual comparison bars */}
              <div className="bg-white dark:bg-slate-800 rounded-xl shadow p-5">
                <div className="flex items-center gap-2 mb-4">
                  <BarChart3
                    className="text-amber-600 dark:text-amber-400"
                    size={20}
                  />
                  <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                    {t('salaryCompare.netCH')} vs {t('salaryCompare.netIT')}
                  </h3>
                </div>
                <div className="space-y-3">
                  {sectorTableData.map((r) => (
                    <div key={r.id} className="flex items-center gap-3">
                      <span className="w-28 text-sm text-slate-700 dark:text-slate-300 truncate">
                        {r.name}
                      </span>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="w-5 text-center text-xs">
                            {'\uD83C\uDDE8\uD83C\uDDED'}
                          </span>
                          <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-4 overflow-hidden">
                            <div
                              className="h-full bg-red-500 rounded-full"
                              style={{
                                width:
                                  (r.chNetEUR / maxVal) * 100 + '%',
                              }}
                            />
                          </div>
                          <span className="w-20 text-right text-xs font-mono text-slate-600 dark:text-slate-400">
                            {'\u20AC'} {r.chNetEUR.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-5 text-center text-xs">
                            {'\uD83C\uDDEE\uD83C\uDDF9'}
                          </span>
                          <div className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-full h-4 overflow-hidden">
                            <div
                              className="h-full bg-green-500 rounded-full"
                              style={{
                                width:
                                  (r.itNet / maxVal) * 100 + '%',
                              }}
                            />
                          </div>
                          <span className="w-20 text-right text-xs font-mono text-slate-600 dark:text-slate-400">
                            {'\u20AC'} {r.itNet.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-sm">
                  <p className="font-semibold text-amber-800 dark:text-amber-300">
                    {t('salaryCompare.ppp')}
                  </p>
                  <p className="text-slate-600 dark:text-slate-400 text-xs mt-1">
                    {t('salaryCompare.pppDesc')}
                  </p>
                </div>
              </div>
              </div>{/* end desktop wrapper */}
            </>
          )}

          {/* ══════════════ PROFESSIONS TAB ══════════════ */}
          {activeTab === 'professions' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {filteredProfessions.length}{' '}
                {t('salaryCompare.totalProfessions')}
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredProfessions.map((p) => {
                  const ch = p.ch[selectedLevel];
                  const it = p.it[selectedLevel];
                  const chNetMedian = calcNetCH(ch[1]);
                  const itNetMedian = calcNetIT(it[1]);
                  const deltaEUR =
                    Math.round(chNetMedian * exchangeRate) - itNetMedian;
                  const deltaPct =
                    itNetMedian > 0
                      ? Math.round((deltaEUR / itNetMedian) * 100)
                      : 0;

                  return (
                    <div
                      key={p.sectorId + '-' + p.id}
                      className="bg-white dark:bg-slate-800 rounded-xl shadow border border-slate-200 dark:border-slate-700 p-4 hover:shadow-md transition"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h4 className="font-bold text-slate-800 dark:text-white text-sm">
                            {p.professionName}
                          </h4>
                          <span className="inline-block mt-1 text-xs bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 rounded-full px-2 py-0.5">
                            {p.sectorName}
                          </span>
                        </div>
                        <span
                          className={
                            'text-sm font-bold ' +
                            (deltaEUR > 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400')
                          }
                        >
                          {deltaPct > 0 ? '+' : ''}
                          {deltaPct}%
                        </span>
                      </div>

                      {/* CH salary range */}
                      <div className="space-y-2">
                        <div>
                          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                            <span>
                              {'\uD83C\uDDE8\uD83C\uDDED'}{' '}
                              {t('salaryCompare.salaryRange')}
                            </span>
                            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                              CHF {ch[1].toLocaleString()}
                            </span>
                          </div>
                          <div className="relative h-2 bg-slate-100 dark:bg-slate-700 rounded-full">
                            <div
                              className="absolute h-full bg-red-400 dark:bg-red-500 rounded-full"
                              style={{
                                left: (ch[0] / ch[2]) * 100 + '%',
                                width:
                                  ((ch[2] - ch[0]) / ch[2]) * 100 + '%',
                              }}
                            />
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-red-600 dark:bg-red-400 rounded-full border-2 border-white dark:border-slate-800"
                              style={{
                                left: (ch[1] / ch[2]) * 100 + '%',
                              }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                            <span>{(ch[0] / 1000).toFixed(0)}k</span>
                            <span>{(ch[2] / 1000).toFixed(0)}k</span>
                          </div>
                        </div>

                        {/* IT salary range */}
                        <div>
                          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                            <span>
                              {'\uD83C\uDDEE\uD83C\uDDF9'}{' '}
                              {t('salaryCompare.salaryRange')}
                            </span>
                            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                              {'\u20AC'} {it[1].toLocaleString()}
                            </span>
                          </div>
                          <div className="relative h-2 bg-slate-100 dark:bg-slate-700 rounded-full">
                            <div
                              className="absolute h-full bg-green-400 dark:bg-green-500 rounded-full"
                              style={{
                                left: (it[0] / it[2]) * 100 + '%',
                                width:
                                  ((it[2] - it[0]) / it[2]) * 100 + '%',
                              }}
                            />
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-green-600 dark:bg-green-400 rounded-full border-2 border-white dark:border-slate-800"
                              style={{
                                left: (it[1] / it[2]) * 100 + '%',
                              }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                            <span>{(it[0] / 1000).toFixed(0)}k</span>
                            <span>{(it[2] / 1000).toFixed(0)}k</span>
                          </div>
                        </div>
                      </div>

                      {/* Net comparison */}
                      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 flex justify-between text-xs">
                        <div>
                          <span className="text-slate-500 dark:text-slate-400">
                            {t('salaryCompare.netCH')}:{' '}
                          </span>
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                            CHF {chNetMedian.toLocaleString()}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-slate-400">
                            {t('salaryCompare.netIT')}:{' '}
                          </span>
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                            {'\u20AC'} {itNetMedian.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Methodology section (always visible, SEO content) ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow p-6">
        <div className="flex items-center gap-2 mb-3">
          <BookOpen className="text-slate-600 dark:text-slate-400" size={20} />
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">
            {t('salaryCompare.methodology')}
          </h3>
        </div>
        <div className="text-sm text-slate-600 dark:text-slate-400 space-y-3">
          <p>{t('salaryCompare.methodologyText1')}</p>
          <p>{t('salaryCompare.methodologyText2')}</p>
          <p>{t('salaryCompare.methodologyText3')}</p>
        </div>
      </div>

      {/* ── FAQ section (SEO content) ── */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow p-6">
        <div className="flex items-center gap-2 mb-4">
          <Info className="text-blue-600 dark:text-blue-400" size={20} />
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">
            {t('salaryCompare.faqTitle')}
          </h3>
        </div>
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <details
              key={n}
              className="group border border-slate-200 dark:border-slate-700 rounded-lg"
            >
              <summary className="flex items-center justify-between p-4 cursor-pointer text-sm font-semibold text-slate-800 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-700/30 rounded-lg">
                {t('salaryCompare.faq' + n + 'Q')}
                <ChevronDown
                  size={16}
                  className="text-slate-500 dark:text-slate-400 group-open:rotate-180 transition-transform"
                />
              </summary>
              <div className="px-4 pb-4 text-sm text-slate-600 dark:text-slate-400">
                {t('salaryCompare.faq' + n + 'A')}
              </div>
            </details>
          ))}
        </div>
      </div>

      {/* ── Source + Disclaimer ── */}
      <div className="space-y-2">
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          {t('salaryCompare.source')}
        </p>
        <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <p>{t('salaryCompare.disclaimer')}</p>
        </div>
      </div>
      <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
    </div>
  );
}
