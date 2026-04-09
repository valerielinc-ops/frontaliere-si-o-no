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
    if (rank === 1) return 'text-yellow-500';
    if (rank === 2) return 'text-slate-500 dark:text-slate-400';
    if (rank === 3) return 'text-amber-700';
    return 'text-slate-500 dark:text-slate-400';
  };

  const scoreBarColor = (score: number) => {
    if (score >= 0.7) return 'bg-emerald-700';
    if (score >= 0.5) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-lg p-6">
        <div className="flex items-center gap-3 mb-2">
          <MapPin className="text-amber-600 dark:text-amber-400" size={28} />
          <h2 className="text-2xl font-bold text-slate-800 dark:text-white">{t('livability.title')}</h2>
        </div>
        <p className="text-slate-600 dark:text-slate-400">{t('livability.subtitle')}</p>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow p-4">
        <div className="flex flex-wrap gap-4 items-end">
          {/* Province filter */}
          <div className="flex-1 min-w-[160px]">
            <label htmlFor="li-prov" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('livability.filterProvince')}
            </label>
            <select
              id="li-prov"
              value={filterProvince}
              onChange={(e) => setFilterProvince(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-slate-800 dark:text-white"
            >
              <option value="">{t('livability.allProvinces')}</option>
              {provinces.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Sort */}
          <div className="flex-1 min-w-[160px]">
            <label htmlFor="li-sort" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              {t('livability.sortBy')}
            </label>
            <select
              id="li-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-slate-800 dark:text-white"
            >
              <option value="score">{t('livability.sortScore')}</option>
              <option value="distance">{t('livability.sortDistance')}</option>
              <option value="rent">{t('livability.sortRent')}</option>
              <option value="irpef">{t('livability.irpef')}</option>
              <option value="population">{t('livability.population')}</option>
            </select>
          </div>

          {/* View toggle */}
          <div className="flex gap-1 bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
            <button
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                viewMode === 'table'
                  ? 'bg-white dark:bg-slate-600 text-amber-700 dark:text-amber-400 shadow'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
              }`}
              aria-label={t('livability.table')}
            >
              <List size={16} /> {t('livability.table')}
            </button>
            <button
              onClick={() => setViewMode('map')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                viewMode === 'map'
                  ? 'bg-white dark:bg-slate-600 text-amber-700 dark:text-amber-400 shadow'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white'
              }`}
              aria-label={t('livability.map')}
            >
              <Map size={16} /> {t('livability.map')}
            </button>
          </div>
        </div>

        {/* Weight legend */}
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{t('livability.weightDistance')}</span>
          <span>{t('livability.weightRent')}</span>
          <span>{t('livability.weightIrpef')}</span>
          <span>{t('livability.weightPopulation')}</span>
          <span>{t('livability.weightFascia')}</span>
        </div>
      </div>

      {/* Content */}
      {viewMode === 'table' ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow overflow-hidden" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 500px' }}>          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-700">
                <tr>
                  <th className="py-3 px-4 text-left text-slate-600 dark:text-slate-300">#</th>
                  <th className="py-3 px-4 text-left text-slate-600 dark:text-slate-300">{t('livability.municipality')}</th>
                  <th className="py-3 px-3 text-center text-slate-600 dark:text-slate-300">{t('livability.province')}</th>
                  <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">{t('livability.score')}</th>
                  <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">{t('livability.distance')}</th>
                  <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">{t('livability.rent')}</th>
                  <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">{t('livability.irpef')}</th>
                  <th className="py-3 px-3 text-right text-slate-600 dark:text-slate-300">{t('livability.population')}</th>
                  <th className="py-3 px-3 text-center text-slate-600 dark:text-slate-300">{t('livability.fascia')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, idx) => (
                  <tr
                    key={m.name}
                    className={`border-b border-slate-100 dark:border-slate-700/50 ${idx < 3 ? 'bg-amber-50/30 dark:bg-amber-900/10' : ''}`}
                  >
                    <td className="py-2.5 px-4">
                      {m.rank <= 3 ? (
                        <Trophy size={16} className={medalColor(m.rank)} />
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400 font-mono">{m.rank}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-slate-800 dark:text-white">{m.name}</td>
                    <td className="py-2.5 px-3 text-center text-slate-600 dark:text-slate-400">{m.province}</td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 bg-slate-100 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                          <div className={`h-full rounded-full ${scoreBarColor(m.score)}`} style={{ width: `${m.score * 100}%` }} />
                        </div>
                        <span className="font-mono font-bold text-slate-800 dark:text-white w-10 text-right">
                          {(m.score * 100).toFixed(0)}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                      {m.distanceKm} {t('livability.km')}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                      € {m.avgRentMonthly}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                      {m.irpefAddizionale}%
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700 dark:text-slate-300">
                      {m.population.toLocaleString()}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        m.fascia === '1'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400'
                          : m.fascia === '1A'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-600 dark:text-slate-300'
                      }`}>
                        {m.fascia}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-xl shadow overflow-hidden" style={{ height: '500px' }}>
          <React.Suspense fallback={<div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">Loading map...</div>}>
            <LeafletMap municipalities={filtered} />
          </React.Suspense>
        </div>
      )}

      {/* Disclaimer */}
      <div className="flex items-start gap-2 text-xs text-slate-500 dark:text-slate-400">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        <p>{t('livability.disclaimer')}</p>
      </div>
    </div>
  );
}
