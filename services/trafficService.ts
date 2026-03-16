/**
 * Traffic Service - Google Maps Distance Matrix API Integration
 * Provides real-time traffic data for border crossings using Google Maps free tier
 * Protected by reCAPTCHA Enterprise to prevent API abuse
 * API key loaded from Firebase Remote Config
 */

/// <reference types="@types/google.maps" />

import recaptchaService from './recaptchaService';
import { reportCaughtError } from '@/services/errorReporter';
import { borderCrossings as centralizedCrossings } from '../data/borderCrossings';

interface BorderCrossingCoordinates {
  name: string;
  lat: number;
  lng: number;
  checkpointLat: number; // Coordinate del checkpoint dopo il confine
  checkpointLng: number;
}

export interface TrafficData {
  crossingName: string;
  waitTimeMinutes: number;
  status: 'green' | 'yellow' | 'red';
  direction: string;
  lastUpdate: Date;
  source: 'google-maps' | 'mock' | 'firestore';
  /** Traffic delay on the ≈500 m approach road on the Italian side (set by scheduled function) */
  approachMinutes?: number;
  /** Total estimated crossing time: approach delay + border queue (set by scheduled function) */
  totalCrossingMinutes?: number;
}

// Build BORDER_CROSSINGS from the centralized data source (excluding closed crossings)
const BORDER_CROSSINGS: BorderCrossingCoordinates[] = centralizedCrossings
  .filter(c => c.trafficLevel !== 'closed')
  .map(c => ({
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    checkpointLat: c.lat + 0.01, // ~1km north into CH
    checkpointLng: c.lng,
  }));

