import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslation } from '@/services/i18n';
import { Clock, MapPin, AlertTriangle, TrendingUp, TrendingDown, Minus, Info, Database, Cpu, Loader2 } from 'lucide-react';
import { borderCrossings } from '@/data/borderCrossings';
import { reportCaughtError } from '@/services/errorReporter';

/* ─── Types ─── */

interface TrafficPattern {
 baseWaitMinutes: number;
 hourMultiplier: Record<number, number>; // 0-23
 dayMultiplier: Record<number, number>; // 0=Sun..6=Sat
}

/** Aggregated Firestore data: day (0-6) → hour (0-23) → average minutes */
type AggregatedTraffic = Record<number, Record<number, number>>;

/* ─── Crossing name → Firestore slug mapping ─── */

const CROSSING_SLUG_MAP: Record<string, string> = {
 'Chiasso - Strada': 'chiasso-strada',
 'Chiasso - Brogeda': 'chiasso-brogeda',
 'Gaggiolo': 'gaggiolo',
 'Ponte Tresa': 'ponte-tresa',
 'Stabio': 'san-pietro',
 'Ponte Chiasso': 'chiasso-centro',
};

/* ─── Fallback: static traffic pattern model ─── */

const CROSSING_PATTERNS: Record<string, TrafficPattern> = {
 'Chiasso - Strada': {
 baseWaitMinutes: 8,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.2, 5: 0.5, 6: 1.2, 7: 2.8, 8: 3.0, 9: 2.0, 10: 1.0, 11: 0.8, 12: 0.9, 13: 0.8, 14: 0.7, 15: 1.0, 16: 1.8, 17: 2.8, 18: 3.5, 19: 2.5, 20: 1.0, 21: 0.5, 22: 0.3, 23: 0.2 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.5, 6: 0.6 },
 },
 'Chiasso - Brogeda': {
 baseWaitMinutes: 10,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.2, 5: 0.4, 6: 1.0, 7: 2.5, 8: 3.2, 9: 2.2, 10: 1.1, 11: 0.8, 12: 0.9, 13: 0.8, 14: 0.7, 15: 1.0, 16: 1.9, 17: 3.0, 18: 4.0, 19: 2.8, 20: 1.0, 21: 0.5, 22: 0.3, 23: 0.2 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.5, 6: 0.6 },
 },
 'Gaggiolo': {
 baseWaitMinutes: 6,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.3, 5: 0.6, 6: 1.5, 7: 3.0, 8: 2.5, 9: 1.5, 10: 0.8, 11: 0.7, 12: 0.8, 13: 0.7, 14: 0.6, 15: 0.9, 16: 1.5, 17: 2.5, 18: 3.0, 19: 2.0, 20: 0.8, 21: 0.4, 22: 0.2, 23: 0.1 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.95, 3: 1.0, 4: 1.0, 5: 1.4, 6: 0.5 },
 },
 'Ponte Tresa': {
 baseWaitMinutes: 5,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.3, 5: 0.5, 6: 1.3, 7: 2.5, 8: 2.2, 9: 1.4, 10: 0.8, 11: 0.7, 12: 0.8, 13: 0.7, 14: 0.6, 15: 0.8, 16: 1.4, 17: 2.2, 18: 2.8, 19: 1.8, 20: 0.7, 21: 0.4, 22: 0.2, 23: 0.1 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.9, 3: 1.0, 4: 1.0, 5: 1.3, 6: 0.5 },
 },
 'Stabio': {
 baseWaitMinutes: 4,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.3, 5: 0.6, 6: 1.4, 7: 2.6, 8: 2.3, 9: 1.3, 10: 0.7, 11: 0.6, 12: 0.7, 13: 0.6, 14: 0.5, 15: 0.8, 16: 1.3, 17: 2.0, 18: 2.5, 19: 1.5, 20: 0.6, 21: 0.3, 22: 0.2, 23: 0.1 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.3, 6: 0.5 },
 },
 'Ponte Chiasso': {
 baseWaitMinutes: 5,
 hourMultiplier: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.2, 5: 0.5, 6: 1.2, 7: 2.4, 8: 2.6, 9: 1.6, 10: 0.9, 11: 0.7, 12: 0.8, 13: 0.7, 14: 0.6, 15: 0.9, 16: 1.5, 17: 2.4, 18: 3.0, 19: 2.0, 20: 0.8, 21: 0.4, 22: 0.2, 23: 0.1 },
 dayMultiplier: { 0: 0.3, 1: 1.0, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.5, 6: 0.6 },
 },
};

