import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Clock, Car, TrendingUp, RefreshCw, Navigation, CheckCircle2, Map, List } from 'lucide-react';
import { trafficService, hasLiveTrafficData, type TrafficData } from '../../services/trafficService';
import { Analytics } from '../../services/analytics';
import { borderCrossings as centralizedCrossings } from '../../data/borderCrossings';
import { useTranslation } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';
import { MAP_COLORS } from '@/services/mapColors';

// Map centralized data to local format with coordinates tuple
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

// Hoisted style objects for Leaflet Popup content (avoids new object per render — Vercel rule 5.5)
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
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/\([^)]*\)/g, '')
 .replace(/[^a-zA-Z0-9]+/g, '-')
 .replace(/-+/g, '-')
 .replace(/^-|-$/g, '')
 .toLowerCase();
}

/** Total crossing time when available (includes approach delay), otherwise plain waitTimeMinutes. */
function effectiveWait(t: TrafficData): number {
 return t.totalCrossingMinutes ?? t.waitTimeMinutes;
}

/** Derive status from the value actually displayed to the user (effectiveWait). */
function effectiveStatus(t: TrafficData): 'green' | 'yellow' | 'red' {
 const mins = effectiveWait(t);
 if (mins < 5) return 'green';
 if (mins < 15) return 'yellow';
 return 'red';
}

interface TrafficAlertsProps {
 /** Optional deep-link crossing id (slug). When provided, preselects and scrolls to the crossing. */
 initialCrossingId?: string;
}

