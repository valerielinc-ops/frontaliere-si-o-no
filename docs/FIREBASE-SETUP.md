# Guida Configurazione Firebase
## Firebase Remote Config + App Check per Proteggere le API Keys

Questa guida ti mostra come configurare Firebase Console per proteggere tutte le API keys dell'applicazione usando **Remote Config** (storage sicuro) e **App Check** (verifica client con reCAPTCHA).

---

## 📋 Prerequisiti

- Progetto Firebase: **frontaliere-ticino** (già creato)
- Console Firebase: https://console.firebase.google.com/
- Accesso come owner/editor del progetto

---

## 🔐 Parte 1: Firebase App Check

App Check protegge le risorse Firebase verificando che le richieste provengano dalla tua app legittima e non da bot o script malevoli.

### Step 1.1: Attivare App Check

1. Vai su: **Firebase Console → frontaliere-ticino → App Check**
2. Clicca su **"Inizia"** o **"Get Started"**

### Step 1.2: Registrare l'App Web

1. Nella sezione **"Apps"**, clicca su **"Add app"** o il simbolo **+**
2. Seleziona **"Web"**
3. Inserisci:
   - **Nome app**: `Frontaliere Ticino Web`
   - **Nickname** (opzionale): `frontaliere-web`
4. Clicca **"Register app"**

### Step 1.3: Configurare reCAPTCHA v3

1. Dopo aver registrato l'app, vedrai una schermata di configurazione
2. Seleziona **"reCAPTCHA v3"** come provider
3. Inserisci la **Site Key**:
   ```
   6LeGWWosAAAAAFSgorUe63qmWd03Bu6qMNdF_AdJ
   ```
4. Clicca **"Save"** o **"Salva"**

### Step 1.4: Abilitare Enforcement per Remote Config

1. Nella sezione **"APIs"** di App Check
2. Trova **"Remote Config"** nella lista
3. Clicca sul toggle per attivare **"Enforce"** (Applica)
4. **IMPORTANTE**: Per ora lascia in modalità **"Monitoring"** (non Enforce) durante lo sviluppo
   - In Monitoring: raccoglie metriche ma non blocca richieste non verificate
   - In Enforce: blocca richieste senza token App Check valido

**Configurazione consigliata:**
```
Remote Config: Monitoring (durante sviluppo) → Enforce (in produzione)
Cloud Storage: Monitoring
Realtime Database: Monitoring
Cloud Firestore: Monitoring (se usi)
```

### Step 1.5: Domini Autorizzati

1. Vai su **"Settings"** (ingranaggio in alto) → **"General"**
2. Scorri fino a **"Authorized domains"**
3. Aggiungi:
   - `frontaliereticino.ch`
   - `www.frontaliereticino.ch`
   - `localhost` (per development)
4. Clicca **"Add domain"** per ciascuno

---

## 🗝️ Parte 2: Firebase Remote Config

Remote Config ti permette di salvare configurazioni (incluse API keys) in modo sicuro nel cloud Firebase, senza esporle nel codice sorgente.

### Step 2.1: Accedere a Remote Config

1. Vai su: **Firebase Console → frontaliere-ticino → Remote Config**
2. Se è la prima volta, clicca **"Create configuration"**

### Step 2.2: Creare i Parametri per le API Keys

Devi creare **4 parametri** (uno per ogni API key):

#### Parametro 1: GOOGLE_MAPS_API_KEY

1. Clicca **"Add parameter"**
2. Compila:
   - **Parameter key**: `GOOGLE_MAPS_API_KEY`
   - **Description**: `API key per Google Maps Distance Matrix`
   - **Data type**: `String`
   - **Default value**: 
     ```
     AIzaSyBdQzrmGtilRElTbVRkXChowTQhpKgIcrU
     ```
3. Clicca **"Save"**

#### Parametro 2: GA_MEASUREMENT_ID

1. Clicca **"Add parameter"**
2. Compila:
   - **Parameter key**: `GA_MEASUREMENT_ID`
   - **Description**: `Google Analytics Measurement ID`
   - **Data type**: `String`
   - **Default value**: 
     ```
     G-HRJEW4REGH
     ```
3. Clicca **"Save"**

#### Parametro 3: GITHUB_PAT

1. Clicca **"Add parameter"**
2. Compila:
   - **Parameter key**: `GITHUB_PAT`
   - **Description**: `GitHub Personal Access Token (Base64 encoded)`
   - **Data type**: `String`
   - **Default value**: 
     ```
     Z2l0aHViX3BhdF8xMUI2R1ZFSFEwNGRyMTJYenB4OG1RX1ZjSGJMWTllWGkwQXFEYXBqQzNqc0lzVUdncHZySFRHSHlwc3dLUUxHRUFEWU5IS1JGSFlHMjFObTFB
     ```
   - **⚠️ NOTA**: Questo token è codificato in Base64 per sicurezza aggiuntiva
3. Clicca **"Save"**

#### Parametro 4: GEMINI_API_KEY

