import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Clock, Car, TrendingUp, RefreshCw, Navigation, CheckCircle2, Filter, ExternalLink } from 'lucide-react';
import Callout from '@/components/shared/Callout';
import { trafficService, hasLiveTrafficData, type TrafficData } from '../../services/trafficService';
import { Analytics } from '../../services/analytics';
import { borderCrossings as centralizedCrossings } from '../../data/borderCrossings';
import { useTranslation } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';
import { MAP_COLORS } from '@/services/mapColors';

const borderCrossings = centralizedCrossings.map(c => ({
 ...c,
 coordinates: [c.lat, c.lng] as [number, number],
}));

const STATUS_COLORS: Record<string, string> = {
 green: MAP_COLORS.success,
 yellow: MAP_COLORS.warning,
 red: MAP_COLORS.danger,
};

const STATUS_BG_CLASSES: Record<string, string> = {
 green: 'bg-success-subtle text-success',
 yellow: 'bg-warning-subtle text-warning',
 red: 'bg-danger-subtle text-danger',
};

const STATUS_DOT_CLASSES: Record<string, string> = {
 green: 'bg-success-strong',
 yellow: 'bg-warning-strong',
 red: 'bg-danger-strong',
};

const STATUS_TEXT_CLASSES: Record<string, string> = {
 green: 'text-success',
 yellow: 'text-warning',
 red: 'text-danger',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
 green: 'traffic.status.green',
 yellow: 'traffic.status.yellow',
 red: 'traffic.status.red',
};

const POPUP_HEADER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' };
const POPUP_DOT_STYLE: React.CSSProperties = { width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0 };
const POPUP_TITLE_STYLE: React.CSSProperties = { margin: 0 };
const POPUP_BODY_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px' };
const POPUP_ROW_STYLE: React.CSSProperties = { display: 'flex', justifyContent: 'space-between' };
const POPUP_CAPITALIZE_STYLE: React.CSSProperties = { textTransform: 'capitalize' };
const POPUP_NAV_LINK_STYLE: React.CSSProperties = {
 marginTop: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
 gap: '6px', width: '100%', padding: '8px', backgroundColor: MAP_COLORS.accent,
 color: 'white', borderRadius: '8px', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
};

const createTrafficIcon = (status: 'green' | 'yellow' | 'red', waitTime: number) => {
 const color = STATUS_COLORS[status];
 const size = status === 'red' ? 42 : status === 'yellow' ? 36 : 30;
 return L.divIcon({
 className: 'traffic-marker',
 html: `
 <div style="
 width: ${size}px; height: ${size}px;
 background: ${color};
 border: 3px solid white;
 border-radius: 50%;
 box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 2px ${color}40;
 display: flex; align-items: center; justify-content: center;
 color: white; font-weight: 800; font-size: ${size > 36 ? 14 : 12}px;
 font-family: system-ui;
 ${status === 'red' ? 'animation: pulse 2s infinite;' : ''}
">${waitTime}</div>
 `,
 iconSize: [size, size],
 iconAnchor: [size / 2, size / 2],
 popupAnchor: [0, -size / 2 - 4],
 });
};

function slugifyCrossingName(name: string): string {
 return name
 .normalize('NFKD')
 .replace(/[̀-ͯ]/g, '')
 .replace(/\([^)]*\)/g, '')
 .replace(/[^a-zA-Z0-9]+/g, '-')
 .replace(/-+/g, '-')
 .replace(/^-|-$/g, '')
 .toLowerCase();
}

function effectiveWait(t: TrafficData): number {
 return t.totalCrossingMinutes ?? t.waitTimeMinutes;
}

function effectiveStatus(t: TrafficData): 'green' | 'yellow' | 'red' {
 const mins = effectiveWait(t);
 if (mins < 5) return 'green';
 if (mins < 15) return 'yellow';
 return 'red';
}

interface TrafficAlertsProps {
 initialCrossingId?: string;
}

