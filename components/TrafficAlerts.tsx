import React, { useState, useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Clock, Car, TrendingUp, RefreshCw, Navigation, CheckCircle2, Map, List } from 'lucide-react';
import { trafficService, type TrafficData } from '../services/trafficService';
import { Analytics } from '../services/analytics';
import { borderCrossings as centralizedCrossings } from '../data/borderCrossings';
import { useTranslation } from '@/services/i18n';

// Map centralized data to local format with coordinates tuple
const borderCrossings = centralizedCrossings.map(c => ({
  ...c,
  coordinates: [c.lat, c.lng] as [number, number],
}));

const STATUS_COLORS: Record<string, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  green: 'traffic.status.green',
  yellow: 'traffic.status.yellow',
  red: 'traffic.status.red',
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

const TrafficAlerts: React.FC = () => {
  const { t } = useTranslation();
  const [trafficData, setTrafficData] = useState<TrafficData[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [viewMode, setViewMode] = useState<'map' | 'list'>('map');
  const [selectedCrossing, setSelectedCrossing] = useState<string | null>(null);

  const loadTrafficData = async () => {
    setLoading(true);
    try {
      const data = await trafficService.getTrafficData();
      setTrafficData(data);
      setLastRefresh(new Date());
      setApiKeyConfigured(trafficService.hasApiKey());
      Analytics.trackTrafficAlerts('refresh');
    } catch (error) {
      console.error('Error loading traffic data:', error);
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

  const sortedTraffic = useMemo(
    () => [...trafficData].sort((a, b) => a.waitTimeMinutes - b.waitTimeMinutes),
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
      .sort((a, b) => a.traffic.waitTimeMinutes - b.traffic.waitTimeMinutes);
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
      <div className="bg-gradient-to-br from-orange-600 to-red-700 rounded-2xl p-8 text-white">
        <div className="flex items-center gap-3 mb-4">
          <Car size={32} />
          <h2 className="text-3xl font-extrabold">{t('traffic.title')}</h2>
        </div>
        <p className="text-orange-100 text-lg">
          {t('traffic.subtitle')}
        </p>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('map')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  viewMode === 'map'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-white'
                }`}
              >
                <Map size={14} /> {t('traffic.viewMap')}
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  viewMode === 'list'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-800 dark:hover:text-white'
                }`}
              >
                <List size={14} /> {t('traffic.viewList')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-slate-500" />
              <span className="text-sm text-slate-600 dark:text-slate-400">
                {lastRefresh.toLocaleTimeString('it-IT')}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-emerald-500 inline-block"></span> {t('traffic.status.green')}</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-500 inline-block"></span> {t('traffic.status.yellow')}</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span> {t('traffic.status.red')}</span>
            </div>
            <button
              onClick={loadTrafficData}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              {t('traffic.refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className={`border-l-4 p-3 rounded-lg ${
        apiKeyConfigured
          ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500'
          : 'bg-blue-50 dark:bg-blue-950/30 border-blue-500'
      }`}>
        <div className="flex items-center gap-2 text-sm">
          {apiKeyConfigured ? (
            <CheckCircle2 className="text-emerald-600 flex-shrink-0" size={16} />
          ) : (
            <AlertTriangle className="text-blue-600 flex-shrink-0" size={16} />
          )}
          <span className={apiKeyConfigured ? 'text-emerald-800 dark:text-emerald-200' : 'text-blue-800 dark:text-blue-200'}>
            {apiKeyConfigured
              ? t('traffic.dataReal')
              : t('traffic.dataSimulated')}
          </span>
        </div>
      </div>

      {/* Quick stats */}
      {fastest && slowest && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 dark:from-emerald-950/30 dark:to-green-950/30 rounded-xl border border-emerald-200 dark:border-emerald-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp size={18} className="text-emerald-600" />
              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">{t('traffic.fastest')}</span>
            </div>
            <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100">{fastest.crossingName}</p>
            <p className="text-2xl font-extrabold text-emerald-600">{fastest.waitTimeMinutes} min</p>
          </div>
          <div className="bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-xl border border-red-200 dark:border-red-800 p-4">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={18} className="text-red-600" />
              <span className="text-xs font-bold text-red-700 dark:text-red-400">{t('traffic.slowest')}</span>
            </div>
            <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100">{slowest.crossingName}</p>
            <p className="text-2xl font-extrabold text-red-600">{slowest.waitTimeMinutes} min</p>
          </div>
        </div>
      )}

      {/* MAP VIEW */}
      {viewMode === 'map' && (
        <div className="rounded-2xl overflow-hidden border-2 border-slate-200 dark:border-slate-700 shadow-lg">
          <MapContainer
            center={mapCenter}
            zoom={11}
            style={{ height: '500px', width: '100%' }}
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {borderCrossings.map((crossing) => {
              const traffic = getTrafficForCrossing(crossing.name);
              const status = traffic?.status || 'green';
              const waitTime = traffic?.waitTimeMinutes || 0;

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
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <div
                          style={{ width: '16px', height: '16px', borderRadius: '50%', flexShrink: 0, background: STATUS_COLORS[status] }}
                        />
                        <h3 style={{ fontWeight: 800, fontSize: '16px', margin: 0, color: '#1e293b' }}>{crossing.name}</h3>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>{t('traffic.wait')}</span>
                          <span style={{ fontWeight: 700, color: STATUS_COLORS[status] }}>
                            {waitTime} min — {t(STATUS_LABEL_KEYS[status])}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>{t('traffic.type')}</span>
                          <span style={{ fontWeight: 700, textTransform: 'capitalize' as const }}>{crossing.type}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>{t('traffic.zone')}</span>
                          <span style={{ fontWeight: 700 }}>{crossing.canton} — {crossing.province}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#64748b' }}>{t('traffic.hours')}</span>
                          <span style={{ fontWeight: 700 }}>{crossing.open24h ? '24/7' : t('traffic.limited')}</span>
                        </div>
                        {crossing.customsPresent && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#64748b' }}>{t('traffic.customs')}</span>
                            <span style={{ fontWeight: 700, color: '#2563eb' }}>{t('traffic.customsPresent')}</span>
                          </div>
                        )}
                        {traffic?.direction && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#64748b' }}>{t('traffic.direction')}</span>
                            <span style={{ fontWeight: 700 }}>{traffic.direction}</span>
                          </div>
                        )}
                        {traffic?.source && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#64748b' }}>{t('traffic.source')}</span>
                            <span style={{ fontWeight: 700 }}>
                              {traffic.source === 'google-maps' ? '📍 Google Maps' : `🎲 ${t('traffic.simulated')}`}
                            </span>
                          </div>
                        )}
                      </div>

                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          marginTop: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                          width: '100%',
                          padding: '8px',
                          backgroundColor: '#4f46e5',
                          color: 'white',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 700,
                          textDecoration: 'none',
                        }}
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
          <div className="sm:hidden flex items-center justify-center gap-4 py-3 bg-white dark:bg-slate-800 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-emerald-500 inline-block"></span> {t('traffic.status.green')}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-500 inline-block"></span> {t('traffic.status.yellow')}</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-red-500 inline-block"></span> {t('traffic.status.red')}</span>
          </div>
        </div>
      )}

      {/* LIST VIEW */}
      {viewMode === 'list' && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {allCrossingsWithTraffic.map(({ crossing, traffic }) => {
            const isSelected = selectedCrossing === crossing.name;
            const bgColor = traffic.status === 'green' ? 'bg-emerald-500' : traffic.status === 'yellow' ? 'bg-yellow-500' : 'bg-red-500';
            const borderColor = traffic.status === 'green' ? 'border-emerald-400' : traffic.status === 'yellow' ? 'border-yellow-400' : 'border-red-400';
            const textColor = traffic.status === 'green' ? 'text-emerald-600' : traffic.status === 'yellow' ? 'text-yellow-600' : 'text-red-600';

            return (
              <div
                key={crossing.name}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedCrossing(isSelected ? null : crossing.name)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedCrossing(isSelected ? null : crossing.name); }}
                className={`text-left bg-white dark:bg-slate-800 rounded-xl border-2 p-4 hover:shadow-md transition-all cursor-pointer ${
                  isSelected ? `${borderColor} ring-2 ring-offset-1` : 'border-slate-200 dark:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-10 h-10 ${bgColor} rounded-full flex items-center justify-center text-white font-extrabold text-sm shadow-md`}>
                    {traffic.waitTimeMinutes}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-slate-800 dark:text-slate-100 truncate">{crossing.name}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{crossing.canton} — {crossing.province} · {crossing.type}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className={`text-sm font-bold ${textColor}`}>
                    {t(STATUS_LABEL_KEYS[traffic.status])} — {traffic.waitTimeMinutes} min
                  </span>
                  <span className="text-xs text-slate-400">{traffic.direction}</span>
                </div>

                {isSelected && (
                  <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-500">{t('traffic.hours')}</span>
                      <span className="font-bold">{crossing.open24h ? '24/7' : t('traffic.limited')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">{t('traffic.customs')}</span>
                      <span className="font-bold">{crossing.customsPresent ? t('traffic.yes') : t('traffic.no')}</span>
                    </div>
                    {traffic.source && (
                      <div className="flex justify-between">
                        <span className="text-slate-500">{t('traffic.source')}</span>
                        <span className="font-bold">{traffic.source === 'google-maps' ? '📍 Google Maps' : `🎲 ${t('traffic.simulated')}`}</span>
                      </div>
                    )}
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${crossing.coordinates[0]},${crossing.coordinates[1]}&travelmode=driving`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 flex items-center justify-center gap-1.5 w-full py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors no-underline"
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
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Navigation size={24} className="text-blue-600" />
          {t('traffic.tipsTitle')}
        </h3>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">{t('traffic.tipsBestTimesTitle')}</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
              <li>{t('traffic.tipsMorning')}</li>
              <li>{t('traffic.tipsEvening')}</li>
              <li>{t('traffic.tipsAvoidWeekend')}</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">{t('traffic.tipsAltRoutesTitle')}</p>
            <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-300 list-disc ml-4">
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