1. Clicca **"Add parameter"**
2. Compila:
   - **Parameter key**: `GEMINI_API_KEY`
   - **Description**: `Google Gemini AI API key per ottimizzazione testo feedback`
   - **Data type**: `String`
   - **Default value**: 
     ```
     AIzaSyC5WoQj3aI0k9l6CT8E8sCJwlf8n6rSdxs
     ```
3. Clicca **"Save"**

#### Parametro 5: RECAPTCHA_SITE_KEY

1. Clicca **"Add parameter"**
2. Compila:
   - **Parameter key**: `RECAPTCHA_SITE_KEY`
   - **Description**: `reCAPTCHA v3 Site Key`
   - **Data type**: `String`
   - **Default value**: 
     ```
     6LeGWWosAAAAAFSgorUe63qmWd03Bu6qMNdF_AdJ
     ```
3. Clicca **"Save"**

### Step 2.3: Pubblicare i Cambiamenti

1. Dopo aver creato tutti i 5 parametri, vedrai un pulsante **"Publish changes"** in alto a destra
2. Clicca **"Publish changes"**
3. Aggiungi una descrizione (opzionale):
   ```
   Initial setup: API keys for Google Maps, Analytics, GitHub, Gemini, reCAPTCHA
   ```
4. Clicca **"Publish"**

### Step 2.4: Verificare i Parametri

Dovresti vedere una lista simile a questa:

| Parameter Key | Data Type | Default Value | Status |
|--------------|-----------|---------------|--------|
| GOOGLE_MAPS_API_KEY | String | AIzaSy... | Active |
| GA_MEASUREMENT_ID | String | G-HRJEW4REGH | Active |
| GITHUB_PAT | String | Z2l0aHV... | Active |
| GEMINI_API_KEY | String | AIzaSy... | Active |
| RECAPTCHA_SITE_KEY | String | 6LeGW... | Active |

---

## ⚙️ Parte 3: Impostazioni Avanzate (Opzionale)

### 3.1 Condizioni Personalizzate

Puoi creare condizioni per fornire valori diversi a seconda del contesto:

**Esempio**: API key diversa per development vs produzione

1. Vai su Remote Config → **"Conditions"** tab
2. Clicca **"Add condition"**
3. Crea condizione **"Development"**:
   - **Name**: `Development`
   - **Color**: Blu
   - **Applies if**: `App → is one of → frontaliere-web`
   - **AND**: `Platform → Web → runs on → localhost`
4. Clicca **"Create condition"**

5. Torna ai parametri e clicca su **GOOGLE_MAPS_API_KEY**
6. Clicca **"Add value for condition"**
7. Seleziona **"Development"**
8. Inserisci una API key di test/development
9. Clicca **"Save"** e poi **"Publish changes"**

### 3.2 Template per Parametri Sensibili

1. Vai su Remote Config → **"Settings"** (⚙️)
2. Attiva **"Hide values for all parameters"** (nasconde valori API nella console)
3. Abilita **"History"** per tracciare modifiche

---

## 🧪 Parte 4: Testing

### 4.1 Test Locale

1. Apri DevTools → Console
2. Carica la tua app
3. Cerca nei logs:
   ```
   ✅ Firebase App Check inizializzato con reCAPTCHA v3
   ✅ Firebase Remote Config inizializzato e attivato
   ✅ API keys caricate da Firebase Remote Config
   ✅ Google Maps API key caricata da Firebase Remote Config
   ✅ GA4 Initialized with Firebase Remote Config
   ```

### 4.2 Testare App Check

1. Vai su Firebase Console → **App Check** → **Metrics**
2. Verifica che vedi richieste verificate
3. Controlla **"Verification success rate"** (dovrebbe essere ~100%)

### 4.3 Testare Remote Config

1. Nella Console Firebase → Remote Config → **"Recent changes"**
2. Verifica che i parametri siano stati fetched dalla tua app
3. Puoi vedere metriche di utilizzo in **"Analytics"** tab

---

## 🚀 Parte 5: Deploy in Produzione

### Step 5.1: Passare App Check a Enforce

⚠️ **FALLO SOLO QUANDO SEI SICURO CHE TUTTO FUNZIONA**

1. Vai su Firebase Console → **App Check** → **APIs**
2. Per **Remote Config**, passa da **"Monitoring"** a **"Enforce"**
3. Ora solo richieste con token App Check valido possono leggere Remote Config

### Step 5.2: Rimuovere API Keys dal .env.local

Una volta che tutto funziona con Firebase Remote Config:

1. Mantieni solo le chiavi pubbliche in `.env.local`:
   ```bash
   # .env.local (solo per fallback locale)
   VITE_RECAPTCHA_SITE_KEY=6LeGWWosAAAAAFSgorUe63qmWd03Bu6qMNdF_AdJ
   ```

2. **NON commitare mai** API keys nel repository GitHub
3. Aggiungi `.env.local` al `.gitignore` (già fatto)

### Step 5.3: Configurare Cache Strategy

Nel codice (già implementato), la cache è configurata per:
- **Produzione**: Fetch ogni 1 ora (3600000 ms)
- **Development**: Fetch ogni 5 minuti (300000 ms)

