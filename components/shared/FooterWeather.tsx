/**
 * FooterWeather — Colorful weather strip for the site footer.
 * Shows current temperature for user's location (from profile municipality,
 * or IP geolocation fallback), Lugano (CH) and Como (IT).
 * Reuses the same localStorage cache as MorningDashboard (30-min TTL).
 */

import React, { useEffect, useState, useRef } from 'react';
import { Cloud, CloudRain, CloudSnow, Sun, CloudDrizzle, CloudFog, CloudLightning, MapPin, Navigation } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface MiniWeather {
  temp: number;
  code: number;
  isDay: boolean;
  city?: string;
}

const WEATHER_CACHE_KEY = 'morning_weather_cache';
const WEATHER_CACHE_TTL = 30 * 60 * 1000;
const USER_LOCATION_CACHE_KEY = 'user_location_cache';
const USER_LOCATION_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getWeatherEmoji(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1) return isDay ? '🌤️' : '🌙';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code >= 45 && code <= 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 86) return '🌧️';
  if (code >= 95 && code <= 99) return '⛈️';
  return '☀️';
}

function getWeatherMiniIcon(code: number, size = 16): React.ReactNode {
  if (code === 0 || code === 1) return <Sun style={{ width: size, height: size }} className="text-amber-500 dark:text-amber-400" />;
  if (code === 2) return <Cloud style={{ width: size, height: size }} className="text-slate-500 dark:text-slate-400" />;
  if (code === 3) return <Cloud style={{ width: size, height: size }} className="text-slate-500 dark:text-slate-400" />;
  if (code >= 45 && code <= 48) return <CloudFog style={{ width: size, height: size }} className="text-slate-500 dark:text-slate-400" />;
  if (code >= 51 && code <= 57) return <CloudDrizzle style={{ width: size, height: size }} className="text-blue-400 dark:text-blue-300" />;
  if (code >= 61 && code <= 67) return <CloudRain style={{ width: size, height: size }} className="text-blue-500 dark:text-blue-400" />;
  if (code >= 71 && code <= 77) return <CloudSnow style={{ width: size, height: size }} className="text-blue-300 dark:text-blue-200" />;
  if (code >= 80 && code <= 86) return <CloudRain style={{ width: size, height: size }} className="text-blue-600 dark:text-blue-400" />;
  if (code >= 95 && code <= 99) return <CloudLightning style={{ width: size, height: size }} className="text-amber-400 dark:text-amber-300" />;
  return <Sun style={{ width: size, height: size }} className="text-amber-500 dark:text-amber-400" />;
}

function getTempColor(temp: number): string {
  if (temp <= -5) return 'text-blue-700 dark:text-blue-400';
  if (temp <= 0) return 'text-cyan-700 dark:text-cyan-400';
  if (temp <= 10) return 'text-sky-700 dark:text-sky-400';
  if (temp <= 20) return 'text-emerald-700 dark:text-emerald-400';
  if (temp <= 30) return 'text-orange-700 dark:text-orange-400';
  return 'text-red-700 dark:text-red-400';
}

function getTempBg(temp: number): string {
  if (temp <= 0) return 'bg-blue-50 dark:bg-blue-950/30 border-blue-200/50 dark:border-blue-800/50';
  if (temp <= 10) return 'bg-sky-50 dark:bg-sky-950/30 border-sky-200/50 dark:border-sky-800/50';
  if (temp <= 20) return 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200/50 dark:border-emerald-800/50';
  if (temp <= 30) return 'bg-amber-50 dark:bg-amber-950/30 border-amber-200/50 dark:border-amber-800/50';
  return 'bg-red-50 dark:bg-red-950/30 border-red-200/50 dark:border-red-800/50';
}

