import React, { useState, useMemo, useCallback, useEffect, useDeferredValue } from 'react';
import AvgRentValue from '@/components/shared/AvgRentValue';
import { rentAxisNote } from '@/services/avgRentEstimate';
import { leviesIrpefAddizionale, compareIrpefAddizionaleWithDirection } from '@/services/irpefAddizionaleRegime';
import IrpefAddizionaleValue from '@/components/shared/IrpefAddizionaleValue';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useTranslation } from '@/services/i18n';
import { borderCrossings } from '@/data/borderCrossings';
import { MUNICIPALITIES, findMunicipality, type Municipality } from '@/data/municipalities';
import { calculateMunicipalityTaxImpact, type MunicipalityTaxResult } from '@/services/calculationService';
import { useExchangeRate } from '@/services/exchangeRateService';
import { CircleMarker, Popup } from 'react-leaflet';
import MapCanvas from '@/components/shared/MapCanvas';
import { MapPin, Filter, Info, AlertTriangle, TrendingDown, TrendingUp, ArrowUpDown, Award, DollarSign, Building2, Navigation, ChevronUp, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { MAP_COLORS } from '@/services/mapColors';
import { fetchBorderWaitCurrent, effectiveWaitMinutes, type BorderWaitCurrentSnapshot } from '@/services/borderWaitCurrentService';
import { fmtMinutes, minutesSince } from '@/services/borderWaitFormat';
import { slugifyCrossingName } from '@/services/borderCrossingSlug';
import type { BorderCrossing } from '@/data/borderCrossings';

import type { UserProfileData } from '@/components/pages/UserProfile';

type ColorMode = 'irpef' | 'distance' | 'rent';
type SortField = 'name' | 'tax' | 'addizionale' | 'distance';
type SortDir = 'asc' | 'desc';

interface MunicipalityWithTax extends Municipality {
 taxResult: MunicipalityTaxResult;
}

/** Border crossing marker data merged with its live wait (issue #4892). */
interface BorderCrossingMarker {
 bc: BorderCrossing;
 liveMinutes: number | null;
 liveAgoMinutes: number | null;
}

interface Props {
 userProfile?: UserProfileData | null;
}

// ─── Component ───────────────────────────────────────────────
const BorderMunicipalitiesMap: React.FC<Props> = ({ userProfile }) => {
 const { t, locale } = useTranslation();
 const [colorMode, setColorMode] = useState<ColorMode>('irpef');
 const [selectedMunicipality, setSelectedMunicipality] = useState<Municipality | null>(null);
 const [filterProvince, setFilterProvince] = useState<string>('all');
 const [salary, setSalary] = useState<number>(100000);
 const [sortField, setSortField] = useState<SortField>('tax');
 const [sortDir, setSortDir] = useState<SortDir>('asc');
 const [compareMunicipality, setCompareMunicipality] = useState<string>('');
 const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
 // INP: the salary slider fires onChange on every drag tick, and the province/
 // sort/compare controls each trigger a full re-derive — calculateMunicipalityTaxImpact
 // across every municipality, a re-sort, and a re-render of both the SVG map and the
 // table. Field p75 INP on /vivere-in-ticino/comuni-di-frontiera/ was 944ms (p90 2040ms),
 // the worst surface on the site, equally bad on mobile + desktop (CPU-bound, not network).
 // Defer the inputs that feed those heavy memos so the control itself (slider thumb,
 // dropdown value, sort arrow) repaints instantly while the recompute runs in a
 // non-blocking transition. The deferred values converge within a frame, so the rendered
 // map/table is byte-identical — only the paint is unblocked. Feed these ONLY into the
 // derived memos below, never into the controlled `value=`/active-state reads.
 const deferredSalary = useDeferredValue(salary);
 const deferredFilterProvince = useDeferredValue(filterProvince);
 const deferredSortField = useDeferredValue(sortField);
 const deferredSortDir = useDeferredValue(sortDir);
 const deferredCompareMunicipality = useDeferredValue(compareMunicipality);
 // INP (#4302, field p75 856ms on /guida-frontaliere/mappa-confine/): the
 // mobile (`lg:hidden`) and desktop (`hidden lg:grid`) layouts below each
 // render their OWN map, and Tailwind's responsive classes only
 // toggle CSS `display` — both React-Leaflet map instances (tile layer +
 // every CircleMarker) mounted unconditionally, doubling the real init cost
 // for a map that is only ever visible on one of them. Mount only the one
 // matching the active viewport via MapCanvas `active`; the reserved box
 // keeps its min-height either way, so this does not reintroduce CLS.
 const isDesktopViewport = useMediaQuery('(min-width: 1024px)');
 // Prefill salary from user profile
 useEffect(() => {
 if (userProfile?.grossSalary) {
 const s = parseFloat(userProfile.grossSalary);
 if (!isNaN(s) && s > 0) setSalary(s);
 }
 }, [userProfile]);
 // Live border-wait snapshot (issue #4892): fetched ONCE at mount, outside the
 // slider/filter interaction path — never re-fetched on salary/province/sort
 // changes, so it cannot add synchronous work to those interactions (same INP
 // constraint as the useDeferredValue block above, #4676). fetchBorderWaitCurrent
 // never throws (try/catch/null internally); a failed/absent fetch simply leaves
 // this null and the popup below falls back to the static field, then 'n.d.'.
 const [borderWaitSnapshot, setBorderWaitSnapshot] = useState<BorderWaitCurrentSnapshot | null>(null);
 useEffect(() => {
 let cancelled = false;
 fetchBorderWaitCurrent().then(data => {
 if (!cancelled && data) setBorderWaitSnapshot(data);
 });
 return () => { cancelled = true; };
 }, []);
 // Merge static crossings with the live snapshot ONCE per snapshot change
 // (mount + the single resolve above), not per render — so re-renders
 // triggered by salary/filter/sort interactions reuse this same array
 // reference instead of re-computing the slug lookup for all 143 crossings.
 const borderCrossingsWithLiveWait = useMemo<BorderCrossingMarker[]>(() => {
 const perCrossing = borderWaitSnapshot?.perCrossing;
 return borderCrossings.map(bc => {
 if (!perCrossing) return { bc, liveMinutes: null, liveAgoMinutes: null };
 const entry = perCrossing[slugifyCrossingName(bc.name)];
 const liveMinutes = effectiveWaitMinutes(entry);
 const liveAgoMinutes = liveMinutes !== null ? minutesSince(entry?.lastUpdate) : null;
 return { bc, liveMinutes, liveAgoMinutes };
 });
 }, [borderWaitSnapshot]);
 const provinces = useMemo(() => {
 const set = new Set(MUNICIPALITIES.map(m => m.province));
 return ['all', ...Array.from(set).sort()];
 }, []);

 const { rate: exchangeRate } = useExchangeRate();

 const filtered = useMemo(() => {
 return deferredFilterProvince === 'all' ? MUNICIPALITIES : MUNICIPALITIES.filter(m => m.province === deferredFilterProvince);
 }, [deferredFilterProvince]);

 // Calculate tax for all municipalities
 const municipalitiesWithTax = useMemo<MunicipalityWithTax[]>(() => {
 return filtered.map(m => ({
 ...m,
 taxResult: calculateMunicipalityTaxImpact(deferredSalary, exchangeRate, m.irpefAddizionale, m.fascia),
 }));
 }, [filtered, deferredSalary, exchangeRate]);

 // Sort municipalities
 const sortedMunicipalities = useMemo(() => {
 return [...municipalitiesWithTax].sort((a, b) => {
 if (deferredSortField === 'addizionale') {
 return compareIrpefAddizionaleWithDirection(a, b, deferredSortDir);
 }
 let cmp = 0;
 switch (deferredSortField) {
 case 'name': cmp = a.name.localeCompare(b.name, 'it'); break;
 case 'tax': cmp = a.taxResult.finalItalianTaxEUR - b.taxResult.finalItalianTaxEUR; break;
 case 'distance': cmp = a.distanceKm - b.distanceKm; break;
 }
 return deferredSortDir === 'asc' ? cmp : -cmp;
 });
 }, [municipalitiesWithTax, deferredSortField, deferredSortDir]);

 // User's municipality from profile
 const userMunicipality = useMemo(() => {
 if (userProfile?.municipality) return findMunicipality(userProfile.municipality) || null;
 return null;
 }, [userProfile]);

 // Compare municipality (either from profile or manual selection)
 const compareWith = useMemo(() => {
 if (deferredCompareMunicipality) return findMunicipality(deferredCompareMunicipality) || null;
 return userMunicipality;
 }, [deferredCompareMunicipality, userMunicipality]);

 const compareTaxResult = useMemo(() => {
 if (!compareWith) return null;
 return calculateMunicipalityTaxImpact(deferredSalary, exchangeRate, compareWith.irpefAddizionale, compareWith.fascia);
 }, [compareWith, deferredSalary, exchangeRate]);

 // Cheapest municipality
 const cheapest = useMemo(() => {
 if (municipalitiesWithTax.length === 0) return null;
 return municipalitiesWithTax.reduce((min, m) =>
 m.taxResult.finalItalianTaxEUR < min.taxResult.finalItalianTaxEUR ? m : min
 );
 }, [municipalitiesWithTax]);

 const toggleSort = useCallback((field: SortField) => {
 if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
 else { setSortField(field); setSortDir('asc'); }
 }, [sortField]);

 // Color functions
 const getColor = (m: Municipality): string => {
 switch (colorMode) {
 case 'irpef': {
 // A comune under the no-surcharge regime (Valle d'Aosta, special statute)
 // is not on this scale at all — colouring it green said "cheapest rate"
 // for a tax it does not levy (#4875). Neutral colour + the popup's `n.d.`
 // disclosure instead of the best bucket it never earned.
 if (!leviesIrpefAddizionale(m)) return MAP_COLORS.neutral;
 if (m.irpefAddizionale <= 0.5) return MAP_COLORS.success;
 if (m.irpefAddizionale <= 0.65) return MAP_COLORS.warning;
 return MAP_COLORS.danger;
 }
 case 'distance': {
 if (m.distanceKm <= 5) return MAP_COLORS.success;
 if (m.distanceKm <= 15) return MAP_COLORS.warning;
 return MAP_COLORS.danger;
 }
 case 'rent': {
 if (m.avgRentMonthly <= 500) return MAP_COLORS.success;
 if (m.avgRentMonthly <= 650) return MAP_COLORS.warning;
 return MAP_COLORS.danger;
 }
 }
 };

 const getRadius = (m: Municipality): number => {
 const pop = m.population;
 if (pop > 50000) return 12;
 if (pop > 20000) return 9;
 if (pop > 10000) return 7;
 return 5;
 };

 const center: [number, number] = [46.05, 9.20];

 const formatEUR = (n: number) => Math.round(n).toLocaleString('it-IT');

 return (
 <div className="space-y-4 lg:space-y-6">

 {/* ─── Mobile: compact header + inline filters + map first ── */}
 <div className="lg:hidden space-y-3">
 {/* Compact header */}
 <div className="flex items-center gap-2.5">
 <div className="p-1.5 bg-info-subtle rounded-lg">
 <MapPin className="w-5 h-5 text-info" />
 </div>
 <h2 className="text-lg font-bold font-display text-info">{t('bordermap.title')}</h2>
 </div>

 {/* Inline filter pills + province dropdown */}
 <div className="flex flex-wrap gap-2 items-center">
 {([
 { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
 { mode: 'distance' as const, label: t('bordermap.mode.distance') },
 { mode: 'rent' as const, label: t('bordermap.mode.rent') },
 ]).map(({ mode, label }) => (
 <button
 key={mode}
 onClick={() => setColorMode(mode)}
 className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
 colorMode === mode
 ? 'bg-info-strong text-on-accent'
 : 'bg-surface-raised text-subtle'
 }`}
 >
 {label}
 </button>
 ))}
 {/* The rent axis is a zone-level estimate (#4545 residual 4): 32 distinct
     values across 518 comuni, so the colour bands are far coarser than the
     three-tone scale suggests. Disclosed only while that axis is active. */}
 {colorMode === 'rent' && (
 <p className="w-full text-[11px] leading-4 text-muted mt-1">{rentAxisNote(locale)}</p>
 )}
 <label htmlFor="province-filter-mobile" className="sr-only">{t('bordermap.allProvinces')}</label>
 <select
 id="province-filter-mobile"
 value={filterProvince}
 onChange={(e) => setFilterProvince(e.target.value)}
 className="px-2.5 py-1 rounded-lg text-xs font-bold bg-surface-raised text-subtle border-0"
 >
 {provinces.map(p => (
 <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
 ))}
 </select>
 </div>

 {/* Compact legend */}
 <div className="flex flex-wrap gap-3 text-xs text-subtle">
 <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-success-strong inline-block" /> {colorMode === 'irpef' ? '≤0.5%' : colorMode === 'distance' ? '≤5km' : '≤€500'}</span>
 <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-warning-strong inline-block" /> {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15km' : '€500–650'}</span>
 <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-danger-strong inline-block" /> {colorMode === 'irpef' ? '>0.65%' : colorMode === 'distance' ? '>15km' : '>€650'}</span>
 </div>

 {/* MAP — immediately visible on mobile */}
 <MapCanvas
 center={center}
 zoom={8}
 height="55vh"
 active={isDesktopViewport === false}
 className="rounded-xl overflow-hidden border border-edge"
 >
 {borderCrossingsWithLiveWait.map(({ bc, liveMinutes, liveAgoMinutes }, i) => (
 <CircleMarker
 key={`bc-${i}`}
 center={[bc.lat, bc.lng]}
 radius={4}
 pathOptions={{ color: MAP_COLORS.primaryStroke, fillColor: MAP_COLORS.primary, fillOpacity: 0.9, weight: 2 }}
 >
 <Popup>
 <div className="text-xs">
 <p className="font-bold">{bc.name}</p>
 <p>{bc.type} — {bc.hours}</p>
 {liveMinutes !== null ? (
 <p>
 ⏱ {t('bordermap.liveWait')}: <b>{fmtMinutes(liveMinutes)}</b>
 {liveAgoMinutes !== null && (
 <span className="text-muted"> ({t('bordermap.liveUpdatedAgo', { minutes: liveAgoMinutes })})</span>
 )}
 </p>
 ) : (
 <p>⏱ AM: {bc.avgWaitMorning ?? 'n.d.'}</p>
 )}
 </div>
 </Popup>
 </CircleMarker>
 ))}
 {filtered.map((m, i) => (
 <CircleMarker
 key={`m-${i}`}
 center={[m.lat, m.lng]}
 radius={getRadius(m)}
 pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
 eventHandlers={{ click: () => setSelectedMunicipality(m) }}
 >
 <Popup>
 <div className="text-xs space-y-1 min-w-[180px]">
 <p className="font-bold text-sm">{m.name}</p>
 <p className="text-muted">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
 <hr />
 <p>📊 IRPEF add.: <b><IrpefAddizionaleValue municipality={m} /></b></p>
 <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
 <p>🏠 {t('bordermap.avgRent')}: <b><AvgRentValue municipality={m} suffix="/mese" /></b></p>
 <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
 </div>
 </Popup>
 </CircleMarker>
 ))}
 </MapCanvas>

 {/* Selected municipality card (mobile) */}
 {selectedMunicipality && (
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex items-center justify-between mb-2">
 <h3 className="text-base font-bold text-strong">{selectedMunicipality.name}</h3>
 <span className="text-xs px-2 py-0.5 rounded-full bg-info-subtle text-info font-bold">
 {t('bordermap.fascia')} {selectedMunicipality.fascia}
 </span>
 </div>
 <div className="grid grid-cols-2 gap-3 text-center">
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.mode.irpef')}</p>
 <p className="text-lg font-bold text-strong"><IrpefAddizionaleValue municipality={selectedMunicipality} /></p>
 </div>
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.distCrossing')}</p>
 <p className="text-lg font-bold text-strong">{selectedMunicipality.distanceKm} km</p>
 </div>
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.avgRent')}</p>
 <p className="text-lg font-bold text-strong"><AvgRentValue municipality={selectedMunicipality} /></p>
 </div>
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.pop')}</p>
 <p className="text-lg font-bold text-strong">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
 </div>
 </div>
 </div>
 )}

 {/* Collapsible settings panel */}
 <button
 type="button"
 onClick={() => setMobileSettingsOpen(v => !v)}
 className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl bg-accent-subtle border border-accent-border text-sm font-bold text-accent"
 aria-expanded={mobileSettingsOpen}
 >
 <span className="flex items-center gap-2">
 <SlidersHorizontal className="w-4 h-4" />
 {t('bordermap.taxImpact')} &amp; {t('bordermap.selectCompare')}
 </span>
 {mobileSettingsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
 </button>

 {mobileSettingsOpen && (
 <div className="space-y-3">
 {/* Salary input */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label htmlFor="salary-input-mobile" className="block text-sm font-bold text-body mb-2">
 {t('bordermap.salary')}
 </label>
 <div className="flex items-center gap-3">
 <input
 type="range"
 min={30000}
 max={250000}
 step={5000}
 value={salary}
 onChange={e => setSalary(Number(e.target.value))}
 className="flex-1 h-2 accent-accent"
 aria-label={t('bordermap.salary')}
 />
 <div className="flex items-center gap-1.5">
 <input
 type="number"
 inputMode="numeric"
 id="salary-input-mobile"
 value={salary}
 onChange={e => {
 const v = Number(e.target.value);
 if (v >= 0 && v <= 500000) setSalary(v);
 }}
 className="w-24 px-2 py-1.5 rounded-lg border border-edge bg-surface-alt text-right font-bold text-strong text-sm"
 min={0}
 max={500000}
 step={1000}
 />
 <span className="text-xs font-bold text-subtle">CHF</span>
 </div>
 </div>
 </div>

 {/* Comparison */}
 <div className={`rounded-xl p-4 border ${compareWith && compareTaxResult ? 'bg-accent-subtle border-accent-border' : 'bg-surface-alt/50 border-edge'}`}>
 <div className="mb-3">
 <label htmlFor="compare-select-mobile" className="flex items-center gap-2 text-sm font-bold text-subtle mb-2">
 <Building2 className="w-4 h-4" />
 {t('bordermap.selectCompare')}
 </label>
 <select
 id="compare-select-mobile"
 value={compareMunicipality || compareWith?.name || ''}
 onChange={e => setCompareMunicipality(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-body"
 >
 <option value="">—</option>
 {MUNICIPALITIES.map(m => (
 <option key={m.name} value={m.name}>{m.name} ({m.province})</option>
 ))}
 </select>
 </div>
 {compareWith && compareTaxResult && (
 <>
 <div className="flex items-center gap-2 mb-2">
 <span className="text-sm font-bold text-accent">
 {t('bordermap.comparison', { municipality: compareWith.name })}
 </span>
 {userMunicipality?.name === compareWith.name && (
 <span className="text-xs px-2 py-0.5 rounded-full bg-accent-subtle text-accent font-bold">
 {t('bordermap.yourMunicipality')}
 </span>
 )}
 </div>
 <div className="grid grid-cols-2 gap-3 text-center">
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.annualTax')}</p>
 <p className="text-lg font-bold text-accent">€{formatEUR(compareTaxResult.finalItalianTaxEUR)}</p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addComunale')}</p>
 <p className="text-lg font-bold text-body"><IrpefAddizionaleValue municipality={compareWith} /></p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addRegionale')}</p>
 <p className="text-lg font-bold text-body">€{formatEUR(compareTaxResult.addizionaleRegionale)}</p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.fascia')}</p>
 <p className="text-lg font-bold text-body">{compareWith.fascia}</p>
 </div>
 </div>
 </>
 )}
 </div>

 {/* Disclaimer */}
 <div className="bg-warning-subtle rounded-xl p-3 border border-warning-border flex items-start gap-2">
 <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
 <p className="text-xs text-warning">{t('bordermap.disclaimer')}</p>
 </div>
 </div>
 )}
 </div>

 {/* ─── Desktop: original 2-column layout ─────────────────── */}
 <div className="hidden lg:grid grid-cols-2 gap-6">
 {/* Left column: settings & info */}
 <div className="space-y-4">
 {/* Header */}
 <div className="bg-gradient-to-br from-info-subtle to-info-subtle rounded-2xl p-6 border border-info-border">
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-info-subtle rounded-xl">
 <MapPin className="w-6 h-6 text-info" />
 </div>
 <h2 className="text-2xl font-bold font-display text-info">{t('bordermap.title')}</h2>
 </div>
 <p className="text-info text-sm">{t('bordermap.subtitle')}</p>
 </div>

 {/* Controls */}
 <div className="bg-surface rounded-xl p-4 border border-edge flex flex-wrap gap-3 items-center">
 <div className="flex items-center gap-2">
 <Filter className="w-4 h-4 text-muted" />
 <span className="text-sm font-bold text-subtle">{t('bordermap.colorBy')}:</span>
 </div>
 {([
 { mode: 'irpef' as const, label: t('bordermap.mode.irpef') },
 { mode: 'distance' as const, label: t('bordermap.mode.distance') },
 { mode: 'rent' as const, label: t('bordermap.mode.rent') },
 ]).map(({ mode, label }) => (
 <button
 key={mode}
 onClick={() => setColorMode(mode)}
 className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
 colorMode === mode
 ? 'bg-info-strong text-on-accent'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {label}
 </button>
 ))}
 {/* The rent axis is a zone-level estimate (#4545 residual 4): 32 distinct
     values across 518 comuni, so the colour bands are far coarser than the
     three-tone scale suggests. Disclosed only while that axis is active. */}
 {colorMode === 'rent' && (
 <p className="w-full text-[11px] leading-4 text-muted mt-1">{rentAxisNote(locale)}</p>
 )}

 <span className="text-edge">|</span>

 <label htmlFor="province-filter" className="sr-only">{t('bordermap.allProvinces')}</label>
 <select
 id="province-filter"
 value={filterProvince}
 onChange={(e) => setFilterProvince(e.target.value)}
 className="px-3 py-1.5 rounded-lg text-xs font-bold bg-surface-raised text-subtle border-0"
 >
 {provinces.map(p => (
 <option key={p} value={p}>{p === 'all' ? t('bordermap.allProvinces') : p}</option>
 ))}
 </select>
 </div>

 {/* Legend */}
 <div className="flex flex-wrap gap-4 text-xs">
 <div className="flex items-center gap-2">
 <div className="w-3 h-3 rounded-full bg-success-strong" />
 <span className="text-subtle">
 {colorMode === 'irpef' ? '≤ 0.5%' : colorMode === 'distance' ? '≤ 5 km' : '≤ €500'}
 </span>
 </div>
 <div className="flex items-center gap-2">
 <div className="w-3 h-3 rounded-full bg-warning-strong" />
 <span className="text-subtle">
 {colorMode === 'irpef' ? '0.5–0.65%' : colorMode === 'distance' ? '5–15 km' : '€500–650'}
 </span>
 </div>
 <div className="flex items-center gap-2">
 <div className="w-3 h-3 rounded-full bg-danger-strong" />
 <span className="text-subtle">
 {colorMode === 'irpef' ? '> 0.65%' : colorMode === 'distance' ? '> 15 km' : '> €650'}
 </span>
 </div>
 <div className="flex items-center gap-1 text-muted">
 <Info className="w-3 h-3" />
 {t('bordermap.sizeByPop')}
 </div>
 </div>

 {/* ─── Tax Impact Section ─────────────────────────────── */}
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl p-6 border border-warning-border">
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-warning-subtle rounded-xl">
 <DollarSign className="w-6 h-6 text-warning" />
 </div>
 <h2 className="text-2xl font-bold font-display text-warning">{t('bordermap.taxImpact')}</h2>
 </div>
 <p className="text-warning text-sm">{t('bordermap.taxImpactDesc')}</p>
 </div>

 {/* Salary input */}
 <div className="bg-surface rounded-xl p-5 border border-edge">
 <label htmlFor="salary-input" className="block text-sm font-bold text-body mb-3">
 {t('bordermap.salary')}
 </label>
 <div className="flex items-center gap-4">
 <input
 type="range"
 min={30000}
 max={250000}
 step={5000}
 value={salary}
 onChange={e => setSalary(Number(e.target.value))}
 className="flex-1 h-2 accent-accent"
 aria-label={t('bordermap.salary')}
 />
 <div className="flex items-center gap-2">
 <input
 type="number"
 inputMode="numeric"
 id="salary-input"
 value={salary}
 onChange={e => {
 const v = Number(e.target.value);
 if (v >= 0 && v <= 500000) setSalary(v);
 }}
 className="w-32 px-3 py-2 rounded-lg border border-edge bg-surface-alt text-right font-bold text-strong text-sm"
 min={0}
 max={500000}
 step={1000}
 />
 <span className="text-sm font-bold text-subtle">CHF</span>
 </div>
 </div>
 <div className="flex justify-between text-xs text-muted mt-1 px-1">
 <span>30k</span>
 <span>100k</span>
 <span>150k</span>
 <span>200k</span>
 <span>250k</span>
 </div>
 </div>

 {/* Comparison banner */}
 <div className={`rounded-xl p-4 border ${compareWith && compareTaxResult ? 'bg-accent-subtle border-accent-border' : 'bg-surface-alt/50 border-edge'}`}>
 <div className="mb-3">
 <label htmlFor="compare-select" className="flex items-center gap-2 text-sm font-bold text-subtle mb-2">
 <Building2 className="w-4 h-4" />
 {t('bordermap.selectCompare')}
 </label>
 <select
 id="compare-select"
 value={compareMunicipality || compareWith?.name || ''}
 onChange={e => setCompareMunicipality(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-body"
 >
 <option value="">—</option>
 {MUNICIPALITIES.map(m => (
 <option key={m.name} value={m.name}>{m.name} ({m.province})</option>
 ))}
 </select>
 </div>
 {compareWith && compareTaxResult && (
 <>
 <div className="flex items-center gap-2 mb-2">
 <span className="text-sm font-bold text-accent">
 {t('bordermap.comparison', { municipality: compareWith.name })}
 </span>
 {userMunicipality?.name === compareWith.name && (
 <span className="text-xs px-2 py-0.5 rounded-full bg-accent-subtle text-accent font-bold">
 {t('bordermap.yourMunicipality')}
 </span>
 )}
 </div>
 <div className="grid grid-cols-2 gap-3 text-center">
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.annualTax')}</p>
 <p className="text-lg font-bold text-accent">€{formatEUR(compareTaxResult.finalItalianTaxEUR)}</p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addComunale')}</p>
 <p className="text-lg font-bold text-body"><IrpefAddizionaleValue municipality={compareWith} /></p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addRegionale')}</p>
 <p className="text-lg font-bold text-body">€{formatEUR(compareTaxResult.addizionaleRegionale)}</p>
 </div>
 <div className="p-2 bg-surface rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.fascia')}</p>
 <p className="text-lg font-bold text-body">{compareWith.fascia}</p>
 </div>
 </div>
 </>
 )}
 </div>

 {/* Info box */}
 <div className="bg-warning-subtle rounded-xl p-4 border border-warning-border flex items-start gap-3">
 <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
 <p className="text-xs text-warning">{t('bordermap.disclaimer')}</p>
 </div>
 </div>

 {/* Right column: map & selected detail */}
 <div className="space-y-4">
 {/* Map */}
 <MapCanvas
 center={center}
 zoom={8}
 minHeight={500}
 active={isDesktopViewport === true}
 className="rounded-xl overflow-hidden border border-edge"
 >
 {borderCrossingsWithLiveWait.map(({ bc, liveMinutes, liveAgoMinutes }, i) => (
 <CircleMarker
 key={`bc-${i}`}
 center={[bc.lat, bc.lng]}
 radius={4}
 pathOptions={{ color: MAP_COLORS.primaryStroke, fillColor: MAP_COLORS.primary, fillOpacity: 0.9, weight: 2 }}
 >
 <Popup>
 <div className="text-xs">
 <p className="font-bold">{bc.name}</p>
 <p>{bc.type} — {bc.hours}</p>
 {liveMinutes !== null ? (
 <p>
 ⏱ {t('bordermap.liveWait')}: <b>{fmtMinutes(liveMinutes)}</b>
 {liveAgoMinutes !== null && (
 <span className="text-muted"> ({t('bordermap.liveUpdatedAgo', { minutes: liveAgoMinutes })})</span>
 )}
 </p>
 ) : (
 <p>⏱ AM: {bc.avgWaitMorning ?? 'n.d.'}</p>
 )}
 </div>
 </Popup>
 </CircleMarker>
 ))}
 {filtered.map((m, i) => (
 <CircleMarker
 key={`m-${i}`}
 center={[m.lat, m.lng]}
 radius={getRadius(m)}
 pathOptions={{ color: getColor(m), fillColor: getColor(m), fillOpacity: 0.6, weight: 2 }}
 eventHandlers={{ click: () => setSelectedMunicipality(m) }}
 >
 <Popup>
 <div className="text-xs space-y-1 min-w-[180px]">
 <p className="font-bold text-sm">{m.name}</p>
 <p className="text-muted">{m.province} — {t('bordermap.fascia')} {m.fascia}</p>
 <hr />
 <p>📊 IRPEF add.: <b><IrpefAddizionaleValue municipality={m} /></b></p>
 <p>📏 {t('bordermap.distCrossing')}: <b>{m.distanceKm} km</b></p>
 <p>🏠 {t('bordermap.avgRent')}: <b><AvgRentValue municipality={m} suffix="/mese" /></b></p>
 <p>👥 {t('bordermap.pop')}: <b>{m.population.toLocaleString('it-IT')}</b></p>
 </div>
 </Popup>
 </CircleMarker>
 ))}
 </MapCanvas>

 {/* Selected municipality detail card */}
 {selectedMunicipality && (
 <div className="bg-surface rounded-xl p-5 border border-edge">
 <div className="flex items-center justify-between mb-3">
 <h3 className="text-lg font-bold font-display text-strong">{selectedMunicipality.name}</h3>
 <span className="text-xs px-2 py-1 rounded-full bg-info-subtle text-info font-bold">
 {t('bordermap.fascia')} {selectedMunicipality.fascia}
 </span>
 </div>
 <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
 <div className="p-3 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.mode.irpef')}</p>
 <p className="text-xl font-bold text-strong"><IrpefAddizionaleValue municipality={selectedMunicipality} /></p>
 </div>
 <div className="p-3 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.distCrossing')}</p>
 <p className="text-xl font-bold text-strong">{selectedMunicipality.distanceKm} km</p>
 </div>
 <div className="p-3 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.avgRent')}</p>
 <p className="text-xl font-bold text-strong"><AvgRentValue municipality={selectedMunicipality} /></p>
 </div>
 <div className="p-3 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.pop')}</p>
 <p className="text-xl font-bold text-strong">{selectedMunicipality.population.toLocaleString('it-IT')}</p>
 </div>
 </div>
 </div>
 )}
 </div>
 </div>

 {/* ─── Bottom section: full-width, 3 columns ───────── */}

 {/* Sort controls + count */}
 <div className="flex flex-wrap items-center justify-between gap-3">
 <div className="flex items-center gap-2 flex-wrap">
 <ArrowUpDown className="w-4 h-4 text-muted" />
 <span className="text-sm font-bold text-subtle">{t('bordermap.sortBy')}:</span>
 {([
 { field: 'name' as const, label: t('bordermap.sortName') },
 { field: 'tax' as const, label: t('bordermap.sortTax') },
 { field: 'addizionale' as const, label: t('bordermap.sortAddizionale') },
 { field: 'distance' as const, label: t('bordermap.sortDistance') },
 ]).map(({ field, label }) => (
 <button
 key={field}
 onClick={() => toggleSort(field)}
 className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1 ${
 sortField === field
 ? 'bg-accent-strong text-on-accent'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {label}
 {sortField === field && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
 </button>
 ))}
 </div>
 <span className="text-sm text-muted">{t('bordermap.municipalities', { count: String(sortedMunicipalities.length) })}</span>
 </div>

 {/* Municipality cards */}
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
 {sortedMunicipalities.map(m => {
 const delta = compareTaxResult ? m.taxResult.finalItalianTaxEUR - compareTaxResult.finalItalianTaxEUR : null;
 const isCheapest = cheapest && m.name === cheapest.name;
 const isCampione = m.name ==="Campione d'Italia";

 return (
 <div
 key={m.name}
 className={`bg-surface rounded-xl p-4 border transition-shadow hover:shadow-md ${
 isCheapest
 ? 'border-success-border ring-1 ring-success-border'
 : compareWith?.name === m.name
 ? 'border-accent-border ring-1 ring-accent-border'
 : 'border-edge'
 }`}
 >
 {/* Card header */}
 <div className="flex items-start justify-between mb-3">
 <div>
 <h4 className="font-bold text-strong">{m.name}</h4>
 <div className="flex items-center gap-2 mt-0.5 flex-wrap">
 <span className="text-xs px-1.5 py-0.5 rounded bg-surface-raised text-subtle font-bold">{m.province}</span>
 <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${
 m.fascia === '2'
 ? 'bg-warning-subtle text-warning'
 : 'bg-info-subtle text-info'
 }`}>
 {t('bordermap.fascia')} {m.fascia}
 </span>
 {isCheapest && (
 <span className="text-xs px-1.5 py-0.5 rounded bg-success-subtle text-success font-bold inline-flex items-center gap-0.5">
 <Award className="w-3 h-3" /> {t('bordermap.cheapest')}
 </span>
 )}
 </div>
 </div>
 <div className="text-right shrink-0">
 <p className="text-2xl font-bold text-accent">€{formatEUR(m.taxResult.finalItalianTaxEUR)}</p>
 <p className="text-sm text-muted">{t('bordermap.annualTax')}</p>
 </div>
 </div>

 {/* Tax details */}
 <div className="grid grid-cols-2 gap-2 mb-3">
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addComunale')}</p>
 <p className="text-sm font-bold text-body"><IrpefAddizionaleValue municipality={m} /> <span className="text-xs font-normal text-muted">(€{formatEUR(m.taxResult.addizionaleComunale)})</span></p>
 </div>
 <div className="p-2 bg-surface-alt rounded-lg">
 <p className="text-sm text-muted">{t('bordermap.addRegionale')}</p>
 <p className="text-sm font-bold text-body">€{formatEUR(m.taxResult.addizionaleRegionale)}</p>
 </div>
 </div>

 {/* Extra info row */}
 <div className="flex items-center gap-4 text-xs text-muted mb-3">
 <span className="inline-flex items-center gap-1"><Navigation className="w-3 h-3" /> {m.distanceKm} km</span>
 <span>🏠 <AvgRentValue municipality={m} suffix="/m" /></span>
 <span>👥 {m.population.toLocaleString('it-IT')}</span>
 </div>

 {/* Fascia note — franchigia applies to all fascia (Art. 1 c.175 L.147/2013) */}
 <p className="text-xs text-info mb-2">✓ {t('bordermap.withFranchigia', { fascia: m.fascia })}</p>

 {/* Campione special note */}
 {isCampione && (
 <p className="text-xs text-link italic mb-2">ℹ️ {t('bordermap.campione')}</p>
 )}

 {/* Delta vs comparison municipality */}
 {delta !== null && compareWith?.name !== m.name && (
 <div className={`flex items-center gap-1 text-sm font-bold rounded-lg px-3 py-2 ${
 delta < 0
 ? 'bg-success-subtle text-success'
 : delta > 0
 ? 'bg-danger-subtle text-danger'
 : 'bg-surface-alt text-subtle'
 }`}>
 {delta < 0 ? (
 <><TrendingDown className="w-4 h-4" /> {t('bordermap.saving')}: €{formatEUR(Math.abs(delta))}{t('bordermap.perYear')}</>
 ) : delta > 0 ? (
 <><TrendingUp className="w-4 h-4" /> {t('bordermap.extraCost')}: +€{formatEUR(delta)}{t('bordermap.perYear')}</>
 ) : (
 <span>=</span>
 )}
 <span className="text-xs font-normal ml-1">{t('bordermap.vsMunicipality', { name: compareWith?.name || '' })}</span>
 </div>
 )}
 {compareWith?.name === m.name && (
 <div className="flex items-center gap-1 text-sm font-bold rounded-lg px-3 py-2 bg-accent-subtle text-accent">
 <Building2 className="w-4 h-4" /> {t('bordermap.yourMunicipality')}
 </div>
 )}
 </div>
 );
 })}
 </div>
 </div>
 );
};

export default React.memo(BorderMunicipalitiesMap);
