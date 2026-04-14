import React, { useState, useMemo, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import {
 TrendingUp, AlertTriangle, Download, BarChart3, Users,
 Briefcase, ChevronDown, ChevronUp, Search, BookOpen, Info,
} from 'lucide-react';
import { useExchangeRate } from '@/services/exchangeRateService';
import { SegmentControl } from '@/components/shared/SegmentControl';
import {
 SALARY_DATA, getSectorMedian, TOTAL_PROFESSIONS, TOTAL_SECTORS,
 SECTOR_METADATA,
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
 { id: 'sectors', label: t('salaryCompare.tabSectors'), icon: <BarChart3 size={16} />, cls: '' },
 { id: 'professions', label: t('salaryCompare.tabProfessions'), icon: <Briefcase size={16} />, cls: '' },
 { id: 'survey', label: t('salary.title'), icon: <Users size={16} />, cls: '' },
 ];

 return (
 <div className="space-y-6">
 {/* ── Header ── */}
 <div className="bg-surface rounded-xl shadow-lg p-6">
 <div className="flex items-center gap-3 mb-2">
 <TrendingUp className="text-warning" size={28} />
 <h2 className="text-2xl font-bold text-heading">
 {t('salaryCompare.title')}
 </h2>
 </div>
 <p className="text-subtle">
 {t('salaryCompare.subtitle')}
 </p>
 <p className="text-sm text-subtle mt-3 leading-relaxed">
 {t('comparatori.salaryCompare.intro.p1')}
 </p>

 {/* Stats banner */}
 <div className="flex flex-wrap gap-4 mt-4">
 <div className="flex items-center gap-2 bg-warning-subtle rounded-lg px-3 py-1.5">
 <BarChart3 size={14} className="text-warning" />
 <span className="text-sm font-bold text-warning">
 {TOTAL_SECTORS} {t('salaryCompare.totalSectors')}
 </span>
 </div>
 <div className="flex items-center gap-2 bg-accent-subtle rounded-lg px-3 py-1.5">
 <Briefcase size={14} className="text-accent" />
 <span className="text-sm font-bold text-accent">
 {TOTAL_PROFESSIONS} {t('salaryCompare.totalProfessions')}
 </span>
 </div>
 </div>

 {/* Sub-tabs */}
 <div className="mt-4">
 <SegmentControl
 options={tabConfig.map(t => ({ key: t.id, label: t.label, icon: t.icon }))}
 value={activeTab}
 onChange={(key) => setActiveTab(key as InternalTab)}
 activeTextClass="text-section-stats"
 />
 </div>
 </div>

 {/* ── Survey tab ── */}
 {activeTab === 'survey' ? (
 <Suspense
 fallback={
 <div className="flex justify-center py-8">
 <div className="animate-spin rounded-full h-8 w-8 border-2 border-info border-t-transparent" />
 </div>
 }
 >
 <SalarySurvey />
 </Suspense>
 ) : (
 <>
 {/* ── Controls ── */}
 <div className="bg-surface rounded-xl shadow p-4">
 <div className="flex flex-wrap gap-4 items-end">
 {/* Sector filter */}
 <div className="flex-1 min-w-[180px]">
 <label
 htmlFor="sc-sector"
 className="block text-sm font-medium text-body mb-1"
 >
 {t('salaryCompare.sector')}
 </label>
 <select
 id="sc-sector"
 value={selectedSector || ''}
 onChange={(e) => setSelectedSector(e.target.value || null)}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
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
 className="block text-sm font-medium text-body mb-1"
 >
 {t('salaryCompare.searchProfession')}
 </label>
 <div className="relative">
 <Search
 size={16}
 className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
 />
 <input
 id="sc-search"
 type="text"
 value={profSearch}
 onChange={(e) => setProfSearch(e.target.value)}
 placeholder={t('salaryCompare.searchProfession')}
 className="w-full rounded-lg border border-edge bg-surface-alt pl-9 pr-3 py-2 text-heading placeholder:text-muted"
 />
 </div>
 </div>
 )}

 {/* Level selector */}
 <div className="flex gap-1 bg-surface-raised rounded-lg p-1">
 {(['junior', 'mid', 'senior'] as SalaryLevel[]).map((level) => (
 <button
 key={level}
 onClick={() => setSelectedLevel(level)}
 className={
 'px-4 py-1.5 rounded-md text-sm font-medium transition ' +
 (selectedLevel === level
 ? 'bg-surface text-warning shadow'
 : 'text-subtle hover:text-strong')
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
 className="flex items-center gap-1.5 px-4 py-2 bg-warning-strong text-on-accent text-sm rounded-lg hover:bg-warning-strong-hover transition"
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
 className="bg-surface rounded-xl border border-edge overflow-hidden"
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
 className="flex items-center gap-2 p-3 cursor-pointer hover:bg-surface-raised/30 transition-colors"
 >
 {/* Name */}
 <span className="w-20 text-xs font-semibold text-heading leading-tight flex-shrink-0">
 {r.name}
 </span>

 {/* Bars + amounts */}
 <div className="flex-1 min-w-0 space-y-1">
 <div className="flex items-center gap-1.5">
 <span className="text-xs flex-shrink-0">{'\uD83C\uDDE8\uD83C\uDDED'}</span>
 <div className="flex-1 h-2 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-danger-strong rounded-full"
 style={{ width: (r.chNetEUR / maxVal) * 100 + '%' }}
 />
 </div>
 </div>
 <div className="flex items-center gap-1.5">
 <span className="text-xs flex-shrink-0">{'\uD83C\uDDEE\uD83C\uDDF9'}</span>
 <div className="flex-1 h-2 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-success-strong rounded-full"
 style={{ width: (r.itNet / maxVal) * 100 + '%' }}
 />
 </div>
 </div>
 <div className="flex justify-between text-xs font-mono text-muted mt-0.5">
 <span>CH {'\u20AC'}{r.chNetEUR.toLocaleString()}</span>
 <span>IT {'\u20AC'}{r.itNet.toLocaleString()}</span>
 </div>
 </div>

 {/* Delta % */}
 <span className="w-11 text-right text-sm font-bold text-success flex-shrink-0">
 {r.deltaPercent > 0 ? '+' : ''}{r.deltaPercent}%
 </span>

 {/* Chevron */}
 <span className="w-4 flex justify-center text-muted flex-shrink-0">
 {expandedSectors.has(r.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
 </span>
 </div>

 {/* Expanded profession cards — 2-column grid */}
 {expandedSectors.has(r.id) && (
 <div className="px-3 pb-3">
 {/* Sector metadata badges */}
 {SECTOR_METADATA[r.id] && (
 <div className="flex flex-wrap gap-1.5 mb-2.5">
 <span className="inline-flex items-center gap-1 text-xs bg-accent-subtle text-accent rounded-full px-2 py-0.5">
 <Users size={10} /> {SECTOR_METADATA[r.id].employeeCount.toLocaleString()} {t('salaryCompare.meta.employees')}
 </span>
 {SECTOR_METADATA[r.id].frontialieriRatio < 1.0 && (
 <span className="inline-flex items-center gap-1 text-xs bg-warning-subtle text-warning rounded-full px-2 py-0.5">
 {t('salaryCompare.meta.frontalieri')} {Math.round((1 - SECTOR_METADATA[r.id].frontialieriRatio) * 100)}%
 </span>
 )}
 <span className="inline-flex items-center gap-1 text-xs bg-accent-subtle text-accent rounded-full px-2 py-0.5">
 {t('salaryCompare.meta.genderGap')} {SECTOR_METADATA[r.id].genderGapPercent > 0 ? '+' : ''}{SECTOR_METADATA[r.id].genderGapPercent.toFixed(1)}%
 </span>
 <span className="inline-flex items-center gap-1 text-xs bg-success-subtle text-success rounded-full px-2 py-0.5">
 {t('salaryCompare.meta.eduPremium')} {SECTOR_METADATA[r.id].educationPremiumRatio.toFixed(2)}x
 </span>
 </div>
 )}
 <div className="grid grid-cols-2 gap-2">
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
 className="bg-surface-alt rounded-lg p-2.5 border border-edge"
 >
 <p className="text-sm text-subtle mb-1.5 leading-tight">
 {profName(p.id)}
 </p>
 <div className="flex items-center justify-between gap-1">
 <span className="font-mono font-bold text-xs text-heading">
 CHF {chNet.toLocaleString()}
 </span>
 <span className="text-xs font-bold text-success">
 {deltaPct > 0 ? '+' : ''}{deltaPct}%
 </span>
 </div>
 </div>
 );
 })}
 </div>
 </div>
 )}
 </div>
 ))}
 </div>

 {/* ── Desktop layout (sm+) — unchanged ── */}
 <div className="hidden sm:block space-y-6">
 <div className="bg-surface rounded-xl shadow overflow-hidden">
 <div className="overflow-x-auto">
 <table className="w-full text-sm">
 <thead className="bg-surface-alt">
 <tr>
 <th className="py-3 px-4 text-left text-subtle">
 {t('salaryCompare.sector')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.grossCH')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.grossIT')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.netCH')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.netIT')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.delta')}
 </th>
 <th className="py-3 px-3 text-right text-subtle">
 {t('salaryCompare.ppp')}
 </th>
 <th className="py-3 px-2 w-8" />
 </tr>
 </thead>
 <tbody>
 {sectorTableData.map((r) => (
 <React.Fragment key={r.id}>
 <tr
 className="border-b border-edge/50 hover:bg-surface-raised/30 cursor-pointer"
 onClick={() => toggleSector(r.id)}
 >
 <td className="py-3 px-4 font-medium text-heading">
 {r.name}
 </td>
 <td className="py-3 px-3 text-right font-mono text-body">
 CHF {r.chGross.toLocaleString()}
 </td>
 <td className="py-3 px-3 text-right font-mono text-body">
 {'\u20AC'} {r.itGross.toLocaleString()}
 </td>
 <td className="py-3 px-3 text-right font-mono font-bold text-heading">
 CHF {r.chNet.toLocaleString()}
 </td>
 <td className="py-3 px-3 text-right font-mono font-bold text-heading">
 {'\u20AC'} {r.itNet.toLocaleString()}
 </td>
 <td
 className={
 'py-3 px-3 text-right font-mono font-bold ' +
 (r.delta > 0
 ? 'text-success'
 : 'text-danger')
 }
 >
 {r.delta > 0 ? '+' : ''}{'\u20AC'}{' '}
 {r.delta.toLocaleString()}
 <span className="text-xs ml-1 opacity-70">
 ({r.deltaPercent > 0 ? '+' : ''}
 {r.deltaPercent}%)
 </span>
 </td>
 <td className="py-3 px-3 text-right font-mono text-subtle">
 {'\u20AC'} {r.ppp.toLocaleString()}
 </td>
 <td className="py-3 px-2 text-muted">
 {expandedSectors.has(r.id) ? (
 <ChevronUp size={16} />
 ) : (
 <ChevronDown size={16} />
 )}
 </td>
 </tr>
 {/* Expanded profession rows */}
 {expandedSectors.has(r.id) && (
 <>
 {/* Sector metadata row */}
 {SECTOR_METADATA[r.id] && (
 <tr className="bg-surface-alt/80 border-b border-edge/30">
 <td colSpan={8} className="py-2 px-4">
 <div className="flex flex-wrap gap-2">
 <span className="inline-flex items-center gap-1 text-xs bg-accent-subtle text-accent rounded-full px-2.5 py-0.5">
 <Users size={11} /> {SECTOR_METADATA[r.id].employeeCount.toLocaleString()} {t('salaryCompare.meta.employees')}
 </span>
 {SECTOR_METADATA[r.id].frontialieriRatio < 1.0 && (
 <span className="inline-flex items-center gap-1 text-xs bg-warning-subtle text-warning rounded-full px-2.5 py-0.5">
 {t('salaryCompare.meta.frontalieri')} −{Math.round((1 - SECTOR_METADATA[r.id].frontialieriRatio) * 100)}%
 </span>
 )}
 <span className="inline-flex items-center gap-1 text-xs bg-accent-subtle text-accent rounded-full px-2.5 py-0.5">
 {t('salaryCompare.meta.genderGap')} {SECTOR_METADATA[r.id].genderGapPercent > 0 ? '+' : ''}{SECTOR_METADATA[r.id].genderGapPercent.toFixed(1)}%
 </span>
 <span className="inline-flex items-center gap-1 text-xs bg-success-subtle text-success rounded-full px-2.5 py-0.5">
 {t('salaryCompare.meta.eduPremium')} {SECTOR_METADATA[r.id].educationPremiumRatio.toFixed(2)}x
 </span>
 {SECTOR_METADATA[r.id].cclMinimumAnnual > 41600 && (
 <span className="inline-flex items-center gap-1 text-xs bg-danger-subtle text-danger rounded-full px-2.5 py-0.5">
 CCL min CHF {SECTOR_METADATA[r.id].cclMinimumAnnual.toLocaleString()}/yr
 </span>
 )}
 </div>
 </td>
 </tr>
 )}
 {r.professions.map((p) => {
 const ch = p.ch[selectedLevel];
 const it = p.it[selectedLevel];
 return (
 <tr
 key={p.id}
 className="bg-surface-alt/50 border-b border-edge/30"
 >
 <td className="py-2 pl-8 pr-4 text-sm text-body">
 <span className="flex items-center gap-2">
 <Briefcase
 size={12}
 className="text-link"
 />
 {profName(p.id)}
 </span>
 </td>
 <td className="py-2 px-3 text-right text-xs font-mono text-subtle">
 <span className="block">
 CHF {ch[1].toLocaleString()}
 </span>
 <span className="text-muted">
 {ch[0].toLocaleString()}-
 {ch[2].toLocaleString()}
 </span>
 </td>
 <td className="py-2 px-3 text-right text-xs font-mono text-subtle">
 <span className="block">
 {'\u20AC'} {it[1].toLocaleString()}
 </span>
 <span className="text-muted">
 {it[0].toLocaleString()}-
 {it[2].toLocaleString()}
 </span>
 </td>
 <td className="py-2 px-3 text-right text-xs font-mono text-body">
 CHF {calcNetCH(ch[1]).toLocaleString()}
 </td>
 <td className="py-2 px-3 text-right text-xs font-mono text-body">
 {'\u20AC'} {calcNetIT(it[1]).toLocaleString()}
 </td>
 <td className="py-2 px-3 text-right text-xs font-mono text-success">
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
 </>
 )}
 </React.Fragment>
 ))}
 </tbody>
 </table>
 </div>
 </div>

 {/* Visual comparison bars */}
 <div className="bg-surface rounded-xl shadow p-5">
 <div className="flex items-center gap-2 mb-4">
 <BarChart3
 className="text-warning"
 size={20}
 />
 <h3 className="text-lg font-bold text-heading">
 {t('salaryCompare.netCH')} vs {t('salaryCompare.netIT')}
 </h3>
 </div>
 <div className="space-y-3">
 {sectorTableData.map((r) => (
 <div key={r.id} className="flex items-center gap-3">
 <span className="w-28 text-sm text-body truncate">
 {r.name}
 </span>
 <div className="flex-1 space-y-1">
 <div className="flex items-center gap-2">
 <span className="w-5 text-center text-xs">
 {'\uD83C\uDDE8\uD83C\uDDED'}
 </span>
 <div className="flex-1 bg-surface-raised rounded-full h-4 overflow-hidden">
 <div
 className="h-full bg-danger-strong rounded-full"
 style={{
 width:
 (r.chNetEUR / maxVal) * 100 + '%',
 }}
 />
 </div>
 <span className="w-20 text-right text-xs font-mono text-subtle">
 {'\u20AC'} {r.chNetEUR.toLocaleString()}
 </span>
 </div>
 <div className="flex items-center gap-2">
 <span className="w-5 text-center text-xs">
 {'\uD83C\uDDEE\uD83C\uDDF9'}
 </span>
 <div className="flex-1 bg-surface-raised rounded-full h-4 overflow-hidden">
 <div
 className="h-full bg-success-strong rounded-full"
 style={{
 width:
 (r.itNet / maxVal) * 100 + '%',
 }}
 />
 </div>
 <span className="w-20 text-right text-xs font-mono text-subtle">
 {'\u20AC'} {r.itNet.toLocaleString()}
 </span>
 </div>
 </div>
 </div>
 ))}
 </div>

 <div className="mt-4 bg-warning-subtle rounded-lg p-3 text-xs">
 <p className="font-semibold text-warning">
 {t('salaryCompare.ppp')}
 </p>
 <p className="text-subtle text-xs mt-1">
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
 <p className="text-sm text-subtle">
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
 className="bg-surface rounded-xl shadow border border-edge p-4 hover:shadow-md transition"
 >
 <div className="flex items-start justify-between mb-3">
 <div>
 <h4 className="font-bold text-heading text-sm">
 {p.professionName}
 </h4>
 <span className="inline-block mt-1 text-xs bg-surface-raised text-subtle rounded-full px-2 py-0.5">
 {p.sectorName}
 </span>
 </div>
 <span
 className={
 'text-sm font-bold ' +
 (deltaEUR > 0
 ? 'text-success'
 : 'text-danger')
 }
 >
 {deltaPct > 0 ? '+' : ''}
 {deltaPct}%
 </span>
 </div>

 {/* CH salary range */}
 <div className="space-y-2">
 <div>
 <div className="flex justify-between text-xs text-muted mb-1">
 <span>
 {'\uD83C\uDDE8\uD83C\uDDED'}{' '}
 {t('salaryCompare.salaryRange')}
 </span>
 <span className="font-mono font-bold text-body">
 CHF {ch[1].toLocaleString()}
 </span>
 </div>
 <div className="relative h-2 bg-surface-raised rounded-full">
 <div
 className="absolute h-full bg-danger rounded-full"
 style={{
 left: (ch[0] / ch[2]) * 100 + '%',
 width:
 ((ch[2] - ch[0]) / ch[2]) * 100 + '%',
 }}
 />
 <div
 className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-danger rounded-full border-2 border-surface"
 style={{
 left: (ch[1] / ch[2]) * 100 + '%',
 }}
 />
 </div>
 <div className="flex justify-between text-xs text-muted mt-0.5 font-mono">
 <span>{(ch[0] / 1000).toFixed(0)}k</span>
 <span>{(ch[2] / 1000).toFixed(0)}k</span>
 </div>
 </div>

 {/* IT salary range */}
 <div>
 <div className="flex justify-between text-xs text-muted mb-1">
 <span>
 {'\uD83C\uDDEE\uD83C\uDDF9'}{' '}
 {t('salaryCompare.salaryRange')}
 </span>
 <span className="font-mono font-bold text-body">
 {'\u20AC'} {it[1].toLocaleString()}
 </span>
 </div>
 <div className="relative h-2 bg-surface-raised rounded-full">
 <div
 className="absolute h-full bg-success rounded-full"
 style={{
 left: (it[0] / it[2]) * 100 + '%',
 width:
 ((it[2] - it[0]) / it[2]) * 100 + '%',
 }}
 />
 <div
 className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-success rounded-full border-2 border-surface"
 style={{
 left: (it[1] / it[2]) * 100 + '%',
 }}
 />
 </div>
 <div className="flex justify-between text-xs text-muted mt-0.5 font-mono">
 <span>{(it[0] / 1000).toFixed(0)}k</span>
 <span>{(it[2] / 1000).toFixed(0)}k</span>
 </div>
 </div>
 </div>

 {/* Net comparison */}
 <div className="mt-3 pt-3 border-t border-edge flex justify-between text-xs">
 <div>
 <span className="text-muted">
 {t('salaryCompare.netCH')}:{' '}
 </span>
 <span className="font-mono font-bold text-body">
 CHF {chNetMedian.toLocaleString()}
 </span>
 </div>
 <div>
 <span className="text-muted">
 {t('salaryCompare.netIT')}:{' '}
 </span>
 <span className="font-mono font-bold text-body">
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
 <div className="bg-surface rounded-xl shadow p-6">
 <div className="flex items-center gap-2 mb-3">
 <BookOpen className="text-subtle" size={20} />
 <h3 className="text-lg font-bold text-heading">
 {t('salaryCompare.methodology')}
 </h3>
 </div>
 <div className="text-sm text-subtle space-y-3">
 <p>{t('salaryCompare.methodologyText1')}</p>
 <p>{t('salaryCompare.methodologyText2')}</p>
 <p>{t('salaryCompare.methodologyText3')}</p>
 </div>
 </div>

 {/* ── FAQ section (SEO content) ── */}
 <div className="bg-surface rounded-xl shadow p-6">
 <div className="flex items-center gap-2 mb-4">
 <Info className="text-link" size={20} />
 <h3 className="text-lg font-bold text-heading">
 {t('salaryCompare.faqTitle')}
 </h3>
 </div>
 <div className="space-y-4">
 {[1, 2, 3, 4, 5].map((n) => (
 <details
 key={n}
 className="group border border-edge rounded-lg"
 >
 <summary className="flex items-center justify-between p-4 cursor-pointer text-sm font-semibold text-heading hover:bg-surface-raised/30 rounded-lg">
 {t('salaryCompare.faq' + n + 'Q')}
 <ChevronDown
 size={16}
 className="text-muted group-open:rotate-180 transition-transform"
 />
 </summary>
 <div className="px-4 pb-4 text-sm text-subtle">
 {t('salaryCompare.faq' + n + 'A')}
 </div>
 </details>
 ))}
 </div>
 </div>

 {/* ── Source + Disclaimer ── */}
 <div className="space-y-2">
 <p className="text-sm text-muted font-medium">
 {t('salaryCompare.source')}
 </p>
 <div className="flex items-start gap-2 text-xs text-muted">
 <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
 <p>{t('salaryCompare.disclaimer')}</p>
 </div>
 </div>
 <Suspense fallback={null}><RelatedTools context="salary" /></Suspense>
 </div>
 );
}