async function fetchMini(lat: number, lng: number): Promise<MiniWeather | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,is_day&timezone=Europe/Zurich`
    );
    if (!res.ok) return null;
    const d = await res.json();
    return { temp: d.current.temperature_2m, code: d.current.weather_code, isDay: !!d.current.is_day };
  } catch {
    return null;
  }
}

interface UserLocation {
  lat: number;
  lng: number;
  city: string;
}

const PROFILE_STORAGE_KEY = 'frontaliere_user_profile';

async function getUserLocation(): Promise<UserLocation | null> {
  // 1. First, check user profile for municipality (most reliable, user-set)
  try {
    const profileStr = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (profileStr) {
      const profile = JSON.parse(profileStr);
      if (profile.municipality) {
        const { findMunicipality } = await import('@/data/municipalities');
        const mun = findMunicipality(profile.municipality);
        if (mun && mun.lat && mun.lng) {
          return { lat: mun.lat, lng: mun.lng, city: mun.name };
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Check cache for IP-based location
  try {
    const cached = localStorage.getItem(USER_LOCATION_CACHE_KEY);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < USER_LOCATION_CACHE_TTL) {
        return data as UserLocation;
      }
    }
  } catch { /* ignore */ }

  // 3. Client-side IP lookup is disabled to avoid shipping third-party API keys.
  return null;
}

const WeatherPill: React.FC<{ weather: MiniWeather; label: string; flag?: string; isUser?: boolean }> = ({ weather, label, flag, isUser }) => {
  const emoji = getWeatherEmoji(weather.code, weather.isDay);
  const tempColor = getTempColor(weather.temp);
  const tempBg = getTempBg(weather.temp);

  const handleClick = () => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'morning' } }));
  };

  return (
    <button
      onClick={handleClick}
      title={`${label} ${Math.round(weather.temp)}° — apri dashboard mattutina`}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-medium transition-[color,background-color,border-color,box-shadow,transform] cursor-pointer hover:scale-105 hover:shadow-md ${tempBg}`}
    >
      {isUser ? (
        <Navigation className="w-3 h-3 text-violet-500" aria-hidden="true" />
      ) : flag ? (
        <span className="text-xs" aria-hidden="true">{flag}</span>
      ) : (
        <MapPin className="w-3 h-3 text-slate-500 dark:text-slate-400" aria-hidden="true" />
      )}
      <span className="font-semibold text-slate-700 dark:text-slate-300">{label}</span>
      <span className="text-sm" aria-hidden="true">{emoji}</span>
      <span className={`font-bold tabular-nums ${tempColor}`}>
        {Math.round(weather.temp)}°
      </span>
    </button>
  );
};

const FooterWeather: React.FC = () => {
  const { t } = useTranslation();
  const [lugano, setLugano] = useState<MiniWeather | null>(null);
  const [como, setComo] = useState<MiniWeather | null>(null);
  const [userWeather, setUserWeather] = useState<MiniWeather | null>(null);
  const [userCity, setUserCity] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Observe when the footer enters the viewport (with 200px margin)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      // Fallback: load immediately if IntersectionObserver not available
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Only fetch weather data once visible
  useEffect(() => {
    if (!isVisible) return;
    let mounted = true;

    // Try to get Lugano/Como data from MorningDashboard's cache first
    let usedCache = false;
    try {
      const cached = localStorage.getItem(WEATHER_CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < WEATHER_CACHE_TTL) {
          if (data.lugano?.current) {
            setLugano({ temp: data.lugano.current.temperature, code: data.lugano.current.weatherCode, isDay: data.lugano.current.isDay });
          }
          if (data.como?.current) {
            setComo({ temp: data.como.current.temperature, code: data.como.current.weatherCode, isDay: data.como.current.isDay });
          }
          usedCache = true;
        }
      }
    } catch { /* ignore */ }

    if (!usedCache) {
      // Fetch fresh data for Lugano and Como
      Promise.all([
        fetchMini(46.0037, 8.9511),
        fetchMini(45.8081, 9.0852),
      ]).then(([l, c]) => {
        if (mounted) {
          setLugano(l);
          setComo(c);
        }
      }).catch(() => {});
    }

    // Fetch user location weather in background
    getUserLocation().then(async (loc) => {
      if (!mounted || !loc) return;
      // Don't show user pill if they're already near Lugano or Como
      const isNearLugano = Math.abs(loc.lat - 46.0037) < 0.15 && Math.abs(loc.lng - 8.9511) < 0.15;
      const isNearComo = Math.abs(loc.lat - 45.8081) < 0.15 && Math.abs(loc.lng - 9.0852) < 0.15;
      if (isNearLugano || isNearComo) return;

      const weather = await fetchMini(loc.lat, loc.lng);
      if (mounted && weather) {
        setUserWeather(weather);
        setUserCity(loc.city);
      }
    }).catch(() => {});

    return () => { mounted = false; };
  }, [isVisible]);

  // Show a placeholder div even before data loads so IntersectionObserver has a target
  if (!lugano && !como && !userWeather) return <div ref={containerRef} />;

  return (
    <div ref={containerRef} className="flex flex-wrap items-center justify-center gap-2">
      {userWeather && userCity && (
        <WeatherPill weather={userWeather} label={userCity} isUser />
      )}
      {lugano && (
        <WeatherPill weather={lugano} label="Lugano" flag="🇨🇭" />
      )}
      {como && (
        <WeatherPill weather={como} label="Como" flag="🇮🇹" />
      )}
    </div>
  );
};

export default FooterWeather;
