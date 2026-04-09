/**
 * MorningDashboard — "Buongiorno Frontaliere" personalized morning widget
 *
 * Shows at a glance:
 *  - Weather for Como/Lugano (Open-Meteo API, free, no key)
 *  - Border crossing traffic status (via trafficService)
 *  - CHF-EUR exchange rate (via exchangeRateService)
 *  - Current time in both Italy and Switzerland
 *  - Personalized greeting based on time of day
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, CloudFog, Wind,
  Thermometer, Droplets, ArrowRightLeft, Clock, MapPin, AlertTriangle,
  RefreshCw, Sunrise, Sunset, Navigation, TrendingUp, TrendingDown, Minus,
  ChevronRight, Eye
} from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';
import { useExchangeRate } from '@/services/exchangeRateService';
import { trafficService, type TrafficData } from '@/services/trafficService';
import { borderCrossings } from '@/data/borderCrossings';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import { useAuth, getUserDisplayName } from '@/services/authService';
import { findMunicipality } from '@/data/municipalities';

// ─── Open-Meteo Weather Types ────────────────────────────────

interface WeatherData {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
  isDay: boolean;
}

interface DailyForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
  precipitationProbability: number;
}

interface LocationWeather {
  name: string;
  country: string;
  current: WeatherData;
  daily: DailyForecast[];
  sunrise: string;
  sunset: string;
}

// ─── Weather Helpers ─────────────────────────────────────────

const LOCATIONS = {
  lugano: { lat: 46.0037, lng: 8.9511, name: 'Lugano', country: 'CH' },
  como: { lat: 45.8081, lng: 9.0852, name: 'Como', country: 'IT' },
} as const;

function getWeatherIcon(code: number, isDay: boolean): React.ReactNode {
  // WMO weather codes → icons
  if (code === 0 || code === 1) return <Sun className="w-full h-full text-amber-500" />;
  if (code === 2) return <Cloud className="w-full h-full text-slate-500 dark:text-slate-400" />;
  if (code === 3) return <Cloud className="w-full h-full text-slate-500 dark:text-slate-400" />;
  if (code >= 45 && code <= 48) return <CloudFog className="w-full h-full text-slate-500 dark:text-slate-400" />;
  if (code >= 51 && code <= 55) return <CloudDrizzle className="w-full h-full text-blue-400" />;
  if (code >= 56 && code <= 57) return <CloudDrizzle className="w-full h-full text-blue-300" />;
  if (code >= 61 && code <= 65) return <CloudRain className="w-full h-full text-blue-500" />;
  if (code >= 66 && code <= 67) return <CloudRain className="w-full h-full text-blue-300" />;
  if (code >= 71 && code <= 77) return <CloudSnow className="w-full h-full text-blue-200" />;
  if (code >= 80 && code <= 82) return <CloudRain className="w-full h-full text-blue-600" />;
  if (code >= 85 && code <= 86) return <CloudSnow className="w-full h-full text-blue-300" />;
  if (code >= 95 && code <= 99) return <CloudLightning className="w-full h-full text-amber-400" />;
  return <Sun className="w-full h-full text-amber-500" />;
}

function getWeatherLabel(code: number, t: (key: string) => string): string {
  if (code === 0) return t('morning.weather.clear');
  if (code === 1) return t('morning.weather.mainlyClear');
  if (code === 2) return t('morning.weather.partlyCloudy');
  if (code === 3) return t('morning.weather.overcast');
  if (code >= 45 && code <= 48) return t('morning.weather.fog');
  if (code >= 51 && code <= 57) return t('morning.weather.drizzle');
  if (code >= 61 && code <= 67) return t('morning.weather.rain');
  if (code >= 71 && code <= 77) return t('morning.weather.snow');
  if (code >= 80 && code <= 82) return t('morning.weather.showers');
  if (code >= 85 && code <= 86) return t('morning.weather.snowShowers');
  if (code >= 95 && code <= 99) return t('morning.weather.thunderstorm');
  return t('morning.weather.clear');
}

const WEATHER_CACHE_KEY = 'morning_weather_cache';
const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const PROFILE_STORAGE_KEY = 'frontaliere_user_profile';

async function fetchWeather(loc: { lat: number; lng: number; name: string; country: string }): Promise<LocationWeather | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset&timezone=Europe/Zurich&forecast_days=3`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: loc.name,
      country: loc.country,
      current: {
        temperature: data.current.temperature_2m,
        apparentTemperature: data.current.apparent_temperature,
        humidity: data.current.relative_humidity_2m,
        windSpeed: data.current.wind_speed_10m,
        weatherCode: data.current.weather_code,
        isDay: !!data.current.is_day,
      },
      daily: data.daily.time.map((d: string, i: number) => ({
        date: d,
        tempMax: data.daily.temperature_2m_max[i],
        tempMin: data.daily.temperature_2m_min[i],
        weatherCode: data.daily.weather_code[i],
        precipitationProbability: data.daily.precipitation_probability_max[i],
      })),
      sunrise: data.daily.sunrise[0],
      sunset: data.daily.sunset[0],
    };
  } catch (e) {
    reportCaughtError(e, 'morningDashboard.fetchWeather', { apiEndpoint: 'open-meteo.com' });
    return null;
  }
}

function useWeather() {
  const [weather, setWeather] = useState<{ lugano: LocationWeather | null; como: LocationWeather | null; user: LocationWeather | null }>({ lugano: null, como: null, user: null });
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    // Try cache first
    try {
      const cached = localStorage.getItem(WEATHER_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < WEATHER_CACHE_TTL) {
          setWeather(data);
          setLoading(false);
          return;
        }
      }
    } catch { /* ignore */ }

    // Check user profile for municipality
    let userLocation: { lat: number; lng: number; name: string; country: string } | null = null;
    try {
      const profileStr = localStorage.getItem(PROFILE_STORAGE_KEY);
      if (profileStr) {
        const profile = JSON.parse(profileStr);
        if (profile.municipality) {
          const mun = findMunicipality(profile.municipality);
          if (mun && mun.lat && mun.lng) {
            // Don't fetch user weather if it's the same as Lugano or Como
            const isLugano = Math.abs(mun.lat - LOCATIONS.lugano.lat) < 0.05 && Math.abs(mun.lng - LOCATIONS.lugano.lng) < 0.05;
            const isComo = Math.abs(mun.lat - LOCATIONS.como.lat) < 0.05 && Math.abs(mun.lng - LOCATIONS.como.lng) < 0.05;
            if (!isLugano && !isComo) {
              userLocation = { lat: mun.lat, lng: mun.lng, name: mun.name, country: 'IT' };
            }
          }
        }
      }
    } catch { /* ignore */ }

    const [lugano, como, user] = await Promise.all([
      fetchWeather(LOCATIONS.lugano),
      fetchWeather(LOCATIONS.como),
      userLocation ? fetchWeather(userLocation) : Promise.resolve(null),
    ]);
    const result = { lugano, como, user };
    setWeather(result);
    try {
      localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ data: result, timestamp: Date.now() }));
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  return { weather, loading, refresh: fetchAll };
}

