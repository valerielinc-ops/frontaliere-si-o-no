# reCAPTCHA Enterprise - Aggiornamento Chiavi

## ✅ Modifiche Completate

Le chiavi reCAPTCHA Enterprise sono state aggiornate con le nuove credenziali:

### Nuove Chiavi
- **Site Key** (pubblica): `6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59`
- **Secret Key** (privata): `6LcvRmosAAAAADYMc8QueYvyxDh-X0FN307JGK_G`

### File Aggiornati

1. **`.env.local`**
   - Aggiornata `VITE_RECAPTCHA_SITE_KEY` con la nuova site key
   - Aggiunta `RECAPTCHA_SECRET_KEY` per uso server-side (NON esporre nel client!)

2. **`index.html`**
   - Aggiornato script reCAPTCHA con la nuova site key

3. **`services/firebase.ts`**
   - Aggiornata `RECAPTCHA_SITE_KEY` costante

4. **`server/recaptchaVerification.js`** (NUOVO)
   - Codice Node.js completo per verifica server-side
   - Middleware Express per proteggere endpoint API
   - Funzione `createAssessment()` per verificare token
   - Esempi di integrazione

---

## 🔐 Setup Server-Side Verification (Opzionale ma Consigliato)

Per una protezione completa, dovresti verificare i token reCAPTCHA sul tuo backend.

### Prerequisiti

```bash
npm install @google-cloud/recaptcha-enterprise express
```

### Setup Google Cloud Credentials

#### Opzione 1: Service Account (Produzione)

1. Vai su: [Google Cloud Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=frontaliere-ticino)
2. Clicca **"Create Service Account"**
3. Nome: `recaptcha-verifier`
4. Ruolo: **reCAPTCHA Enterprise Agent**
5. Crea chiave JSON e scarica
6. Salva come `service-account-key.json` (aggiungi al `.gitignore`)
7. Imposta variabile d'ambiente:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
   ```

#### Opzione 2: gcloud CLI (Development)

```bash
gcloud auth application-default login
gcloud config set project frontaliere-ticino
```

### Esempio Backend Express

```javascript
const express = require('express');
const { verifyRecaptcha } = require('./server/recaptchaVerification');

const app = express();
app.use(express.json());

// Endpoint protetto per dati traffico
app.post('/api/traffic-data', verifyRecaptcha, async (req, res) => {
  // Token verificato! Score disponibile in req.recaptchaScore
  const trafficData = await fetchGoogleMapsTraffic();
  res.json({ success: true, data: trafficData });
});

// Endpoint protetto per feedback
app.post('/api/feedback', verifyRecaptcha, async (req, res) => {
  // Token verificato! Previene spam
  const issue = await createGitHubIssue(req.body);
  res.json({ success: true, issue });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
```

### Client-Side: Inviare Token al Backend

Modifica i tuoi servizi per inviare il token al backend:

```typescript
// esempio: trafficService.ts
async getTrafficData(): Promise<TrafficData[]> {
  // Ottieni token reCAPTCHA
  const token = await recaptchaService.getTokenForApi('TRAFFIC_DATA');
  
  // Invia al backend invece di chiamare direttamente Google Maps
  const response = await fetch('/api/traffic-data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Recaptcha-Token': token || ''
    },
    body: JSON.stringify({ action: 'TRAFFIC_DATA' })
  });
  
  return response.json();
}
```

---

## 📊 Interpretazione Score reCAPTCHA

Quando verifichi un token sul server, ricevi uno **score da 0.0 a 1.0**:

| Score | Interpretazione | Azione Consigliata |
|-------|----------------|---------------------|
| 1.0 - 0.9 | Molto probabilmente umano | ✅ Permetti |
| 0.9 - 0.7 | Probabilmente umano | ✅ Permetti |
| 0.7 - 0.5 | Incerto | ⚠️ Monitora |
| 0.5 - 0.3 | Probabilmente bot | ❌ Blocca o richiedi 2FA |
| 0.3 - 0.0 | Quasi certamente bot | ❌ Blocca |

### Soglie Consigliate per Azione

```javascript
const THRESHOLDS = {
  PAGE_LOAD: 0.3,        // Molto permissivo
  FEEDBACK: 0.5,         // Medio
  API_CALL: 0.6,         // Google Maps, costoso
  LOGIN: 0.5,            // Medio
  REGISTRATION: 0.7,     // Più rigido
  PAYMENT: 0.8           // Molto rigido
};
```

---

## 🔧 Configurazione Firebase Console

### Update Remote Config

Se usi Firebase Remote Config, aggiorna il parametro:

1. Vai su: [Firebase Console → Remote Config](https://console.firebase.google.com/project/frontaliere-ticino/config)
2. Trova parametro **`RECAPTCHA_SITE_KEY`**
3. Aggiorna valore a: `6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59`
4. Clicca **"Publish changes"**

### Update App Check

1. Vai su: [Firebase Console → App Check](https://console.firebase.google.com/project/frontaliere-ticino/appcheck)
2. Nella sezione **Apps**, trova la tua web app
3. Clicca su **"Edit"** (icona matita)
4. Aggiorna **reCAPTCHA v3 Site Key** a: `6LcvRmosAAAAANg2upkWsseTFrN6eO5erywetm59`
5. Clicca **"Save"**

---

## 🧪 Testing

### Test Client-Side

1. Avvia dev server:
   ```bash
   npm run dev
   ```

2. Apri DevTools → Console
3. Cerca log:
   ```
   ✅ reCAPTCHA token ottenuto per azione: TRAFFIC_DATA
   ✅ Firebase App Check inizializzato con reCAPTCHA v3
   ```

### Test Server-Side (se implementato)

```bash
# Test endpoint con token valido
curl -X POST http://localhost:3000/api/traffic-data \
  -H "Content-Type: application/json" \
  -H "X-Recaptcha-Token: <token-from-client>" \
  -d '{"action":"TRAFFIC_DATA"}'