class TrafficService {
  private apiKey: string | null = null;
  private cache: Map<string, { data: TrafficData; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 60 * 60 * 1000; // 1 ora (60 minuti)
  private distanceMatrixService: google.maps.DistanceMatrixService | null = null;
  private mapsLoaded = false;
  private mapsLoadPromise: Promise<void> | null = null;
  private apiKeyInitialized = false;

  constructor() {
    // API key sarà caricata da Firebase Remote Config al primo utilizzo
    this.initApiKey();
  }

  /**
   * Inizializza l'API key da Firebase Remote Config
   */
  private async initApiKey(): Promise<void> {
    if (this.apiKeyInitialized) return;
    
    try {
      // Dynamic import to avoid pulling vendor-firebase into the initial bundle
      const { getConfigValue } = await import('./firebase');
      this.apiKey = await getConfigValue('GOOGLE_MAPS_API_KEY');
      this.apiKeyInitialized = true;
      
      if (this.hasApiKey()) {
        console.log('✅ Google Maps API key caricata da Firebase Remote Config');
        await this.loadGoogleMaps();
      }
    } catch (error) {
      reportCaughtError(error, 'traffic.loadApiKey', { apiEndpoint: 'RemoteConfig/GOOGLE_MAPS_API_KEY' });
      // No local fallback — secrets only from Remote Config
      this.apiKey = null;
      this.apiKeyInitialized = true;
    }
  }

  /**
   * Carica dinamicamente lo script di Google Maps
   */
  private loadGoogleMaps(): Promise<void> {
    if (this.mapsLoadPromise) {
      return this.mapsLoadPromise;
    }

    this.mapsLoadPromise = new Promise((resolve) => {
      // Se già caricato
      if (typeof google !== 'undefined' && google.maps && google.maps.DistanceMatrixService) {
        this.distanceMatrixService = new google.maps.DistanceMatrixService();
        this.mapsLoaded = true;
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${this.apiKey}&libraries=routes`;
      script.async = true;
      script.defer = true;
      
      script.onload = () => {
        try {
          if (typeof google !== 'undefined' && google.maps && google.maps.DistanceMatrixService) {
            this.distanceMatrixService = new google.maps.DistanceMatrixService();
            console.log('✅ Google Maps DistanceMatrixService initialized');
          }
          this.mapsLoaded = true;
        } catch (error) {
          reportCaughtError(error, 'traffic.mapsInit');
        }
        resolve();
      };
      
      script.onerror = () => {
        console.error('Failed to load Google Maps API');
        resolve(); // Resolve comunque per non bloccare l'app
      };
      
      document.head.appendChild(script);
    });

    return this.mapsLoadPromise;
  }

  /**
   * Imposta la API key di Google Maps
   */
  setApiKey(key: string) {
    this.apiKey = key;
  }

  /**
   * Verifica se l'API key è configurata
   */
  hasApiKey(): boolean {
    return this.apiKey !== null && this.apiKey !== '';
  }

  /**
   * Ottiene i dati di traffico per tutti i valichi.
   *
   * Priority order:
   *  1. Firestore `trafficCurrent` collection — written by the scheduled Cloud Function.
   *     This is the primary data source when the scheduler is active.
   *  2. Direct Google Maps Distance Matrix API call (legacy / fallback).
   *  3. Mock data — when no API key is available.
   */
  async getTrafficData(): Promise<TrafficData[]> {
    // Ensure the API key is initialised (needed for the legacy fallback path)
    await this.initApiKey();

    // ── 1. Try Firestore (written by the scheduled Cloud Function) ──────────
    try {
      const firestoreData = await this.getTrafficDataFromFirestore();
      if (firestoreData.length > 0) {
        return firestoreData;
      }
    } catch (error) {
      // Non-fatal — fall through to the direct API / mock path below
      reportCaughtError(error, 'traffic.firestoreRead');
    }

    // ── 2. Fallback: direct Google Maps call (or mock) ───────────────────────
    // Verifica reCAPTCHA prima di procedere con la richiesta API
    await recaptchaService.canProceed('TRAFFIC_DATA');

    if (!this.hasApiKey()) {
      console.warn('Google Maps API key not configured. Using mock data.');
      return this.getMockTrafficData();
    }

    try {
      const trafficPromises = BORDER_CROSSINGS.map(crossing =>
        this.getTrafficForCrossing(crossing)
      );

      const results = await Promise.allSettled(trafficPromises);

      return results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          console.error(`Error fetching traffic for ${BORDER_CROSSINGS[index].name}:`, result.reason);
          return this.getMockTrafficForCrossing(BORDER_CROSSINGS[index].name);
        }
      });
    } catch (error) {
      reportCaughtError(error, 'traffic.fetchAll');
      return this.getMockTrafficData();
    }
  }

  /**
   * Reads the latest traffic snapshot for all crossings from Firestore.
   * Returns an empty array when the collection is empty or the data is stale
   * (scheduler not yet deployed or inactive for more than 2 hours).
   */
  private async getTrafficDataFromFirestore(): Promise<TrafficData[]> {
    const { getApp } = await import('./firebase');
    const { getFirestore, collection, getDocs } = await import('firebase/firestore');

    const app = await getApp();
    const db = getFirestore(app);
    const snapshot = await getDocs(collection(db, 'trafficCurrent'));

    if (snapshot.empty) return [];

    const results: TrafficData[] = [];
    const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
    const now = Date.now();

    snapshot.forEach(docSnap => {
      const d = docSnap.data();
      // Convert Firestore Timestamp → JS Date
      let lastUpdate: Date;
      if (d.lastUpdate && typeof d.lastUpdate.toDate === 'function') {
        lastUpdate = d.lastUpdate.toDate();
      } else {
        console.warn(`[trafficService] Missing lastUpdate for Firestore doc ${docSnap.id}`);
        lastUpdate = new Date(d.lastUpdate ?? Date.now());
      }

      results.push({
        crossingName:         d.crossingName,
        waitTimeMinutes:      d.waitTimeMinutes ?? 0,
        status:               d.status ?? 'green',
        direction:            d.direction ?? 'Entrambi',
        lastUpdate,
        source:               'firestore',
        approachMinutes:      d.approachMinutes,
        totalCrossingMinutes: d.totalCrossingMinutes,
      });
    });

    // If all documents are older than the threshold, treat the data as stale
    if (results.length > 0 && results.every(r => now - r.lastUpdate.getTime() > STALE_THRESHOLD_MS)) {
      console.warn('[trafficService] Firestore data is stale (>2 h old) — falling back');
      return [];
    }

    return results;
  }

  /**
   * Ottiene i dati di traffico per un singolo valico usando Google Maps Distance Matrix API
   */
  private async getTrafficForCrossing(crossing: BorderCrossingCoordinates): Promise<TrafficData> {
    const cacheKey = crossing.name;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.data;
    }

    // Attendi il caricamento di Google Maps
    if (this.hasApiKey() && !this.mapsLoaded) {
      await this.loadGoogleMaps();
    }

    // Se il servizio non è disponibile, usa i dati mock
    if (!this.distanceMatrixService) {
      return this.getMockTrafficForCrossing(crossing.name);
    }

    try {
      const origin = new google.maps.LatLng(crossing.lat, crossing.lng);
      const destination = new google.maps.LatLng(crossing.checkpointLat, crossing.checkpointLng);
      
      // Chiamata al Distance Matrix Service
      const result = await new Promise<google.maps.DistanceMatrixResponse>((resolve, reject) => {
        this.distanceMatrixService!.getDistanceMatrix(
          {
            origins: [origin],
            destinations: [destination],
            travelMode: google.maps.TravelMode.DRIVING,
            drivingOptions: {
              departureTime: new Date(),
              trafficModel: google.maps.TrafficModel.BEST_GUESS
            },
            unitSystem: google.maps.UnitSystem.METRIC
          },
          (response, status) => {
            if (status === 'OK' && response) {
              resolve(response);
            } else {
              reject(new Error(`Distance Matrix API error: ${status}`));
            }
          }
        );
      });
      
      const element = result.rows[0]?.elements[0];
      
      if (!element || element.status !== 'OK') {
        throw new Error(`Route error: ${element?.status || 'NO_DATA'}`);
      }
      
      // Tempo con traffico in secondi
      const durationInTraffic = element.duration_in_traffic?.value || element.duration.value;
      // Tempo normale senza traffico
      const normalDuration = element.duration.value;
      
      // Calcola il ritardo in minuti
      const delaySeconds = durationInTraffic - normalDuration;
      const waitTimeMinutes = Math.max(0, Math.round(delaySeconds / 60));
      
      // Determina lo stato in base al ritardo
      let status: 'green' | 'yellow' | 'red';
      if (waitTimeMinutes < 5) {
        status = 'green';
      } else if (waitTimeMinutes < 15) {
        status = 'yellow';
      } else {
        status = 'red';
      }
      
      // Determina la direzione in base all'ora
      const hour = new Date().getHours();
      let direction: string;
      if (hour >= 6 && hour < 10) {
        direction = 'IT → CH';
      } else if (hour >= 16 && hour < 20) {
        direction = 'CH → IT';
      } else {
        direction = 'Entrambi';
      }
      
      const trafficData: TrafficData = {
        crossingName: crossing.name,
        waitTimeMinutes,
        status,
        direction,
        lastUpdate: new Date(),
        source: 'google-maps'
      };
      
      // Salva in cache
      this.cache.set(cacheKey, {
        data: trafficData,
        timestamp: Date.now()
      });
      
      return trafficData;
    } catch (error) {
      reportCaughtError(error, `traffic.fetchCrossing.${crossing.name}`);
      // Fallback a dati mock in caso di errore
      return this.getMockTrafficForCrossing(crossing.name);
    }
  }

  /**
   * Genera dati mock di traffico per tutti i valichi (fallback)
   */
  private getMockTrafficData(): TrafficData[] {
    return BORDER_CROSSINGS.map(crossing => 
      this.getMockTrafficForCrossing(crossing.name)
    );
  }

  /**
   * Genera dati mock di traffico per un singolo valico
   */
  private getMockTrafficForCrossing(crossingName: string): TrafficData {
    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();
    
    let baseWait = 3;
    let direction = 'Entrambi';
    
    // Chiasso variants have more traffic
    if (crossingName.includes('Chiasso')) {
      baseWait = 8;
    }
    
    // Major crossings have more traffic
    if (crossingName.includes('Gaggiolo') || crossingName.includes('Brogeda')) {
      baseWait = 6;
    }
    
    // Medium crossings
    if (crossingName.includes('Ponte Tresa') || crossingName.includes('San Pietro') || crossingName.includes('Luino')) {
      baseWait = 5;
    }
    
    // Picco mattutino (7-9) IT -> CH
    if (hour >= 7 && hour < 9) {
      baseWait *= (crossingName.includes('Chiasso') ? 3 : 2);
      direction = 'IT → CH';
    }
    
    // Picco serale (17-19) CH -> IT
    if (hour >= 17 && hour < 19) {
      baseWait *= (crossingName.includes('Chiasso') ? 4 : 2.5);
      direction = 'CH → IT';
    }
    
    // Venerdì sera più traffico
    if (dayOfWeek === 5 && hour >= 16) {
      baseWait *= 1.5;
    }
    
    // Domenica sera traffico moderato
    if (dayOfWeek === 0 && hour >= 17) {
      baseWait *= 1.3;
    }
    
    // Aggiungi variazione casuale ±30%
    const variation = 0.7 + Math.random() * 0.6;
    const waitTimeMinutes = Math.round(baseWait * variation);
    
    let status: 'green' | 'yellow' | 'red';
    if (waitTimeMinutes < 5) {
      status = 'green';
    } else if (waitTimeMinutes < 15) {
      status = 'yellow';
    } else {
      status = 'red';
    }
    
    return {
      crossingName,
      waitTimeMinutes,
      status,
      direction,
      lastUpdate: new Date(),
      source: 'mock'
    };
  }

  /**
   * Pulisce la cache
   */
  clearCache() {
    this.cache.clear();
  }
}

export const trafficService = new TrafficService();