const CROSSING_NAMES = Object.keys(CROSSING_PATTERNS);
const DAY_NAMES_IT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const PEAK_HOURS = new Set([5, 6, 7, 8, 9, 17, 18, 19, 20, 21]);

/* ─── Firestore fetch + aggregation ─── */

const MIN_SNAPSHOTS_FOR_REAL_DATA = 20;

/**
 * Fetches recent snapshots from trafficHistory/{slug}/snapshots/ and
 * aggregates them into average wait minutes per (dayOfWeek, hour).
 */
async function fetchAndAggregate(crossingNames: string[]): Promise<Record<string, AggregatedTraffic>> {
 const { getApp } = await import('@/services/firebase');
 const { getFirestore, collection, getDocs, query, orderBy, limit } = await import('firebase/firestore');

 const app = await getApp();
 const db = getFirestore(app);
 const result: Record<string, AggregatedTraffic> = {};

 await Promise.all(crossingNames.map(async (name) => {
 const slug = CROSSING_SLUG_MAP[name];
 if (!slug) return;

 try {
 const snapshotsRef = collection(db, 'trafficHistory', slug, 'snapshots');
 const q = query(snapshotsRef, orderBy('lastUpdate', 'desc'), limit(500));
 const snapshot = await getDocs(q);

 if (snapshot.size < MIN_SNAPSHOTS_FOR_REAL_DATA) return;

 // Accumulator: day → hour → { sum, count }
 const acc: Record<number, Record<number, { sum: number; count: number }>> = {};

 snapshot.forEach(doc => {
 const d = doc.data();
 const day: number = d.dayOfWeek;
 const hour: number = d.hour;
 const minutes: number = d.totalCrossingMinutes ?? d.waitTimeMinutes ?? 0;
 if (day == null || hour == null) return;

 if (!acc[day]) acc[day] = {};
 if (!acc[day][hour]) acc[day][hour] = { sum: 0, count: 0 };
 acc[day][hour].sum += minutes;
 acc[day][hour].count += 1;
 });

 // Convert to averages
 const aggregated: AggregatedTraffic = {};
 for (const day of Object.keys(acc)) {
 const d = Number(day);
 aggregated[d] = {};
 for (const hour of Object.keys(acc[d])) {
 const h = Number(hour);
 aggregated[d][h] = Math.round(acc[d][h].sum / acc[d][h].count);
 }
 }
 result[name] = aggregated;
 } catch (err) {
 console.warn(`[TrafficHistory] Failed to fetch history for ${name}:`, err);
 reportCaughtError(err, `TrafficHistory.fetch.${slug}`);
 }
 }));

 return result;
}

/* ─── Wait-time lookup with Firestore-first fallback ─── */

function getWaitMinutes(
 crossing: string,
 day: number,
 hour: number,
 realData: Record<string, AggregatedTraffic>,
): number {
 const real = realData[crossing];
 if (real?.[day]?.[hour] !== undefined) return real[day][hour];

 // Fallback to static model
 const pattern = CROSSING_PATTERNS[crossing];
 if (!pattern) return 0;
 const hMult = pattern.hourMultiplier[hour] ?? 0.5;
 const dMult = pattern.dayMultiplier[day] ?? 1.0;
 return Math.round(pattern.baseWaitMinutes * hMult * dMult);
}

/** Returns the number of crossings that have real Firestore data loaded */
export function countRealCrossings(realData: Record<string, AggregatedTraffic>): number {
 return Object.keys(realData).length;
}

function getColorClass(minutes: number): string {
 if (minutes <= 2) return 'bg-success-subtle text-success';
 if (minutes <= 5) return 'bg-success-subtle text-success';
 if (minutes <= 10) return 'bg-warning-subtle text-warning';
 if (minutes <= 18) return 'bg-warning-subtle text-warning';
 if (minutes <= 25) return 'bg-danger-subtle text-danger';
 return 'bg-danger text-white';
}

function getTrendIcon(current: number, previous: number) {
 if (current > previous + 2) return <TrendingUp size={14} className="text-red-500" />;
 if (current < previous - 2) return <TrendingDown size={14} className="text-emerald-500" />;
 return <Minus size={14} className="text-muted" />;
}

