/**
 * Firebase Configuration Service
 * Gestisce inizializzazione Firebase, Remote Config e App Check
 * Tutte le API keys sono protette tramite Firebase Remote Config e App Check con reCAPTCHA
 */

import { initializeApp, FirebaseApp } from "firebase/app";
import { getAnalytics, Analytics as FirebaseAnalytics } from "firebase/analytics";
import { initializeAppCheck, ReCaptchaV3Provider, AppCheck } from "firebase/app-check";
import { getRemoteConfig, RemoteConfig, fetchAndActivate, getValue, isSupported } from "firebase/remote-config";

// Configurazione Firebase (pubblica, non contiene secret)
const firebaseConfig = {
  apiKey: "AIzaSyCxbA2_3BiBOjZryR5LOXCf_c2-Sgg7YSc",
  authDomain: "frontaliere-ticino.firebaseapp.com",
  projectId: "frontaliere-ticino",
  storageBucket: "frontaliere-ticino.firebasestorage.app",
  messagingSenderId: "957502085858",
  appId: "1:957502085858:web:4941e8997ebf75b0145cbb",
  measurementId: "G-G1E84HYGB7"
};

// Inizializza Firebase
const app: FirebaseApp = initializeApp(firebaseConfig);
const analytics: FirebaseAnalytics = getAnalytics(app);

// Inizializza App Check con reCAPTCHA v3
// La Site Key viene caricata da Remote Config
let appCheck: AppCheck | null = null;
let recaptchaSiteKey: string | null = null;
let recaptchaScriptLoaded = false;

/**
 * Carica lo script reCAPTCHA dinamicamente con la site key da Remote Config
 */
async function loadRecaptchaScript(siteKey: string): Promise<void> {
  if (recaptchaScriptLoaded) return;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
    script.async = true;
    script.defer = true;
    
    script.onload = () => {
      recaptchaScriptLoaded = true;
      console.log('✅ reCAPTCHA script caricato dinamicamente');
      resolve();
    };
    
    script.onerror = () => {
      console.error('❌ Errore caricamento script reCAPTCHA');
      reject(new Error('Failed to load reCAPTCHA script'));
    };

    // Aggiungi lo script al documento
    const loader = document.getElementById('recaptcha-loader');
    if (loader) {
      loader.parentNode?.insertBefore(script, loader.nextSibling);
    } else {
      document.head.appendChild(script);
    }
  });
}

/**
 * Attende che lo script reCAPTCHA sia completamente caricato
 */
async function waitForRecaptcha(maxAttempts = 50, delayMs = 100): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (typeof window !== 'undefined' && 
        typeof (window as any).grecaptcha !== 'undefined' && 
        typeof (window as any).grecaptcha.ready === 'function') {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

async function initAppCheck(): Promise<void> {
  if (typeof window === 'undefined' || appCheck !== null) {
    return;
  }

  try {
    // Carica la Site Key da Remote Config
    recaptchaSiteKey = await getConfigValue('RECAPTCHA_SITE_KEY');
    
    if (!recaptchaSiteKey) {
      console.warn('⚠️ RECAPTCHA_SITE_KEY non trovata in Remote Config');
      return;
    }

    console.log('🔑 reCAPTCHA Site Key caricata da Firebase Remote Config');

    // Carica lo script reCAPTCHA con la site key corretta
    await loadRecaptchaScript(recaptchaSiteKey);

    // Attende che lo script reCAPTCHA sia completamente inizializzato
    console.log('⏳ Attendo inizializzazione reCAPTCHA...');
    const recaptchaReady = await waitForRecaptcha();
    
    if (!recaptchaReady) {
      console.warn('⚠️ reCAPTCHA non disponibile dopo 5 secondi');
      return;
    }

    console.log('✅ reCAPTCHA pronto');
    
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true
    });
    console.log('✅ Firebase App Check inizializzato con reCAPTCHA v3');
  } catch (error) {
    console.warn('⚠️ App Check non disponibile:', error);
  }
}