# Risposta attesa:
# {"success":true,"data":[...]}
```

---

## 📈 Monitoring

### Google Cloud Console

1. Vai su: [reCAPTCHA Enterprise Metrics](https://console.cloud.google.com/security/recaptcha?project=frontaliere-ticino)
2. Monitora:
   - **Score distribution**: Distribuzione degli score
   - **Verification success rate**: Tasso di successo verifica
   - **Failed verifications**: Tentativi bloccati

### Firebase App Check

1. Vai su: [Firebase App Check Metrics](https://console.firebase.google.com/project/frontaliere-ticino/appcheck/metrics)
2. Monitora:
   - **Verification attempts**: Richieste totali
   - **Success rate**: Percentuale successo
   - **Failed attempts**: Bot bloccati

---

## 🚨 Importante: Secret Key Security

⚠️ **NON esporre MAI la Secret Key nel client!**

La `RECAPTCHA_SECRET_KEY` nel `.env.local` è **SOLO per uso server-side**.

✅ **CORRETTO**:
- Server Node.js legge `RECAPTCHA_SECRET_KEY` da `.env`
- Client invia token, server verifica con secret key

❌ **SBAGLIATO**:
- Client legge `RECAPTCHA_SECRET_KEY` da variabile d'ambiente
- Client invia secret key nelle richieste

### Verificare che Secret Key NON sia Esposta

```bash
# Controlla che la secret key NON appaia nel bundle JavaScript
npm run build
grep -r "6LcvRmosAAAAADYMc8QueYvyxDh-X0FN307JGK_G" dist/

# Output atteso: nessun risultato (vuoto)
```

---

## 📦 Next Steps

1. ✅ Chiavi aggiornate nel client (completato)
2. ⬜ Implementare backend Express con verifica server-side (opzionale)
3. ⬜ Configurare Google Cloud Service Account
4. ⬜ Aggiornare Firebase Remote Config e App Check
5. ⬜ Testare in produzione
6. ⬜ Monitorare metriche per 1 settimana
7. ⬜ Attivare mode "Enforce" in App Check

---

## 📚 Risorse

- [reCAPTCHA Enterprise Assessment API](https://cloud.google.com/recaptcha/docs/create-assessment)
- [Server-side Verification](https://cloud.google.com/recaptcha/docs/verify)
- [Score Interpretation](https://cloud.google.com/recaptcha/docs/interpret-assessment)
- [Node.js Client Library](https://github.com/googleapis/google-cloud-node/tree/main/packages/google-cloud-recaptcha-enterprise)
