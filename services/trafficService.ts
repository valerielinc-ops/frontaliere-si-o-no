/**
 * Traffic Service - Google Maps Distance Matrix API Integration
 * Provides real-time traffic data for border crossings using Google Maps free tier
 */

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
  source: 'google-maps' | 'mock';
}

// Coordinate GPS dei valichi di confine CH-IT
const BORDER_CROSSINGS: BorderCrossingCoordinates[] = [
  {
    name: 'Chiasso-Brogeda',
    lat: 45.8356,
    lng: 9.0294,
    checkpointLat: 45.8456,
    checkpointLng: 9.0294
  },
  {
    name: 'Stabio-Gaggiolo',
    lat: 45.8653,
    lng: 8.9331,
    checkpointLat: 45.8753,
    checkpointLng: 8.9331
  },
  {
    name: 'Ponte Tresa',
    lat: 45.9719,
    lng: 8.8569,
    checkpointLat: 45.9819,
    checkpointLng: 8.8569
  },
  {
    name: 'Fornasette-Lavena',
    lat: 45.9444,
    lng: 8.8883,
    checkpointLat: 45.9544,
    checkpointLng: 8.8883
  },
  {
    name: 'Ponte Cremenaga',
    lat: 45.9558,
    lng: 8.8672,
    checkpointLat: 45.9658,
    checkpointLng: 8.8672
  },
  {
    name: 'Gaggiolo-Mendrisio',
    lat: 45.8678,
    lng: 8.9817,
    checkpointLat: 45.8778,
    checkpointLng: 8.9817
  },
  {
    name: 'Ligornetto-Saltrio',
    lat: 45.8506,
    lng: 8.9489,
    checkpointLat: 45.8606,
    checkpointLng: 8.9489
  },
  {
    name: 'Maslianico',
    lat: 45.8261,
    lng: 9.0661,
    checkpointLat: 45.8361,
    checkpointLng: 9.0661
  }
];

class TrafficService {
  private apiKey: string | null = null;
  private cache: Map<string, { data: TrafficData; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 2 * 60 * 1000; // 2 minuti
  private readonly API_ENDPOINT = 'https://maps.googleapis.com/maps/api/distancematrix/json';

  constructor() {
    // Tenta di leggere la API key dalle variabili d'ambiente
    this.apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || null;
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
   * Ottiene i dati di traffico per tutti i valichi
   */
  async getTrafficData(): Promise<TrafficData[]> {
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
      console.error('Error fetching traffic data:', error);
      return this.getMockTrafficData();
    }
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

    try {
      const origins = `${crossing.lat},${crossing.lng}`;
      const destinations = `${crossing.checkpointLat},${crossing.checkpointLng}`;
      
      const url = `${this.API_ENDPOINT}?origins=${origins}&destinations=${destinations}&departure_time=now&traffic_model=best_guess&key=${this.apiKey}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.status !== 'OK' || !data.rows?.[0]?.elements?.[0]) {
        throw new Error(`API error: ${data.status}`);
      }
      
      const element = data.rows[0].elements[0];
      
      if (element.status !== 'OK') {
        throw new Error(`Route error: ${element.status}`);
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
      console.error(`Error fetching traffic for ${crossing.name}:`, error);
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
    
    // Chiasso ha sempre più traffico
    if (crossingName.includes('Chiasso')) {
      baseWait = 8;
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