const TrafficAlerts: React.FC<TrafficAlertsProps> = ({ initialCrossingId }) => {
 const { t } = useTranslation();
 const [trafficData, setTrafficData] = useState<TrafficData[]>([]);
 const [loading, setLoading] = useState(false);
 const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
 const [liveTrafficAvailable, setLiveTrafficAvailable] = useState(false);
 const [selectedCrossing, setSelectedCrossing] = useState<string | null>(null);
 const [filterRegion, setFilterRegion] = useState<'all' | 'CO' | 'VA'>('all');

 const loadTrafficData = async () => {
 setLoading(true);
 try {
 const data = await trafficService.getTrafficData();
 setTrafficData(data);
 setLastRefresh(new Date());
 setLiveTrafficAvailable(hasLiveTrafficData(data));
 Analytics.trackTrafficAlerts('refresh');
 } catch (error) {
 console.error('Error loading traffic data:', error);
 reportCaughtError(error, 'trafficAlerts.loadData');
 } finally {
 setLoading(false);
 }
 };

 useEffect(() => {
 loadTrafficData();
 Analytics.trackTrafficAlerts('view');
 const interval = setInterval(() => loadTrafficData(), 60 * 60 * 1000);
 return () => clearInterval(interval);
 }, []);

 useEffect(() => {
 if (!initialCrossingId) return;
 const match = borderCrossings.find((c) => slugifyCrossingName(c.name) === initialCrossingId);
 if (!match) return;
 setSelectedCrossing(match.name);
 requestAnimationFrame(() => {
 const el = document.getElementById(`crossing-${initialCrossingId}`);
 el?.scrollIntoView({ block: 'start', behavior: 'auto' });
 });
 }, [initialCrossingId]);

 const sortedTraffic = useMemo(
 () => [...trafficData].sort((a, b) => effectiveWait(a) - effectiveWait(b)),
 [trafficData]
 );

 const allCrossingsWithTraffic = useMemo(() => {
 return borderCrossings
 .filter(c => c.trafficLevel !== 'closed')
 .map(c => {
 const traffic = trafficData.find(t => t.crossingName === c.name);
 return {
 crossing: c,
 traffic: traffic || {
 crossingName: c.name,
 waitTimeMinutes: 0,
 status: 'green' as const,
 direction: 'N/A',
 lastUpdate: new Date(),
 source: 'mock' as const,
 },
 };
 })
 .sort((a, b) => effectiveWait(a.traffic) - effectiveWait(b.traffic));
 }, [trafficData]);

 const filteredCrossingsWithTraffic = useMemo(() => {
 if (filterRegion === 'all') return allCrossingsWithTraffic;
 return allCrossingsWithTraffic.filter(({ crossing }) => crossing.province === filterRegion);
 }, [allCrossingsWithTraffic, filterRegion]);

 const fastest = sortedTraffic[0];
 const slowest = sortedTraffic[sortedTraffic.length - 1];

 const mapCenter: [number, number] = [45.92, 8.97];

 const getTrafficForCrossing = (name: string) =>
 trafficData.find(t => t.crossingName === name);

 const regionPills = (
 <div className="flex flex-wrap gap-2 items-center">
 <div className="flex items-center gap-1.5">
 <Filter size={13} className="text-muted" />
 <span className="text-xs font-bold text-subtle">{t('traffic.filterBy')}:</span>
 </div>
 {(['all', 'CO', 'VA'] as const).map((r) => (
 <button
 key={r}
 onClick={() => setFilterRegion(r)}
 className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
 filterRegion === r
 ? 'bg-warning-strong text-on-accent'
 : 'bg-surface-raised text-subtle hover:bg-surface-raised'
 }`}
 >
 {r === 'all' ? t('traffic.regionAll') : r === 'CO' ? 'Ticino–Como' : 'Ticino–Varese'}
 </button>
 ))}
 </div>
 );

 const statusCallout = (
 <Callout
 status={liveTrafficAvailable ? 'success' : 'accent'}
 icon={liveTrafficAvailable ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
 >
 <span className={`text-sm ${liveTrafficAvailable ? 'text-success' : 'text-accent'}`}>
 {liveTrafficAvailable ? t('traffic.dataReal') : t('traffic.dataSimulated')}
 </span>
 </Callout>
 );

 const legend = (
 <div className="flex items-center justify-center gap-4 text-xs text-muted">
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-success-strong inline-block"></span> {t('traffic.status.green')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-warning-strong inline-block"></span> {t('traffic.status.yellow')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-danger-strong inline-block"></span> {t('traffic.status.red')}</span>
 </div>
 );

 const chiassoEditorial = initialCrossingId?.startsWith('chiasso-') ? (
 <div className="bg-surface rounded-2xl border border-edge p-5 sm:p-6">
 <h3 className="text-lg font-bold font-display text-heading mb-3">
 {t('traffic.chiassoEditorial.title', 'Traffico dogana Chiasso e Brogeda: orari, code e valichi alternativi')}
 </h3>
 <div className="space-y-3 text-sm leading-7 text-body max-w-4xl">
 <p dangerouslySetInnerHTML={{ __html: t('traffic.chiassoEditorial.p1', 'Il valico di <strong>Chiasso Brogeda</strong> è il principale punto di attraversamento merci/autotrasporti sulla A2 e assorbe il traffico pesante fra l’Italia e il Ticino; <strong>Chiasso Strada</strong> (Chiasso Centro) è invece la dogana urbana dedicata alle autovetture sulla vecchia statale del Gaggiolo e si raggiunge dall’uscita autostradale di Como Monte Olimpino. La differenza pratica per il frontaliere è netta: Brogeda ha più corsie ma è intasato dai TIR, Chiasso Centro è più snello ma obbligato dai semafori cittadini di Como e Chiasso.') }} />
 <p dangerouslySetInnerHTML={{ __html: t('traffic.chiassoEditorial.p2', 'Gli <strong>orari di punta</strong> per chi entra in Svizzera sono 7:00–9:00 (mattina, direzione Ticino) e 17:00–19:00 (sera, rientro in Italia). Il venerdì pomeriggio e la domenica sera sommano al traffico pendolare quello turistico: in queste finestre le code a Brogeda arrivano facilmente a 20–30 minuti, a Chiasso Centro a 10–15 minuti. Fuori dalle ore di punta entrambi i valichi sono aperti 24/7 e l’attesa scende sotto i 5 minuti.') }} />
 <p dangerouslySetInnerHTML={{ __html: t('traffic.chiassoEditorial.p3', 'Per <strong>evitare la coda</strong>, i valichi alternativi più usati dai frontalieri in zona Chiasso sono <strong>Ponte Chiasso–Pedrinate</strong> (solo residenti, ma spesso libero), <strong>Bizzarone–Novazzano</strong> (via Gaggiolo, ottimo quando la A2 è intasata) e <strong>Ronago–Novazzano</strong> (piccolo valico secondario, quasi mai congestionato). Se vai verso Lugano e trovi code a Brogeda superiori ai 15 minuti, la deviazione via Novazzano costa 5–8 km in più ma recupera spesso 20–30 minuti di attesa.') }} />
 <p dangerouslySetInnerHTML={{ __html: t('traffic.chiassoEditorial.p4', 'Lo stato del traffico in tempo reale è visibile nella mappa qui sotto (aggiornata ogni ora) e sui portali ufficiali delle dogane svizzere; le webcam lungo la A2 sono accessibili dal sito di Astra per verificare la situazione prima di partire.') }} />
 </div>
 </div>
 ) : null;

 const crossingCards = (
 <>
 {filteredCrossingsWithTraffic.map(({ crossing, traffic }) => {
 const isSelected = selectedCrossing === crossing.name;
 const crossingId = slugifyCrossingName(crossing.name);
 const status = effectiveStatus(traffic);
 const bgColor = status === 'green' ? 'bg-success-strong' : status === 'yellow' ? 'bg-warning-strong' : 'bg-danger-strong';
 const borderColor = status === 'green' ? 'border-success' : status === 'yellow' ? 'border-warning' : 'border-danger';
 const textColor = status === 'green' ? 'text-success' : status === 'yellow' ? 'text-warning' : 'text-danger';

 return (
 <div
 key={crossing.name}
 id={`crossing-${crossingId}`}
 role="button"
 tabIndex={0}
 onClick={() => setSelectedCrossing(isSelected ? null : crossing.name)}
 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedCrossing(isSelected ? null : crossing.name); }}
 className={`text-left bg-surface rounded-xl border-2 p-4 hover:shadow-md transition-[color,background-color,border-color,box-shadow] cursor-pointer ${
 isSelected ? `${borderColor} ring-2 ring-offset-1` : 'border-edge'
 }`}
 >
 <div className="flex items-center gap-3 mb-3">
 <div className={`w-10 h-10 ${bgColor} rounded-full flex items-center justify-center text-on-accent font-bold text-xs shadow-md`}>
 {effectiveWait(traffic)}
 </div>
 <div className="flex-1 min-w-0">
 <h3 className="font-bold text-strong truncate">{crossing.name}</h3>
 <p className="text-sm text-muted">{crossing.canton} — {crossing.province} · {crossing.type}</p>
 </div>
 </div>

 <div className="flex items-center justify-between gap-2">
 <span className={`text-sm font-bold ${textColor}`}>
 {t(STATUS_LABEL_KEYS[status])} — {effectiveWait(traffic)} min
 </span>
 <div className="flex items-center gap-2 shrink-0">
 <span className="text-xs text-muted">{traffic.direction}</span>
 <a
 href={`/guida-frontaliere/tempi-attesa-dogana/${crossingId}/`}
 className="flex items-center gap-1 text-xs text-link hover:underline font-medium no-underline"
 onClick={(e) => e.stopPropagation()}
 aria-label={`${t('traffic.viewCrossingPage')} ${crossing.name}`}
 >
 <ExternalLink size={11} />
 {t('traffic.viewCrossingPage')}
 </a>
 </div>
 </div>

 {isSelected && (
 <div className="mt-3 pt-3 border-t border-edge space-y-1.5 text-sm">
 <div className="flex justify-between">
 <span className="text-muted">{t('traffic.hours')}</span>
 <span className="font-bold">{crossing.open24h ? '24/7' : t('traffic.limited')}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('traffic.customs')}</span>
 <span className="font-bold">{crossing.customsPresent ? t('traffic.yes') : t('traffic.no')}</span>
 </div>
 {traffic.source && traffic.source !== 'mock' && (
 <div className="flex justify-between">
 <span className="text-muted">{t('traffic.source')}</span>
 <span className="font-bold">📍 Google Maps</span>
 </div>
 )}
 <a
 href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`}
 target="_blank"
 rel="noopener noreferrer"
 className="mt-2 flex items-center justify-center gap-1.5 w-full py-2 bg-accent-strong text-on-accent rounded-lg text-xs font-bold hover:bg-accent-strong-hover transition-colors no-underline"
 onClick={(e) => e.stopPropagation()}
 >
 <Navigation size={12} />
 {t('traffic.openGoogleMaps')}
 </a>
 </div>
 )}
 </div>
 );
 })}
 </>
 );

 const tipsSection = (
 <div className="bg-gradient-to-br from-accent-subtle to-accent-subtle rounded-2xl border border-accent-border p-6">
 <h3 className="text-xl font-bold font-display text-strong mb-4 flex items-center gap-2">
 <Navigation size={24} className="text-accent" />
 {t('traffic.tipsTitle')}
 </h3>
 <div className="grid md:grid-cols-2 gap-4">
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-accent mb-2">{t('traffic.tipsBestTimesTitle')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('traffic.tipsMorning')}</li>
 <li>{t('traffic.tipsEvening')}</li>
 <li>{t('traffic.tipsAvoidWeekend')}</li>
 </ul>
 </div>
 <div className="p-4 bg-surface/50 rounded-xl">
 <p className="font-bold text-accent mb-2">{t('traffic.tipsAltRoutesTitle')}</p>
 <ul className="space-y-1 text-sm text-body list-disc ml-4">
 <li>{t('traffic.tipsAvoidChiasso')}</li>
 <li>{t('traffic.tipsTryAlternatives')}</li>
 <li>{t('traffic.tipsLocalCrossings')}</li>
 </ul>
 </div>
 </div>
 </div>
 );

 return (
 <div className="space-y-6 pb-8">
 <style>{`
 @keyframes pulse {
 0%, 100% { transform: scale(1); opacity: 1; }
 50% { transform: scale(1.15); opacity: 0.85; }
 }
 .traffic-marker { background: none !important; border: none !important; }
 `}</style>

 {/* ── MOBILE layout (lg:hidden) ────────────────────────────── */}
 <div className="lg:hidden space-y-3">
 {/* Compact header */}
 <div className="flex items-center gap-2.5">
 <div className="p-1.5 bg-warning-subtle rounded-lg">
 <Car className="w-5 h-5 text-warning" />
 </div>
 <h2 className="text-lg font-bold font-display text-warning">{t('traffic.title')}</h2>
 </div>

 {/* Region filter pills + refresh */}
 <div className="flex flex-wrap gap-2 items-center justify-between">
 {regionPills}
 <button
 onClick={loadTrafficData}
 disabled={loading}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-strong text-on-accent rounded-lg text-xs font-bold hover:bg-accent-strong-hover disabled:opacity-50 transition-colors"
 >
 <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
 {t('traffic.refresh')}
 </button>
 </div>

 {statusCallout}

 {chiassoEditorial}

 {/* Map */}
 <div className="rounded-xl overflow-hidden border border-edge h-[55vh] min-h-[320px]">
 <MapContainer
 center={mapCenter}
 zoom={11}
 style={{ height: '100%', width: '100%' }}
 scrollWheelZoom={true}
 >
 <TileLayer
 attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
 url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
 />
 {borderCrossings.map((crossing) => {
 const traffic = getTrafficForCrossing(crossing.name);
 const status = traffic ? effectiveStatus(traffic) : 'green';
 const waitTime = traffic ? effectiveWait(traffic) : 0;
 return (
 <Marker
 key={crossing.name}
 position={crossing.coordinates}
 icon={createTrafficIcon(status, waitTime)}
 eventHandlers={{ click: () => { setSelectedCrossing(crossing.name); Analytics.trackTrafficAlerts('filter', crossing.name, waitTime); } }}
 >
 <Popup maxWidth={280}>
 <div className="p-1">
 <div style={POPUP_HEADER_STYLE}>
 <div className={`${STATUS_DOT_CLASSES[status]}`} style={POPUP_DOT_STYLE} />
 <h3 className="font-bold text-base text-heading" style={POPUP_TITLE_STYLE}>{crossing.name}</h3>
 </div>
 <div style={POPUP_BODY_STYLE}>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.wait')}</span><span className={`font-bold ${STATUS_TEXT_CLASSES[status]}`}>{waitTime} min — {t(STATUS_LABEL_KEYS[status])}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.type')}</span><span className="font-bold" style={POPUP_CAPITALIZE_STYLE}>{crossing.type}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.zone')}</span><span className="font-bold">{crossing.canton} — {crossing.province}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.hours')}</span><span className="font-bold">{crossing.open24h ? '24/7' : t('traffic.limited')}</span></div>
 {crossing.customsPresent && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.customs')}</span><span className="font-bold text-link">{t('traffic.customsPresent')}</span></div>)}
 {traffic?.direction && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.direction')}</span><span className="font-bold">{traffic.direction}</span></div>)}
 {traffic?.source && traffic.source !== 'mock' && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.source')}</span><span className="font-bold">📍 Google Maps</span></div>)}
 </div>
 <a href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`} target="_blank" rel="noopener noreferrer" style={POPUP_NAV_LINK_STYLE}>{t('traffic.navigateHere')}</a>
 </div>
 </Popup>
 </Marker>
 );
 })}
 </MapContainer>
 </div>

 {legend}

 {/* Crossing list */}
 <div className="space-y-2">
 {crossingCards}
 </div>
 </div>

 {/* ── DESKTOP layout (hidden lg:grid) ──────────────────────── */}
 <div className="hidden lg:grid grid-cols-2 gap-6">
 {/* Left column */}
 <div className="space-y-4">
 {/* Header */}
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl p-6 border border-warning-border">
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-warning-subtle rounded-xl">
 <Car className="w-6 h-6 text-warning" />
 </div>
 <h2 className="text-2xl font-bold font-display text-warning">{t('traffic.title')}</h2>
 </div>
 <p className="text-warning text-sm">{t('traffic.subtitle')}</p>
 </div>

 {statusCallout}

 {/* Quick stats */}
 {fastest && slowest && (
 <div className="grid grid-cols-2 gap-4">
 <div className="bg-gradient-to-br from-success-subtle to-success-subtle rounded-xl border border-success-border p-4">
 <div className="flex items-center gap-2 mb-1">
 <TrendingUp size={18} className="text-success" />
 <span className="text-xs font-bold text-success">{t('traffic.fastest')}</span>
 </div>
 <p className="text-lg font-bold font-display text-strong">{fastest.crossingName}</p>
 <p className="text-2xl font-bold text-success">{effectiveWait(fastest)} min</p>
 </div>
 <div className="bg-gradient-to-br from-danger-subtle to-warning-subtle rounded-xl border border-danger-border p-4">
 <div className="flex items-center gap-2 mb-1">
 <AlertTriangle size={18} className="text-danger" />
 <span className="text-xs font-bold text-danger">{t('traffic.slowest')}</span>
 </div>
 <p className="text-lg font-bold font-display text-strong">{slowest.crossingName}</p>
 <p className="text-2xl font-bold text-danger">{effectiveWait(slowest)} min</p>
 </div>
 </div>
 )}

 {/* Controls bar */}
 <div className="bg-surface rounded-xl p-4 border border-edge flex flex-wrap gap-3 items-center">
 {regionPills}
 <span className="text-edge hidden sm:inline">|</span>
 <div className="flex items-center gap-2 ml-auto">
 <Clock size={14} className="text-muted" />
 <span className="text-xs text-subtle">{lastRefresh.toLocaleTimeString('it-IT')}</span>
 <button
 onClick={loadTrafficData}
 disabled={loading}
 className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-strong text-on-accent rounded-lg text-xs font-bold hover:bg-accent-strong-hover disabled:opacity-50 transition-colors"
 >
 <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
 {t('traffic.refresh')}
 </button>
 </div>
 </div>

 {chiassoEditorial}

 {/* Scrollable crossing list */}
 <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
 {crossingCards}
 </div>
 </div>

 {/* Right column — sticky map */}
 <div className="sticky top-4 space-y-3 self-start">
 <div className="rounded-xl overflow-hidden border-2 border-edge shadow-lg" style={{ height: '70vh', minHeight: '500px' }}>
 <MapContainer
 center={mapCenter}
 zoom={11}
 style={{ height: '100%', width: '100%' }}
 scrollWheelZoom={true}
 >
 <TileLayer
 attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
 url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
 />
 {borderCrossings.map((crossing) => {
 const traffic = getTrafficForCrossing(crossing.name);
 const status = traffic ? effectiveStatus(traffic) : 'green';
 const waitTime = traffic ? effectiveWait(traffic) : 0;
 return (
 <Marker
 key={crossing.name}
 position={crossing.coordinates}
 icon={createTrafficIcon(status, waitTime)}
 eventHandlers={{ click: () => { setSelectedCrossing(crossing.name); Analytics.trackTrafficAlerts('filter', crossing.name, waitTime); } }}
 >
 <Popup maxWidth={280}>
 <div className="p-1">
 <div style={POPUP_HEADER_STYLE}>
 <div className={`${STATUS_DOT_CLASSES[status]}`} style={POPUP_DOT_STYLE} />
 <h3 className="font-bold text-base text-heading" style={POPUP_TITLE_STYLE}>{crossing.name}</h3>
 </div>
 <div style={POPUP_BODY_STYLE}>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.wait')}</span><span className={`font-bold ${STATUS_TEXT_CLASSES[status]}`}>{waitTime} min — {t(STATUS_LABEL_KEYS[status])}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.type')}</span><span className="font-bold" style={POPUP_CAPITALIZE_STYLE}>{crossing.type}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.zone')}</span><span className="font-bold">{crossing.canton} — {crossing.province}</span></div>
 <div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.hours')}</span><span className="font-bold">{crossing.open24h ? '24/7' : t('traffic.limited')}</span></div>
 {crossing.customsPresent && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.customs')}</span><span className="font-bold text-link">{t('traffic.customsPresent')}</span></div>)}
 {traffic?.direction && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.direction')}</span><span className="font-bold">{traffic.direction}</span></div>)}
 {traffic?.source && traffic.source !== 'mock' && (<div style={POPUP_ROW_STYLE}><span className="text-muted">{t('traffic.source')}</span><span className="font-bold">📍 Google Maps</span></div>)}
 </div>
 <a href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`} target="_blank" rel="noopener noreferrer" style={POPUP_NAV_LINK_STYLE}>{t('traffic.navigateHere')}</a>
 </div>
 </Popup>
 </Marker>
 );
 })}
 </MapContainer>
 </div>
 {legend}
 </div>
 </div>

 {tipsSection}
 </div>
 );
};

export default TrafficAlerts;