Se vuoi modificare:
```typescript
// services/firebase.ts
remoteConfig.settings = {
  minimumFetchIntervalMillis: import.meta.env.MODE === 'production' 
    ? 3600000  // 1 ora in produzione
    : 300000,  // 5 minuti in dev
  fetchTimeoutMillis: 60000
};
```

---

## 🔒 Parte 6: Sicurezza Best Practices

### 6.1 Regole di Sicurezza Remote Config

Firebase Remote Config è **read-only per client**. Le API keys sono:
- ✅ **Protette da App Check**: solo app verificate possono leggere
- ✅ **Nascoste nel codice**: non appaiono in chiaro nel bundle JavaScript
- ✅ **Versionabili**: ogni modifica è tracciata con history

### 6.2 Rotazione API Keys

Se un'API key viene compromessa:

1. Vai su Remote Config
2. Modifica il parametro con la nuova key
3. Clicca **"Publish changes"**
4. L'app riceverà la nuova key al prossimo fetch (max 1 ora)

**Per forzare aggiornamento immediato:**
```typescript
// Nel browser console o in un bottone admin
import { refreshRemoteConfig } from './services/firebase';
await refreshRemoteConfig();
```

### 6.3 Monitoraggio Abusi

1. Vai su **App Check** → **Metrics**
2. Monitora:
   - **Verification success rate**: dovrebbe essere >95%
   - **Failed verifications**: spike potrebbero indicare attacchi
3. Se vedi anomalie, attiva **Enforce mode** immediatamente

---

## 📊 Parte 7: Monitoring & Analytics

### 7.1 Firebase Analytics per Remote Config

1. Vai su **Analytics** → **Events**
2. Cerca eventi:
   - `remote_config_fetch_success`
   - `remote_config_fetch_fail`
   - `remote_config_activate`

### 7.2 App Check Metrics

1. **Verification attempts**: Quante volte l'app ha richiesto verifica
2. **Success rate**: Percentuale di verifiche riuscite
3. **Failed attempts**: Bot o client non autorizzati bloccati

### 7.3 Alert Setup (Consigliato)

1. Vai su **Alerts** (⚠️ icona campana)
2. Crea alert per:
   - **App Check verification rate < 90%**
   - **Remote Config fetch failures > 10/hour**
3. Inserisci email per notifiche

---

## ❓ FAQ & Troubleshooting

### Q: "Remote Config fetch fallisce con errore 403"
**A**: App Check è in modalità **Enforce** ma il token non è valido.
- Verifica che reCAPTCHA sia caricato correttamente
- Controlla domini autorizzati
- Passa App Check a **Monitoring** durante debug

### Q: "Le API keys non vengono caricate"
**A**: Verifica:
1. Parametri pubblicati in Remote Config? (`Publish changes`)
2. App Check attivato? (Console → App Check)
3. Domini autorizzati configurati?
4. Console browser mostra errori?

### Q: "Come ruotare una API key?"
**A**: 
1. Genera nuova key nel servizio (Google Cloud, GitHub, etc.)
2. Vai su Remote Config
3. Modifica il parametro
4. Pubblica
5. Aspetta 1 ora (o forza refresh)

### Q: "Posso vedere le API keys in chiaro nella Console?"
**A**: Sì, ma solo tu (owner/editor del progetto). Gli utenti finali NON possono vederle nel codice dell'app.

### Q: "Quanto costa Firebase Remote Config?"
**A**: **GRATIS** per sempre. Quota giornaliera:
- 1 milione di fetch/giorno
- Bandwidth illimitato per Remote Config

### Q: "App Check è gratis?"
**A**: **GRATIS** fino a 1 milione di verifiche/mese. Oltre:
- $0.005 per 1000 verifiche (~$5 per 1 milione)

---

## ✅ Checklist Finale

Prima di considerare la configurazione completa:

- [ ] Firebase App Check attivato con reCAPTCHA v3
- [ ] Domini autorizzati aggiunti (frontaliereticino.ch, localhost)
- [ ] 5 parametri Remote Config creati e pubblicati
- [ ] Test locale mostra logs di successo
- [ ] Metrics App Check mostrano verifiche riuscite
- [ ] .env.local ripulito da API keys sensibili
- [ ] .gitignore include .env.local
- [ ] Alert configurati per monitoring

---

## 📚 Risorse

- [Firebase App Check Docs](https://firebase.google.com/docs/app-check)
- [Remote Config Docs](https://firebase.google.com/docs/remote-config)
- [reCAPTCHA v3 Docs](https://developers.google.com/recaptcha/docs/v3)
- [Firebase Security Rules](https://firebase.google.com/docs/rules)

---

## 🎯 Prossimi Step

1. **Configura Firebase Console** seguendo questa guida
2. **Testa l'app** localmente per verificare che tutto funzioni
3. **Deploy su produzione** quando sei soddisfatto
4. **Passa App Check a Enforce** dopo 1 settimana di monitoring
5. **Rimuovi API keys da .env.local** definitivamente

---

**Hai completato la configurazione? Torna qui e verifica che tutti i punti della checklist siano ✅**