const TrafficAlerts: React.FC<TrafficAlertsProps> = ({ initialCrossingId }) => {
 const { t } = useTranslation();
 const [trafficData, setTrafficData] = useState<TrafficData[]>([]);
 const [loading, setLoading] = useState(false);
 const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
 const [liveTrafficAvailable, setLiveTrafficAvailable] = useState(false);
 const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
 const [selectedCrossing, setSelectedCrossing] = useState<string | null>(null);

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
 // Show the list view so the deep-link is meaningful even without interacting with the map.
 setViewMode('list');
 setSelectedCrossing(match.name);
 // Scroll after the list has rendered.
 requestAnimationFrame(() => {
 const el = document.getElementById(`crossing-${initialCrossingId}`);
 el?.scrollIntoView({ block: 'start', behavior: 'auto' });
 });
 }, [initialCrossingId]);

 const sortedTraffic = useMemo(
 () => [...trafficData].sort((a, b) => effectiveWait(a) - effectiveWait(b)),
 [trafficData]
 );

 // Merge: show all non-closed crossings, using traffic data when available
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

 const fastest = sortedTraffic[0];
 const slowest = sortedTraffic[sortedTraffic.length - 1];

 const mapCenter: [number, number] = [45.92, 8.97];

 const getTrafficForCrossing = (name: string) =>
 trafficData.find(t => t.crossingName === name);

 return (
 <div className="space-y-6 pb-8">
 <style>{`
 @keyframes pulse {
 0%, 100% { transform: scale(1); opacity: 1; }
 50% { transform: scale(1.15); opacity: 0.85; }
 }
 .traffic-marker { background: none !important; border: none !important; }
 `}</style>

 {/* Header */}
 <div className="bg-gradient-to-br from-warning-strong to-danger-strong-hover rounded-2xl p-5 sm:p-8 text-on-accent">
 <div className="flex items-center gap-3 mb-4">
 <Car size={32} />
 <h2 className="text-2xl sm:text-3xl font-bold">{t('traffic.title')}</h2>
 </div>
 <p className="text-on-accent text-lg">
 {t('traffic.subtitle')}
 </p>
 </div>

 {/* Controls */}
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <div className="flex items-center justify-between flex-wrap gap-3">
 <div className="flex items-center gap-4">
 <div className="flex bg-surface-raised rounded-lg p-1">
 <button
 onClick={() => setViewMode('map')}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
 viewMode === 'map'
 ? 'bg-accent-strong text-on-accent shadow-sm'
 : 'text-subtle hover:text-strong'
 }`}
 >
 <Map size={14} /> {t('traffic.viewMap')}
 </button>
 <button
 onClick={() => setViewMode('list')}
 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
 viewMode === 'list'
 ? 'bg-accent-strong text-on-accent shadow-sm'
 : 'text-subtle hover:text-strong'
 }`}
 >
 <List size={14} /> {t('traffic.viewList')}
 </button>
 </div>
 <div className="flex items-center gap-2">
 <Clock size={16} className="text-muted" />
 <span className="text-sm text-subtle">
 {lastRefresh.toLocaleTimeString('it-IT')}
 </span>
 </div>
 </div>
 <div className="flex items-center gap-3">
 <div className="hidden sm:flex items-center gap-3 text-xs text-muted">
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-success-strong inline-block"></span> {t('traffic.status.green')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-warning-strong inline-block"></span> {t('traffic.status.yellow')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-danger-strong inline-block"></span> {t('traffic.status.red')}</span>
 </div>
 <button
 onClick={loadTrafficData}
 disabled={loading}
 className="flex items-center gap-2 px-4 py-2 bg-accent-strong text-on-accent rounded-lg hover:bg-accent-strong-hover disabled:opacity-50 transition-colors"
 >
 <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
 {t('traffic.refresh')}
 </button>
 </div>
 </div>
 </div>

 {/* Status */}
 <div className={`border-l-4 p-3 rounded-lg ${
 liveTrafficAvailable
 ? 'bg-success-subtle border-success'
 : 'bg-accent-subtle border-accent'
 }`}>
 <div className="flex items-center gap-2 text-sm">
 {liveTrafficAvailable ? (
 <CheckCircle2 className="text-success flex-shrink-0" size={16} />
 ) : (
 <AlertTriangle className="text-accent flex-shrink-0" size={16} />
 )}
 <span className={liveTrafficAvailable ? 'text-success' : 'text-accent'}>
 {liveTrafficAvailable
 ? t('traffic.dataReal')
 : t('traffic.dataSimulated')}
 </span>
 </div>
 </div>

 {/* Quick stats */}
 {fastest && slowest && (
 <div className="grid grid-cols-2 gap-4">
 <div className="bg-gradient-to-br from-success-subtle to-success-subtle rounded-xl border border-success-border p-4">
 <div className="flex items-center gap-2 mb-1">
 <TrendingUp size={18} className="text-success" />
 <span className="text-xs font-bold text-success">{t('traffic.fastest')}</span>
 </div>
 <p className="text-lg font-bold text-strong">{fastest.crossingName}</p>
 <p className="text-2xl font-bold text-success">{effectiveWait(fastest)} min</p>
 </div>
 <div className="bg-gradient-to-br from-danger-subtle to-warning-subtle rounded-xl border border-danger-border p-4">
 <div className="flex items-center gap-2 mb-1">
 <AlertTriangle size={18} className="text-danger" />
 <span className="text-xs font-bold text-danger">{t('traffic.slowest')}</span>
 </div>
 <p className="text-lg font-bold text-strong">{slowest.crossingName}</p>
 <p className="text-2xl font-bold text-danger">{effectiveWait(slowest)} min</p>
 </div>
 </div>
 )}

 {/* MAP VIEW */}
 {viewMode === 'map' && (
 <div className="rounded-2xl overflow-hidden border-2 border-edge shadow-lg">
 <MapContainer
 center={mapCenter}
 zoom={11}
 style={{ height: 'clamp(240px, 40vh, 500px)', width: '100%' }}
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
 eventHandlers={{
 click: () => {
 setSelectedCrossing(crossing.name);
 Analytics.trackTrafficAlerts('filter', crossing.name, waitTime);
 },
 }}
 >
 <Popup maxWidth={280}>
 <div className="p-1">
 <div style={POPUP_HEADER_STYLE}>
 <div
 className={`${STATUS_DOT_CLASSES[status]}`}
 style={POPUP_DOT_STYLE}
 />
 <h3 className="font-bold text-base text-heading" style={POPUP_TITLE_STYLE}>{crossing.name}</h3>
 </div>

 <div style={POPUP_BODY_STYLE}>
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.wait')}</span>
 <span className={`font-bold ${STATUS_TEXT_CLASSES[status]}`}>
 {waitTime} min — {t(STATUS_LABEL_KEYS[status])}
 </span>
 </div>
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.type')}</span>
 <span className="font-bold" style={POPUP_CAPITALIZE_STYLE}>{crossing.type}</span>
 </div>
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.zone')}</span>
 <span className="font-bold">{crossing.canton} — {crossing.province}</span>
 </div>
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.hours')}</span>
 <span className="font-bold">{crossing.open24h ? '24/7' : t('traffic.limited')}</span>
 </div>
 {crossing.customsPresent && (
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.customs')}</span>
 <span className="font-bold text-link">{t('traffic.customsPresent')}</span>
 </div>
 )}
 {traffic?.direction && (
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.direction')}</span>
 <span className="font-bold">{traffic.direction}</span>
 </div>
 )}
 {traffic?.source && (
 <div style={POPUP_ROW_STYLE}>
 <span className="text-muted">{t('traffic.source')}</span>
 <span className="font-bold">
 {traffic.source === 'mock' ? `🎲 ${t('traffic.simulated')}` : '📍 Google Maps'}
 </span>
 </div>
 )}
 </div>

 <a
 href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`}
 target="_blank"
 rel="noopener noreferrer"
 style={POPUP_NAV_LINK_STYLE}
 >
 {t('traffic.navigateHere')}
 </a>
 </div>
 </Popup>
 </Marker>
 );
 })}
 </MapContainer>

 {/* Mobile legend */}
 <div className="sm:hidden flex items-center justify-center gap-4 py-3 bg-surface text-xs text-muted">
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-success-strong inline-block"></span> {t('traffic.status.green')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-warning-strong inline-block"></span> {t('traffic.status.yellow')}</span>
 <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-danger-strong inline-block"></span> {t('traffic.status.red')}</span>
 </div>
 </div>
 )}

 {/* LIST VIEW */}
 {viewMode === 'list' && (
 <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
 {allCrossingsWithTraffic.map(({ crossing, traffic }) => {
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
 <div className={`w-10 h-10 ${bgColor} rounded-full flex items-center justify-center text-on-accent font-bold text-sm shadow-md`}>
 {effectiveWait(traffic)}
 </div>
 <div className="flex-1 min-w-0">
 <h3 className="font-bold text-strong truncate">{crossing.name}</h3>
 <p className="text-sm text-muted">{crossing.canton} — {crossing.province} · {crossing.type}</p>
 </div>
 </div>

 <div className="flex items-center justify-between">
 <span className={`text-sm font-bold ${textColor}`}>
 {t(STATUS_LABEL_KEYS[status])} — {effectiveWait(traffic)} min
 </span>
 <span className="text-sm text-muted">{traffic.direction}</span>
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
 {traffic.source && (
 <div className="flex justify-between">
 <span className="text-muted">{t('traffic.source')}</span>
 <span className="font-bold">{traffic.source === 'mock' ? `🎲 ${t('traffic.simulated')}` : '📍 Google Maps'}</span>
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
 </div>
 )}

 {/* Tips */}
 <div className="bg-gradient-to-br from-accent-subtle to-accent-subtle rounded-2xl border border-accent-border p-6">
 <h3 className="text-xl font-bold text-strong mb-4 flex items-center gap-2">
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
 </div>
 );
};

export default TrafficAlerts;