export default function TrafficHistory() {
 const { t } = useTranslation();
 const [selectedCrossing, setSelectedCrossing] = useState(CROSSING_NAMES[0]);
 const [realData, setRealData] = useState<Record<string, AggregatedTraffic>>({});
 const [loading, setLoading] = useState(true);

 /* Fetch Firestore data on mount */
 const loadData = useCallback(async () => {
 setLoading(true);
 try {
 const data = await fetchAndAggregate(CROSSING_NAMES);
 setRealData(data);
 } catch (err) {
 console.warn('[TrafficHistory] Firestore fetch failed, using fallback model', err);
 reportCaughtError(err, 'TrafficHistory.loadData');
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => { loadData(); }, [loadData]);

 const dataSource: 'firestore' | 'model' = realData[selectedCrossing] ? 'firestore' : 'model';

 /* Best & worst time analysis */
 const analysis = useMemo(() => {
 let bestDay = 0, bestHour = 0, bestWait = 999;
 let worstDay = 0, worstHour = 0, worstWait = 0;

 for (let d = 1; d <= 5; d++) {
 for (let h = 5; h <= 10; h++) {
 const w = getWaitMinutes(selectedCrossing, d, h, realData);
 if (w < bestWait) { bestWait = w; bestDay = d; bestHour = h; }
 if (w > worstWait) { worstWait = w; worstDay = d; worstHour = h; }
 }
 }

 const dayAverages = DAY_NAMES_IT.map((name, d) => {
 const hours7to9 = [7, 8, 9].map(h => getWaitMinutes(selectedCrossing, d, h, realData));
 const avg = Math.round(hours7to9.reduce((a, b) => a + b, 0) / 3);
 return { name, avg, day: d };
 });

 return { bestDay, bestHour, bestWait, worstDay, worstHour, worstWait, dayAverages };
 }, [selectedCrossing, realData]);

 /* Heatmap data */
 const heatmapData = useMemo(() => {
 return DAY_NAMES_IT.map((dayName, dayIdx) => ({
 dayName,
 dayIdx,
 hours: HOURS.map(h => ({
 hour: h,
 wait: getWaitMinutes(selectedCrossing, dayIdx, h, realData),
 })),
 }));
 }, [selectedCrossing, realData]);

 const crossingInfo = borderCrossings.find(c => c.name.includes(selectedCrossing.split(' - ')[0]));

 return (
 <div className="max-w-4xl mx-auto space-y-6">
 {/* Header */}
 <div className="text-center mb-6">
 <h2 className="text-2xl sm:text-3xl font-bold text-strong mb-2 flex items-center justify-center gap-2">
 <Clock size={28} className="text-stripe-600" />
 {t('trafficHistory.title')}
 </h2>
 <p className="text-subtle">{t('trafficHistory.subtitle')}</p>
 {/* Data source badge */}
 {loading ? (
 <span className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-xs font-medium bg-surface-raised text-subtle">
 <Loader2 size={12} className="animate-spin" />
 {t('trafficHistory.loading')}
 </span>
 ) : (
 <span className={`inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-xs font-medium ${
 dataSource === 'firestore'
 ? 'bg-success-subtle text-success'
 : 'bg-warning-subtle text-warning'
 }`}>
 {dataSource === 'firestore' ? <Database size={12} /> : <Cpu size={12} />}
 {dataSource === 'firestore' ? t('trafficHistory.sourceReal') : t('trafficHistory.sourceModel')}
 </span>
 )}
 </div>

 {/* Crossing selector */}
 <div className="flex flex-wrap gap-2 justify-center">
 {CROSSING_NAMES.map(name => (
 <button
 key={name}
 onClick={() => setSelectedCrossing(name)}
 className={`px-4 py-2 rounded-xl text-sm font-medium transition-[color,background-color,border-color,box-shadow] ${
 selectedCrossing === name
 ? 'bg-stripe-600 text-white shadow-lg'
 : 'bg-surface text-body border border-edge hover:border-stripe-400'
 }`}
 >
 <MapPin size={14} className="inline mr-1" />
 {name}
 </button>
 ))}
 </div>

 {/* Quick insights */}
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
 <div className="bg-success-subtle border border-success-border rounded-xl p-4">
 <p className="text-sm text-success font-semibold mb-1">{t('trafficHistory.bestTime')}</p>
 <p className="text-lg font-bold text-success">
 {DAY_NAMES_IT[analysis.bestDay]} {analysis.bestHour}:00
 </p>
 <p className="text-sm text-success">{analysis.bestWait} min</p>
 </div>
 <div className="bg-danger-subtle border border-danger-border rounded-xl p-4">
 <p className="text-sm text-danger font-semibold mb-1">{t('trafficHistory.worstTime')}</p>
 <p className="text-lg font-bold text-danger">
 {DAY_NAMES_IT[analysis.worstDay]} {analysis.worstHour}:00
 </p>
 <p className="text-sm text-danger">{analysis.worstWait} min</p>
 </div>
 <div className="bg-accent-subtle border border-accent-border rounded-xl p-4">
 <p className="text-xs text-link font-semibold mb-1">{t('trafficHistory.dailyAvg')}</p>
 <div className="flex gap-1 mt-1">
 {analysis.dayAverages.map(d => (
 <div key={d.day} className="flex-1 text-center">
 <p className="text-xs text-accent">{d.name}</p>
 <p className={`text-xs font-bold rounded px-1 py-0.5 ${d.avg > 15 ? 'text-danger' : d.avg > 8 ? 'text-warning' : 'text-success'}`}>
 {d.avg}'
 </p>
 </div>
 ))}
 </div>
 </div>
 </div>

 {/* Heatmap */}
 <div className="bg-surface rounded-2xl border border-edge p-4">
 <h3 className="text-base font-semibold text-body mb-4 flex items-center gap-2">
 <AlertTriangle size={16} className="text-amber-500" />
 {t('trafficHistory.heatmapTitle')}
 </h3>

 <div className="relative overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
 {/* Scroll hint gradient for mobile */}
 <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-surface sm:hidden z-10" />
 <div className="min-w-[600px] sm:min-w-0">
 {/* Hour headers */}
 <div className="flex items-center mb-1">
 <div className="w-12 shrink-0" />
 {HOURS.filter(h => h >= 5 && h <= 21).map(h => (
 <div key={h} className={`flex-1 text-center text-xs text-muted font-mono ${!PEAK_HOURS.has(h) ? 'hidden sm:block' : ''}`}>
 {h}
 </div>
 ))}
 </div>

 {/* Day rows */}
 {heatmapData.map(row => (
 <div key={row.dayIdx} className="flex items-center mb-1">
 <div className="w-12 shrink-0 text-xs font-semibold text-subtle">
 {row.dayName}
 </div>
 {row.hours.filter(h => h.hour >= 5 && h.hour <= 21).map(cell => (
 <div
 key={cell.hour}
 className={`flex-1 text-center text-xs font-mono rounded-sm mx-px py-1 cursor-default ${getColorClass(cell.wait)} ${!PEAK_HOURS.has(cell.hour) ? 'hidden sm:block' : ''}`}
 title={`${row.dayName} ${cell.hour}:00 — ${cell.wait} min`}
 >
 {cell.wait > 0 ? cell.wait : ''}
 </div>
 ))}
 </div>
 ))}
 </div>
 </div>

 {/* Legend */}
 <div className="flex items-center gap-2 mt-4 text-xs text-muted">
 <span>{t('trafficHistory.legend')}:</span>
 <span className="px-2 py-0.5 rounded bg-success-subtle text-success">0-5'</span>
 <span className="px-2 py-0.5 rounded bg-warning-subtle text-warning">5-10'</span>
 <span className="px-2 py-0.5 rounded bg-warning-subtle text-warning">10-18'</span>
 <span className="px-2 py-0.5 rounded bg-danger-subtle text-danger">18-25'</span>
 <span className="px-2 py-0.5 rounded bg-danger text-white">25'+</span>
 </div>
 </div>

 {/* Daily comparison */}
 <div className="bg-surface rounded-2xl border border-edge p-4">
 <h3 className="text-base font-semibold text-body mb-4">
 {t('trafficHistory.morningRush')} (7:00–9:00)
 </h3>
 <div className="space-y-2">
 {analysis.dayAverages.filter(d => d.day >= 1 && d.day <= 5).map((d, i) => (
 <div key={d.day} className="flex items-center gap-3">
 <span className="w-10 text-sm font-medium text-subtle">{d.name}</span>
 <div className="flex-1 h-6 bg-surface-raised rounded-full overflow-hidden">
 <div
 className={`h-full w-full rounded-full transition-transform ${d.avg > 18 ? 'bg-red-500' : d.avg > 10 ? 'bg-orange-400' : 'bg-emerald-700'}`}
 style={{ transform: `scaleX(${Math.min(d.avg / 30, 1)})`, transformOrigin: 'left' }}
 />
 </div>
 <div className="flex items-center gap-1 w-16 text-right">
 <span className="text-sm font-bold text-body">{d.avg}'</span>
 {i > 0 && getTrendIcon(d.avg, analysis.dayAverages[d.day - 1]?.avg ?? d.avg)}
 </div>
 </div>
 ))}
 </div>
 </div>

 {/* Info notice */}
 <div className="bg-surface-alt/50 border border-edge rounded-xl p-4 flex items-start gap-3">
 <Info size={18} className="text-muted shrink-0 mt-0.5" />
 <p className="text-sm text-muted">
 {dataSource === 'firestore' ? t('trafficHistory.dataNoteReal') : t('trafficHistory.dataNote')}
 </p>
 </div>
 </div>
 );
}