// ─── Greeting ────────────────────────────────────────────────

function getGreeting(t: (key: string) => string): string {
  const h = new Date().getHours();
  if (h < 6) return t('morning.greeting.night');
  if (h < 12) return t('morning.greeting.morning');
  if (h < 18) return t('morning.greeting.afternoon');
  return t('morning.greeting.evening');
}

function getTimeEmoji(): string {
  const h = new Date().getHours();
  if (h < 6) return '🌙';
  if (h < 8) return '🌅';
  if (h < 12) return '☀️';
  if (h < 17) return '🌤️';
  if (h < 20) return '🌇';
  return '🌙';
}

// ─── Component ───────────────────────────────────────────────

const MorningDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const displayName = getUserDisplayName(user);
  const { weather, loading: weatherLoading, refresh: refreshWeather } = useWeather();
  const { rate, loading: rateLoading } = useExchangeRate();
  const [traffic, setTraffic] = useState<TrafficData[]>([]);
  const [trafficLoading, setTrafficLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Fetch traffic data
  useEffect(() => {
    const fetchTraffic = async () => {
      setTrafficLoading(true);
      try {
        const data = await trafficService.getTrafficData();
        setTraffic(data);
      } catch (e) { reportCaughtError(e, 'morningDashboard.fetchTraffic'); }
      setTrafficLoading(false);
    };
    fetchTraffic();
    const interval = setInterval(fetchTraffic, 15 * 60 * 1000); // refresh every 15 min
    return () => clearInterval(interval);
  }, []);

  // Update clock every minute
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Track engagement
  useEffect(() => {
    Analytics.trackComparatorView('morning');
    unlockAchievement('first_visit');
  }, []);

  const greeting = useMemo(() => getGreeting(t), [currentTime, t]);
  const timeEmoji = useMemo(() => getTimeEmoji(), [currentTime]);

  const timeStr = currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const dateStr = currentTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Traffic summary
  const topCrossings = useMemo(() => {
    const openCrossings = borderCrossings.filter(bc => bc.trafficLevel !== 'closed');
    return openCrossings
      .map(bc => {
        const live = traffic.find(t => t.crossingName === bc.name);
        return {
          name: bc.name,
          italianSide: bc.italianSide,
          waitMinutes: live?.totalCrossingMinutes ?? live?.waitTimeMinutes ?? 0,
          status: live?.status ?? (bc.trafficLevel === 'high' ? 'yellow' as const : 'green' as const),
          type: bc.type,
        };
      })
      .sort((a, b) => a.waitMinutes - b.waitMinutes)
      .slice(0, 5);
  }, [traffic]);

  const handleRefresh = useCallback(() => {
    refreshWeather();
    trafficService.clearCache();
    trafficService.getTrafficData().then(setTraffic);
    Analytics.trackUIInteraction('morning_dashboard', 'button', 'refresh', 'click');
  }, [refreshWeather]);

  // Previous close rate for trend indicator
  const prevRate = useMemo(() => {
    try {
      const cached = localStorage.getItem('exchange_rate_cache');
      if (cached) {
        const { rate: r } = JSON.parse(cached);
        return r;
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  return (
    <div className="space-y-6">
      {/* Welcome Back Banner for signed-in users */}
      {user && (
        <div className="bg-gradient-to-r from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 rounded-2xl p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="text-2xl">👋</div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                {t('morning.welcomeBack', { name: displayName })}
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('morning.welcomeSubtitle')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Header — Greeting + Clock */}
      <div className="text-center space-y-2">
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 dark:text-white">
          {timeEmoji} {greeting}
        </h1>
        <div className="flex items-center justify-center gap-3 text-slate-500 dark:text-slate-400">
          <Clock className="w-4 h-4" />
          <span className="text-lg font-medium tabular-nums">{timeStr}</span>
          <span className="text-sm capitalize">{dateStr}</span>
        </div>
        <button
          onClick={handleRefresh}
          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
          aria-label={t('morning.refresh')}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {t('morning.refresh')}
        </button>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

        {/* Weather Card — User's Municipality (if set in profile) */}
        {weather.user && (
          <WeatherCard
            location={weather.user}
            loading={weatherLoading}
            flag="📍"
            t={t}
          />
        )}

        {/* Weather Card — Lugano */}
        <WeatherCard
          location={weather.lugano}
          loading={weatherLoading}
          flag="🇨🇭"
          t={t}
        />

        {/* Weather Card — Como */}
        <WeatherCard
          location={weather.como}
          loading={weatherLoading}
          flag="🇮🇹"
          t={t}
        />

        {/* Exchange Rate Card */}
        <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2 text-sm sm:text-base">
              <ArrowRightLeft className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              {t('morning.exchangeRate')}
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">CHF → EUR</span>
          </div>
          {rateLoading ? (
            <div className="h-16 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white tabular-nums">
                  {rate.toFixed(4)}
                </span>
                {prevRate && Math.abs(rate - prevRate) > 0.0001 && (
                  <span className={`flex items-center gap-0.5 text-xs font-semibold ${rate > prevRate ? 'text-green-600' : 'text-red-600'}`}>
                    {rate > prevRate ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {((rate - prevRate) * 100).toFixed(2)}%
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2 text-center">
                  <div className="text-xs text-slate-500 dark:text-slate-400">100 CHF =</div>
                  <div className="font-bold text-slate-900 dark:text-white">{(100 * rate).toFixed(2)} €</div>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-2 text-center">
                  <div className="text-xs text-slate-500 dark:text-slate-400">1000 CHF =</div>
                  <div className="font-bold text-slate-900 dark:text-white">{(1000 * rate).toFixed(2)} €</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Traffic Section */}
      <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5 space-y-3 sm:space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2 text-sm sm:text-base">
            <Navigation className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            {t('morning.traffic.title')}
          </h3>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {new Date().getHours() < 12 ? 'IT → CH' : 'CH → IT'}
          </span>
        </div>

        {trafficLoading ? (
          <div className="h-20 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {topCrossings.map((crossing) => (
              <div
                key={crossing.name}
                className="flex items-center gap-3 p-2.5 sm:p-3 rounded-xl bg-slate-50 dark:bg-slate-700/40 border border-slate-100 dark:border-slate-600/50"
              >
                <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                  crossing.status === 'green' ? 'bg-green-500' :
                  crossing.status === 'yellow' ? 'bg-amber-500' :
                  'bg-red-500'
                }`} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                    {crossing.name}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {crossing.italianSide}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className={`text-sm font-bold ${
                    crossing.waitMinutes === 0 ? 'text-green-600 dark:text-green-400' :
                    crossing.waitMinutes <= 10 ? 'text-amber-600 dark:text-amber-400' :
                    'text-red-600 dark:text-red-400'
                  }`}>
                    {crossing.waitMinutes > 0
                      ? `~${crossing.waitMinutes} min`
                      : t('morning.traffic.clear')
                    }
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>{t('morning.traffic.top5')}</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> {t('morning.traffic.statusGreen')}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> {t('morning.traffic.statusYellow')}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> {t('morning.traffic.statusRed')}
          </span>
        </div>
      </div>

      {/* Quick Tips */}
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border border-emerald-100 dark:border-emerald-800/40 p-3 sm:p-5 space-y-3">
        <h3 className="font-bold text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
          <Eye className="w-4 h-4" />
          {t('morning.tips.title')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <TipCard
            emoji="🚗"
            title={t('morning.tips.bestCrossing')}
            value={topCrossings[0]?.name || '-'}
            subtitle={topCrossings[0]?.waitMinutes
              ? `~${topCrossings[0].waitMinutes} min`
              : t('morning.traffic.clear')
            }
          />
          <TipCard
            emoji="💱"
            title={t('morning.tips.todayRate')}
            value={`1 CHF = ${rate.toFixed(4)} €`}
            subtitle={t('morning.tips.liveRate')}
          />
          <TipCard
            emoji="🌡️"
            title={t('morning.tips.tempDiff')}
            value={weather.lugano && weather.como
              ? `${(weather.lugano.current.temperature - weather.como.current.temperature).toFixed(1)}°C`
              : '-'
            }
            subtitle={t('morning.tips.luganoVsComo')}
          />
        </div>
      </div>

      {/* 3-Day Forecast */}
      {(weather.lugano || weather.como) && (
        <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5 space-y-4">
          <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2 text-sm sm:text-base">
            <Cloud className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            {t('morning.forecast.title')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {weather.lugano && (
              <ForecastStrip location={weather.lugano} flag="🇨🇭" t={t} />
            )}
            {weather.como && (
              <ForecastStrip location={weather.como} flag="🇮🇹" t={t} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────

interface WeatherCardProps {
  location: LocationWeather | null;
  loading: boolean;
  flag: string;
  t: (key: string) => string;
}

const WeatherCard: React.FC<WeatherCardProps> = ({ location, loading, flag, t }) => {
  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5 space-y-3">
        <div className="h-28 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (!location) {
    return (
      <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('morning.weather.unavailable')}</p>
      </div>
    );
  }

  const { current } = location;

  return (
    <div className="bg-white dark:bg-slate-800/60 rounded-2xl border border-slate-200 dark:border-slate-700 p-3 sm:p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2 text-sm sm:text-base">
          <span className="text-lg">{flag}</span>
          {location.name}
        </h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">{location.country}</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0">
          {getWeatherIcon(current.weatherCode, current.isDay)}
        </div>
        <div>
          <div className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white tabular-nums">
            {Math.round(current.temperature)}°C
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400">
            {getWeatherLabel(current.weatherCode, t)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 sm:gap-2 text-xs">
        <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
          <Thermometer className="w-3 h-3" />
          <span>{t('morning.weather.feels')} {Math.round(current.apparentTemperature)}°</span>
        </div>
        <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
          <Droplets className="w-3 h-3" />
          <span>{current.humidity}%</span>
        </div>
        <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
          <Wind className="w-3 h-3" />
          <span>{Math.round(current.windSpeed)} km/h</span>
        </div>
      </div>

      {/* Sunrise / Sunset */}
      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-700">
        <span className="flex items-center gap-1">
          <Sunrise className="w-3 h-3 text-amber-500" />
          {location.sunrise.split('T')[1]?.slice(0, 5)}
        </span>
        <span className="flex items-center gap-1">
          <Sunset className="w-3 h-3 text-orange-500" />
          {location.sunset.split('T')[1]?.slice(0, 5)}
        </span>
      </div>
    </div>
  );
};

interface TipCardProps {
  emoji: string;
  title: string;
  value: string;
  subtitle: string;
}

const TipCard: React.FC<TipCardProps> = ({ emoji, title, value, subtitle }) => (
  <div className="bg-white/60 dark:bg-slate-800/40 rounded-xl p-3 space-y-1">
    <div className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
      <span>{emoji}</span> {title}
    </div>
    <div className="font-bold text-slate-900 dark:text-white text-sm">{value}</div>
    <div className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</div>
  </div>
);

interface ForecastStripProps {
  location: LocationWeather;
  flag: string;
  t: (key: string) => string;
}

const ForecastStrip: React.FC<ForecastStripProps> = ({ location, flag, t }) => (
  <div className="space-y-2">
    <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
      <span>{flag}</span> {location.name}
    </div>
    <div className="flex gap-2 sm:gap-3 overflow-x-auto -mx-1 px-1">
      {location.daily.map((day, i) => {
        const dayLabel = i === 0
          ? t('morning.forecast.today')
          : i === 1
          ? t('morning.forecast.tomorrow')
          : new Date(day.date).toLocaleDateString('it-IT', { weekday: 'short' });

        return (
          <div key={day.date} className="flex-1 text-center bg-slate-50 dark:bg-slate-700/40 rounded-lg p-2 space-y-1">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 capitalize">{dayLabel}</div>
            <div className="w-7 h-7 mx-auto">
              {getWeatherIcon(day.weatherCode, true)}
            </div>
            <div className="text-xs font-bold text-slate-900 dark:text-white">
              {Math.round(day.tempMax)}° / {Math.round(day.tempMin)}°
            </div>
            {day.precipitationProbability > 0 && (
              <div className="text-xs text-blue-600 dark:text-blue-400 flex items-center justify-center gap-0.5">
                <Droplets className="w-2.5 h-2.5" />
                {day.precipitationProbability}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

export default MorningDashboard;