// Inizializza Remote Config
let remoteConfig: RemoteConfig | null = null;
let configInitialized = false;

/**
 * Inizializza Remote Config con valori di default (fallback)
 */
async function initRemoteConfig(): Promise<void> {
  if (configInitialized || typeof window === 'undefined') {
    return;
  }

  try {
    const supported = await isSupported();
    if (!supported) {
      console.warn('⚠️ Remote Config non supportato in questo ambiente');
      return;
    }

    remoteConfig = getRemoteConfig(app);
    
    // Valori di default (fallback se Remote Config non disponibile)
    remoteConfig.defaultConfig = {
      GOOGLE_MAPS_API_KEY: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
      GA_MEASUREMENT_ID: import.meta.env.VITE_GA_MEASUREMENT_ID || '',
      GITHUB_PAT: import.meta.env.VITE_REACT_APP_PAT || '',
      GEMINI_API_KEY: import.meta.env.GEMINI_API_KEY || '',
      RECAPTCHA_SITE_KEY: import.meta.env.VITE_RECAPTCHA_SITE_KEY || ''
    };

    // Impostazioni cache: fetch ogni ora in produzione, ogni 5 minuti in dev
    remoteConfig.settings = {
      minimumFetchIntervalMillis: import.meta.env.MODE === 'production' ? 3600000 : 300000,
      fetchTimeoutMillis: 60000
    };

    // Fetch e attiva le configurazioni remote
    await fetchAndActivate(remoteConfig);
    configInitialized = true;
    console.log('✅ Firebase Remote Config inizializzato e attivato');
  } catch (error) {
    console.warn('⚠️ Errore inizializzazione Remote Config:', error);
    console.log('📌 Utilizzo valori di default locali');
  }
}

/**
 * Ottiene un valore da Remote Config
 * @param key Nome del parametro da recuperare
 * @returns Valore string del parametro
 */
export async function getConfigValue(key: string): Promise<string> {
  // Inizializza Remote Config se non ancora fatto
  if (!configInitialized) {
    await initRemoteConfig();
  }

  try {
    if (remoteConfig) {
      const value = getValue(remoteConfig, key);
      return value.asString();
    }
  } catch (error) {
    console.warn(`⚠️ Errore recupero config "${key}":`, error);
  }

  // Fallback: usa variabili d'ambiente locali
  const envValues: Record<string, string> = {
    GOOGLE_MAPS_API_KEY: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
    GA_MEASUREMENT_ID: import.meta.env.VITE_GA_MEASUREMENT_ID || '',
    GITHUB_PAT: import.meta.env.VITE_REACT_APP_PAT || '',
    GEMINI_API_KEY: import.meta.env.GEMINI_API_KEY || '',
    RECAPTCHA_SITE_KEY: import.meta.env.VITE_RECAPTCHA_SITE_KEY || ''
  };

  return envValues[key] || '';
}

/**
 * Forza il refresh delle configurazioni remote
 * Utile per testing o dopo aggiornamenti critici
 */
export async function refreshRemoteConfig(): Promise<boolean> {
  try {
    if (!remoteConfig) {
      await initRemoteConfig();
    }
    if (remoteConfig) {
      await fetchAndActivate(remoteConfig);
      console.log('✅ Remote Config aggiornato');
      return true;
    }
    return false;
  } catch (error) {
    console.error('❌ Errore refresh Remote Config:', error);
    return false;
  }
}

/**
 * Verifica se App Check è attivo e funzionante
 */
export function isAppCheckActive(): boolean {
  return appCheck !== null;
}

// Esporta istanze Firebase
export { app, analytics, appCheck, remoteConfig };

// Auto-inizializza Remote Config al caricamento del modulo
if (typeof window !== 'undefined') {
  initRemoteConfig()
    .then(() => {
      // Dopo Remote Config, inizializza App Check
      return initAppCheck();
    })
    .catch(err => {
      console.error('Errore auto-inizializzazione Firebase:', err);
    });
}
