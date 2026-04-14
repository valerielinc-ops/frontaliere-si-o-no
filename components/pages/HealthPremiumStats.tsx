import React, { useEffect, useMemo, useState } from 'react';
import { Heart, TrendingDown, TrendingUp, MapPin, Filter, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import DataFreshness from '@/components/shared/DataFreshness';

interface RankingEntry {
 municipality: string;
 canton: string;
 avgPremium: number;
 numInsurers: number;
}

interface HealthData {
 fetchedAt: string;
 year: number;
 insurers: { id: string; name: string; website: string }[];
 communes: Record<string, { name: string; bfsNr: number; plz: string; region: number }[]>;
 premiums: Record<string, {
 type?: 'canton';
 canton: string;
 region: number | null;
 insurers: Record<string, Record<string, number>>;
 }>;
 rankings: { cheapest: RankingEntry[]; mostExpensive: RankingEntry[] };
}

type SortKey = 'name' | 'avgPremium' | 'numInsurers' | 'canton';

const HealthPremiumStats: React.FC = () => {
 const { t } = useTranslation();
 const [data, setData] = useState<HealthData | null>(null);
 const [cantonFilter, setCantonFilter] = useState<string>('all');
 const [sortKey, setSortKey] = useState<SortKey>('avgPremium');
 const [sortAsc, setSortAsc] = useState(true);
 const [showAll, setShowAll] = useState(false);

 useEffect(() => {
 fetch('/data/health-premiums.json')
 .then(r => r.ok ? r.json() : null)
 .then(d => { if (d) setData(d); })
 .catch(() => {});
 }, []);

 // Build full commune ranking from premiums data
 const allCommunes = useMemo(() => {
 if (!data) return [];
 const result: RankingEntry[] = [];
 type PremiumEntry = HealthData['premiums'][string];
 for (const [key, entry] of Object.entries(data.premiums) as [string, PremiumEntry][]) {
 if (entry.type === 'canton') continue;
 const standardPremiums: number[] = [];
 for (const models of Object.values(entry.insurers) as Record<string, number>[]) {
 if (models.standard) standardPremiums.push(models.standard);
 }
 if (standardPremiums.length === 0) continue;
 const avg = Math.round((standardPremiums.reduce((s, p) => s + p, 0) / standardPremiums.length) * 100) / 100;
 result.push({
 municipality: key,
 canton: entry.canton,
 avgPremium: avg,
 numInsurers: standardPremiums.length,
 });
 }
 return result;
 }, [data]);

 // Canton averages for bar chart
 const cantonAverages = useMemo(() => {
 if (!data) return [];
 const cantonMap: Record<string, { sum: number; count: number }> = {};
 // Use commune data for TI/GR, canton-level for others
 type PremiumEntry = HealthData['premiums'][string];
 for (const [key, entry] of Object.entries(data.premiums) as [string, PremiumEntry][]) {
 const canton = entry.canton || key;
 if (!cantonMap[canton]) cantonMap[canton] = { sum: 0, count: 0 };
 for (const models of Object.values(entry.insurers) as Record<string, number>[]) {
 if (models.standard) {
 cantonMap[canton].sum += models.standard;
 cantonMap[canton].count += 1;
 }
 }
 }
 return Object.entries(cantonMap)
 .map(([canton, { sum, count }]) => ({ canton, avg: Math.round(sum / count) }))
 .sort((a, b) => a.avg - b.avg);
 }, [data]);

 // Filter and sort
 const filtered = useMemo(() => {
 let items = allCommunes;
 if (cantonFilter !== 'all') items = items.filter(c => c.canton === cantonFilter);
 items = [...items].sort((a, b) => {
 let cmp = 0;
 if (sortKey === 'name') cmp = a.municipality.localeCompare(b.municipality);
 else if (sortKey === 'avgPremium') cmp = a.avgPremium - b.avgPremium;
 else if (sortKey === 'numInsurers') cmp = a.numInsurers - b.numInsurers;
 else if (sortKey === 'canton') cmp = a.canton.localeCompare(b.canton);
 return sortAsc ? cmp : -cmp;
 });
 return items;
 }, [allCommunes, cantonFilter, sortKey, sortAsc]);

 const displayed = showAll ? filtered : filtered.slice(0, 50);

 const handleSort = (key: SortKey) => {
 if (sortKey === key) setSortAsc(!sortAsc);
 else { setSortKey(key); setSortAsc(key === 'avgPremium'); }
 };

 if (!data) {
 return (
 <div className="flex items-center justify-center min-h-[300px] text-muted">
 <Heart className="animate-pulse mr-2" size={20} /> Caricamento dati premi...
 </div>
 );
 }

 const maxAvg = cantonAverages.length > 0 ? cantonAverages[cantonAverages.length - 1].avg : 1;

 return (
 <div className="space-y-6 pb-8">
 {/* Header */}
 <div className="bg-gradient-to-br from-rose-600 to-pink-700 rounded-2xl p-4 sm:p-8 text-white">
 <div className="flex items-center gap-3 mb-3">
 <Heart size={28} />
 <h2 className="text-2xl sm:text-3xl font-bold">Premi Cassa Malati per Comune</h2>
 </div>
 <p className="text-rose-100 text-base sm:text-lg">
 Classifica completa dei premi LAMal medi per {allCommunes.length} comuni di Ticino e Grigioni. Dati ufficiali UFSP {data.year}.
 </p>
 <div className="mt-3">
 <DataFreshness lastUpdated={data.fetchedAt.slice(0, 7)} source="Premi UFSP" sourceUrl="https://www.priminfo.admin.ch" variant="badge" />
 </div>
 </div>

 {/* Canton averages bar chart */}
 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider mb-4">
 Premio medio per cantone (standard, adulti 26+)
 </h3>
 <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
 {cantonAverages.map((c, i) => (
 <div key={c.canton} className="flex items-center gap-3 text-xs">
 <span className="w-8 font-bold text-body text-right">{c.canton}</span>
 <div className="flex-1 h-6 bg-surface-raised rounded-full overflow-hidden">
 <div
 className={`h-full rounded-full transition-transform origin-left ${
 i < 5 ? 'bg-emerald-500' : i >= cantonAverages.length - 5 ? 'bg-red-500' : 'bg-stripe-500'
 }`}
 style={{ transform: `scaleX(${Math.max(10, (c.avg / maxAvg) * 100) / 100})` }}
 />
 </div>
 <span className="w-16 text-right font-bold text-body">{c.avg} CHF</span>
 </div>
 ))}
 </div>
 </div>

 {/* Top cheapest / most expensive */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 <div className="bg-success-subtle rounded-2xl p-5 border border-success-border">
 <h3 className="text-sm font-bold text-success uppercase tracking-wider mb-3 flex items-center gap-2">
 <TrendingDown size={16} /> 10 comuni più economici
 </h3>
 <div className="space-y-2">
 {data.rankings.cheapest.slice(0, 10).map((c, i) => (
 <div key={c.municipality} className="flex items-center justify-between text-sm">
 <span className="flex items-center gap-2">
 <span className="w-6 h-6 rounded-full bg-success-subtle text-success flex items-center justify-center text-xs font-bold">{i + 1}</span>
 <span className="text-body">{c.municipality.replace(/^\d+-/, '')}</span>
 <span className="text-muted text-xs">({c.canton})</span>
 </span>
 <span className="font-bold text-success">{c.avgPremium.toFixed(0)} CHF</span>
 </div>
 ))}
 </div>
 </div>
 <div className="bg-danger-subtle rounded-2xl p-5 border border-danger-border">
 <h3 className="text-sm font-bold text-danger uppercase tracking-wider mb-3 flex items-center gap-2">
 <TrendingUp size={16} /> 10 comuni più cari
 </h3>
 <div className="space-y-2">
 {data.rankings.mostExpensive.slice(0, 10).map((c, i) => (
 <div key={c.municipality} className="flex items-center justify-between text-sm">
 <span className="flex items-center gap-2">
 <span className="w-6 h-6 rounded-full bg-danger-subtle text-danger flex items-center justify-center text-xs font-bold">{i + 1}</span>
 <span className="text-body">{c.municipality.replace(/^\d+-/, '')}</span>
 <span className="text-muted text-xs">({c.canton})</span>
 </span>
 <span className="font-bold text-danger">{c.avgPremium.toFixed(0)} CHF</span>
 </div>
 ))}
 </div>
 </div>
 </div>

 {/* Full ranking table */}
 <div className="bg-surface rounded-2xl p-5 border border-edge shadow-sm">
 <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
 <h3 className="text-sm font-bold text-subtle uppercase tracking-wider flex items-center gap-2">
 <MapPin size={16} /> Classifica completa ({filtered.length} comuni)
 </h3>
 <div className="flex items-center gap-2">
 <Filter size={14} className="text-muted" />
 <select
 value={cantonFilter}
 onChange={(e) => setCantonFilter(e.target.value)}
 className="px-3 py-1.5 rounded-lg border border-edge bg-surface-alt text-strong text-xs"
 aria-label="Filtra per cantone"
 >
 <option value="all">Tutti i cantoni</option>
 <option value="TI">Ticino</option>
 <option value="GR">Grigioni</option>
 </select>
 </div>
 </div>

 <div className="overflow-x-auto">
 <table className="w-full text-xs">
 <thead>
 <tr className="border-b-2 border-edge">
 <th className="text-left py-2 px-2 text-subtle font-bold">#</th>
 <th
 className="text-left py-2 px-2 text-subtle font-bold cursor-pointer hover:text-rose-600"
 onClick={() => handleSort('name')}
 >
 Comune {sortKey === 'name' && (sortAsc ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />)}
 </th>
 <th
 className="text-center py-2 px-2 text-subtle font-bold cursor-pointer hover:text-rose-600"
 onClick={() => handleSort('canton')}
 >
 Cantone {sortKey === 'canton' && (sortAsc ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />)}
 </th>
 <th
 className="text-right py-2 px-2 text-subtle font-bold cursor-pointer hover:text-rose-600"
 onClick={() => handleSort('avgPremium')}
 >
 Premio medio {sortKey === 'avgPremium' && (sortAsc ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />)}
 </th>
 <th
 className="text-right py-2 px-2 text-subtle font-bold cursor-pointer hover:text-rose-600"
 onClick={() => handleSort('numInsurers')}
 >
 Assicuratori {sortKey === 'numInsurers' && (sortAsc ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />)}
 </th>
 </tr>
 </thead>
 <tbody>
 {displayed.map((c, i) => {
 const globalRank = filtered.indexOf(c) + 1;
 return (
 <tr key={c.municipality} className="border-b border-edge/50 hover:bg-surface-raised/30">
 <td className="py-2 px-2 text-muted font-mono">{globalRank}</td>
 <td className="py-2 px-2 text-body font-medium">
 {c.municipality.replace(/^\d+-/, '')}
 <span className="text-muted ml-1 text-xs">{c.municipality.match(/^\d+/)?.[0]}</span>
 </td>
 <td className="py-2 px-2 text-center text-muted">{c.canton}</td>
 <td className={`py-2 px-2 text-right font-bold ${
 globalRank <= 10 ? 'text-success' :
 globalRank > filtered.length - 10 ? 'text-danger' :
 'text-body'
 }`}>
 {c.avgPremium.toFixed(0)} CHF
 </td>
 <td className="py-2 px-2 text-right text-muted">{c.numInsurers}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 {filtered.length > 50 && !showAll && (
 <button
 onClick={() => setShowAll(true)}
 className="w-full mt-4 py-2 text-xs font-bold text-danger hover:bg-rose-50 dark:hover:bg-rose-950/20 rounded-lg transition-colors"
 >
 Mostra tutti i {filtered.length} comuni
 </button>
 )}
 </div>

 {/* Source attribution */}
 <div className="text-center text-xs text-muted space-y-1">
 <p>
 Dati ufficiali UFSP/BAG {data.year}. Premi standard, adulti 26+, franchigia 300 CHF, senza copertura infortuni.
 </p>
 <p>
 Fonte: <a href="https://www.priminfo.admin.ch" target="_blank" rel="noopener noreferrer" className="underline">priminfo.admin.ch</a>
 {' · '}
 <a href="https://opendata.swiss/en/dataset/health-insurance-premiums" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-1">
 OpenData Swiss <ExternalLink size={8} />
 </a>
 </p>
 </div>
 </div>
 );
};

export default HealthPremiumStats;
