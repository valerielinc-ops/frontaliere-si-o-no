import React, { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { MUNICIPALITIES, type Municipality } from '@/data/municipalities';
import { MapPin, List, Map, AlertTriangle, Trophy, Medal } from 'lucide-react';

// ── Weight configuration ──
const W_DISTANCE = 0.30;
const W_RENT = 0.25;
const W_IRPEF = 0.20;
const W_POPULATION = 0.15;
const W_FASCIA = 0.10;

type SortKey = 'score' | 'distance' | 'rent' | 'irpef' | 'population';

interface ScoredMunicipality extends Municipality {
 score: number;
 rank: number;
}

function scoreMunicipalities(municipalities: Municipality[]): ScoredMunicipality[] {
 // Find min/max for normalization
 const dists = municipalities.map((m) => m.distanceKm);
 const rents = municipalities.map((m) => m.avgRentMonthly);
 const irpefs = municipalities.map((m) => m.irpefAddizionale);
 const pops = municipalities.map((m) => m.population);

 const minDist = Math.min(...dists), maxDist = Math.max(...dists);
 const minRent = Math.min(...rents), maxRent = Math.max(...rents);
 const minIrpef = Math.min(...irpefs), maxIrpef = Math.max(...irpefs);
 const minPop = Math.min(...pops), maxPop = Math.max(...pops);

 const normalize = (val: number, min: number, max: number) =>
 max === min ? 1 : (val - min) / (max - min);

 const scored = municipalities.map((m) => {
 // Lower is better for distance, rent, irpef → invert
 const distScore = 1 - normalize(m.distanceKm, minDist, maxDist);
 const rentScore = 1 - normalize(m.avgRentMonthly, minRent, maxRent);
 const irpefScore = 1 - normalize(m.irpefAddizionale, minIrpef, maxIrpef);
 // Higher is better for population (more services)
 const popScore = normalize(m.population, minPop, maxPop);
 // Fascia bonus: 1 = 100%, 1A = 60%, 2 = 20%
 const fasciaScore = m.fascia === '1' ? 1 : m.fascia === '1A' ? 0.6 : 0.2;

 const score =
 distScore * W_DISTANCE +
 rentScore * W_RENT +
 irpefScore * W_IRPEF +
 popScore * W_POPULATION +
 fasciaScore * W_FASCIA;

 return { ...m, score: Math.round(score * 100) / 100, rank: 0 };
 });

 scored.sort((a, b) => b.score - a.score);
 scored.forEach((m, i) => (m.rank = i + 1));
 return scored;
}

// Lazy-load Leaflet map
const LeafletMap = React.lazy(() => import('./LivabilityMap'));

export default function LivabilityIndex() {
 const { t } = useTranslation();
 const [filterProvince, setFilterProvince] = useState<string>('');
 const [sortBy, setSortBy] = useState<SortKey>('score');
 const [viewMode, setViewMode] = useState<'table' | 'map'>('table');

 const allScored = useMemo(() => scoreMunicipalities(MUNICIPALITIES), []);

 const provinces = useMemo(
 () => [...new Set(MUNICIPALITIES.map((m) => m.province))].sort(),
 [],
 );

 const filtered = useMemo(() => {
 let list = filterProvince ? allScored.filter((m) => m.province === filterProvince) : allScored;
 if (sortBy !== 'score') {
 list = [...list].sort((a, b) => {
 switch (sortBy) {
 case 'distance': return a.distanceKm - b.distanceKm;
 case 'rent': return a.avgRentMonthly - b.avgRentMonthly;
 case 'irpef': return a.irpefAddizionale - b.irpefAddizionale;
 case 'population': return b.population - a.population;
 default: return b.score - a.score;
 }
 });
 }
 return list;
 }, [allScored, filterProvince, sortBy]);

 const medalColor = (rank: number) => {
 if (rank === 1) return 'text-warning';
 if (rank === 2) return 'text-muted';
 if (rank === 3) return 'text-warning';
 return 'text-muted';
 };

 const scoreBarColor = (score: number) => {
 if (score >= 0.7) return 'bg-success-strong';
 if (score >= 0.5) return 'bg-warning-strong';
 return 'bg-danger-strong';
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-surface rounded-xl shadow-lg p-5">
 <div className="flex items-center gap-3 mb-2">
 <MapPin className="text-warning" size={28} />
 <h2 className="text-2xl font-bold text-heading">{t('livability.title')}</h2>
 </div>
 <p className="text-subtle">{t('livability.subtitle')}</p>
 </div>

 {/* Controls */}
 <div className="bg-neutral-subtle rounded-xl shadow p-5 border border-neutral-border">
 <div className="flex flex-wrap gap-4 items-end">
 {/* Province filter */}
 <div className="flex-1 min-w-[160px]">
 <label htmlFor="li-prov" className="block text-sm font-medium text-body mb-1">
 {t('livability.filterProvince')}
 </label>
 <select
 id="li-prov"
 value={filterProvince}
 onChange={(e) => setFilterProvince(e.target.value)}
 aria-label={t('livability.filterProvince') || 'Filtra per provincia'}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 <option value="">{t('livability.allProvinces')}</option>
 {provinces.map((p) => (
 <option key={p} value={p}>{p}</option>
 ))}
 </select>
 </div>

 {/* Sort */}
 <div className="flex-1 min-w-[160px]">
 <label htmlFor="li-sort" className="block text-sm font-medium text-body mb-1">
 {t('livability.sortBy')}
 </label>
 <select
 id="li-sort"
 value={sortBy}
 onChange={(e) => setSortBy(e.target.value as SortKey)}
 aria-label={t('livability.sortBy') || 'Ordina per'}
 className="w-full rounded-lg border border-edge bg-surface-alt px-3 py-2 text-heading"
 >
 <option value="score">{t('livability.sortScore')}</option>
 <option value="distance">{t('livability.sortDistance')}</option>
 <option value="rent">{t('livability.sortRent')}</option>
 <option value="irpef">{t('livability.irpef')}</option>
 <option value="population">{t('livability.population')}</option>
 </select>
 </div>

 {/* View toggle */}
 <div className="flex gap-1 bg-surface-raised rounded-lg p-1">
 <button
 onClick={() => setViewMode('table')}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 ${
 viewMode === 'table'
 ? 'bg-surface text-warning shadow'
 : 'text-subtle hover:text-strong'
 }`}
 aria-label={t('livability.table')}
 >
 <List size={16} /> {t('livability.table')}
 </button>
 <button
 onClick={() => setViewMode('map')}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 ${
 viewMode === 'map'
 ? 'bg-surface text-warning shadow'
 : 'text-subtle hover:text-strong'
 }`}
 aria-label={t('livability.map')}
 >
 <Map size={16} /> {t('livability.map')}
 </button>
 </div>
 </div>

 {/* Weight legend */}
 <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
 <span>{t('livability.weightDistance')}</span>
 <span>{t('livability.weightRent')}</span>
 <span>{t('livability.weightIrpef')}</span>
 <span>{t('livability.weightPopulation')}</span>
 <span>{t('livability.weightFascia')}</span>
 </div>
 </div>

 {/* Content */}
 {viewMode === 'table' ? (
 <div className="bg-surface rounded-xl shadow overflow-hidden" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 500px' }}> <div className="overflow-x-auto">
 <table className="w-full text-sm">
 <thead className="bg-surface-alt">
 <tr>
 <th className="py-3 px-4 text-left text-subtle">#</th>
 <th className="py-3 px-4 text-left text-subtle">{t('livability.municipality')}</th>
 <th className="py-3 px-3 text-center text-subtle">{t('livability.province')}</th>
 <th className="py-3 px-3 text-right text-subtle">{t('livability.score')}</th>
 <th className="py-3 px-3 text-right text-subtle">{t('livability.distance')}</th>
 <th className="py-3 px-3 text-right text-subtle">{t('livability.rent')}</th>
 <th className="py-3 px-3 text-right text-subtle">{t('livability.irpef')}</th>
 <th className="py-3 px-3 text-right text-subtle">{t('livability.population')}</th>
 <th className="py-3 px-3 text-center text-subtle">{t('livability.fascia')}</th>
 </tr>
 </thead>
 <tbody>
 {filtered.map((m, idx) => (
 <tr
 key={m.name}
 className={`border-b border-edge/50 ${idx < 3 ? 'bg-warning-subtle' : ''}`}
 >
 <td className="py-2.5 px-4">
 {m.rank <= 3 ? (
 <Trophy size={16} className={medalColor(m.rank)} />
 ) : (
 <span className="text-muted font-mono">{m.rank}</span>
 )}
 </td>
 <td className="py-2.5 px-4 font-medium text-heading">{m.name}</td>
 <td className="py-2.5 px-3 text-center text-subtle">{m.province}</td>
 <td className="py-2.5 px-3 text-right">
 <div className="flex items-center justify-end gap-2">
 <div className="w-16 bg-surface-raised rounded-full h-2 overflow-hidden">
 <div className={`h-full rounded-full ${scoreBarColor(m.score)}`} style={{ width: `${m.score * 100}%` }} />
 </div>
 <span className="font-mono font-bold text-heading w-10 text-right">
 {(m.score * 100).toFixed(0)}
 </span>
 </div>
 </td>
 <td className="py-2.5 px-3 text-right font-mono text-body">
 {m.distanceKm} {t('livability.km')}
 </td>
 <td className="py-2.5 px-3 text-right font-mono text-body">
 € {m.avgRentMonthly}
 </td>
 <td className="py-2.5 px-3 text-right font-mono text-body">
 {m.irpefAddizionale}%
 </td>
 <td className="py-2.5 px-3 text-right font-mono text-body">
 {m.population.toLocaleString()}
 </td>
 <td className="py-2.5 px-3 text-center">
 <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
 m.fascia === '1'
 ? 'bg-success-subtle text-success'
 : m.fascia === '1A'
 ? 'bg-warning-subtle text-warning'
 : 'bg-surface-raised text-muted'
 }`}>
 {m.fascia}
 </span>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 {filtered.length === 0 && (
 <p className="text-center text-muted py-8">
 Nessun risultato per i filtri selezionati
 </p>
 )}
 </div>
 ) : (
 <div className="bg-surface rounded-xl shadow overflow-hidden" style={{ height: '500px' }}>
 <React.Suspense fallback={<div className="flex items-center justify-center h-full text-muted">Loading map…</div>}>
 <LeafletMap municipalities={filtered} />
 </React.Suspense>
 </div>
 )}

 {/* Disclaimer */}
 <div className="flex items-start gap-2 text-xs text-muted">
 <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
 <p>{t('livability.disclaimer')}</p>
 </div>
 </div>
 );
}
