# Integrazione reCAPTCHA Enterprise

## Panoramica
reCAPTCHA Enterprise è stato integrato nell'applicazione per proteggere le API a consumo da abusi e bot.

## File Modificati

### 1. **index.html**
- Aggiunto script reCAPTCHA Enterprise: `https://www.google.com/recaptcha/enterprise.js`
- Caricato in modo asincrono con `async defer`

### 2. **.env.local**
```bash
VITE_RECAPTCHA_SITE_KEY=6LeGWWosAAAAAFSgorUe63qmWd03Bu6qMNdF_AdJ
```

### 3. **services/recaptchaService.ts** (NUOVO)
Servizio centralizzato per gestire reCAPTCHA con:
- **Azioni supportate**:
  - `TRAFFIC_DATA` - Richieste dati traffico Google Maps
  - `EXCHANGE_RATES` - Richieste tassi di cambio
  - `FEEDBACK_SUBMIT` - Invio feedback/issue GitHub
  - `API_TEST` - Test API
  - `PAGE_LOAD` - Caricamento pagina

- **Funzionalità principali**:
  - `executeRecaptcha(action)` - Ottiene token per un'azione
  - `canProceed(action)` - Verifica se un'operazione può procedere
  - `getTokenForApi(action)` - Token da inviare al backend
  - **Graceful degradation**: Se reCAPTCHA fallisce, l'operazione procede comunque

### 4. **services/trafficService.ts**
- Integrato reCAPTCHA in `getTrafficData()`
- Verifica token prima di chiamare Google Maps API
- Protegge da richieste eccessive

### 5. **components/FeedbackSection.tsx**
- Integrato reCAPTCHA in `handleSubmit()`
- Verifica token prima di creare issue GitHub
- Protegge da spam e bot

## Come Funziona

### Client-side Flow
```typescript
// 1. Utente esegue un'azione (es. carica traffico)
await trafficService.getTrafficData();

// 2. Il servizio richiede verifica reCAPTCHA
await recaptchaService.canProceed('TRAFFIC_DATA');

// 3. reCAPTCHA genera token invisibile (v3)
const token = await grecaptcha.enterprise.execute(siteKey, { action: 'TRAFFIC_DATA' });

// 4. L'operazione procede (il token può essere inviato al backend)
// ... chiamata API ...
```

### Backend Verification (TODO)
Per una protezione completa, il backend dovrebbe verificare il token:
```typescript
// Backend (Node.js esempio)
const response = await fetch(
  `https://recaptchaenterprise.googleapis.com/v1/projects/${projectId}/assessments`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        token: recaptchaToken,
        siteKey: siteKey,
        expectedAction: 'TRAFFIC_DATA'
      }
    })
  }
);

const assessment = await response.json();
if (assessment.tokenProperties.valid && assessment.riskAnalysis.score > 0.5) {
  // Richiesta legittima - procedi
} else {
  // Bot o attacco - blocca
}
```

## Protezione API Implementata

### ✅ Google Maps Traffic API
- **Dove**: `trafficService.getTrafficData()`
- **Azione**: `TRAFFIC_DATA`
- **Benefici**: Previene flooding della cache (1 ora) con richieste automatizzate

### ✅ GitHub Issues API
- **Dove**: `FeedbackSection.handleSubmit()`
- **Azione**: `FEEDBACK_SUBMIT`
- **Benefici**: Previene spam di issue/feedback

### 🔄 Da Implementare (Facoltativo)
- **Exchange Rates API**: Se implementi API per tassi di cambio
- **Gemini AI API**: Se esponi endpoint per ottimizzazione testo
- **Page Load**: Tracciamento utenti legittimi vs bot

## Vantaggi

### 1. **Invisibile per Utenti Legittimi**
- reCAPTCHA v3 non richiede click "Non sono un robot"
- Funziona in background analizzando comportamento utente
- UX non compromessa

### 2. **Protezione Economica**
- Google Maps: 5,760 richieste/mese (entro free tier 40k)
- Con reCAPTCHA: blocca bot che potrebbero consumare quota
- GitHub API: protegge da spam issue

### 3. **Graceful Degradation**
- Se reCAPTCHA fallisce → operazione procede comunque
- Nessun blocco per problemi tecnici
- Console logs per debug

### 4. **Scalabilità**
- Facile aggiungere nuove azioni
- Servizio centralizzato (`recaptchaService.ts`)
- Type-safe con TypeScript

## Configurazione reCAPTCHA Enterprise

### Dashboard Google Cloud
1. Vai su: https://console.cloud.google.com/security/recaptcha
2. Progetto: **frontaliere-ticino**
3. Site Key: `6LeGWWosAAAAAFSgorUe63qmWd03Bu6qMNdF_AdJ`

### Domini Autorizzati
Aggiungi nel dashboard reCAPTCHA:
- `frontaliereticino.ch`
- `www.frontaliereticino.ch`
- `localhost` (per development)

### Azioni Personalizzate
Nel dashboard puoi vedere analytics per:
- Numero di richieste per azione
- Score medio (0.0 = bot, 1.0 = umano)
- Pattern sospetti

## Testing

### Verificare Funzionamento
1. Apri DevTools → Console
2. Carica la pagina traffico o invia feedback
3. Cerca logs: `✅ reCAPTCHA token ottenuto per azione: TRAFFIC_DATA`

### Testare Graceful Degradation
```typescript
// Nel browser console
window.grecaptcha = undefined; // Simula reCAPTCHA non disponibile
// Prova a usare la funzione - dovrebbe funzionare comunque
```

## Metriche da Monitorare

### Console Google Cloud reCAPTCHA
- **Score medio**: >0.7 = traffico legittimo
- **Richieste/giorno**: Monitora spike anomali
- **Azioni più usate**: `TRAFFIC_DATA` e `FEEDBACK_SUBMIT`

### Console Google Maps API
- **Richieste/mese**: Dovrebbe rimanere <40,000
- **Errori**: Se reCAPTCHA blocca bot, richieste API dovrebbero diminuire

## Note Tecniche

### Performance
- Script caricato in modo asincrono (no blocking)
- Token generato in ~100-300ms
- Cache: 2 minuti per token (gestito da Google)

### Privacy
- reCAPTCHA v3 analizza comportamento utente
- GDPR compliant se dichiarato in Privacy Policy
- Dati condivisi con Google per analisi

### Compatibilità
- Browser moderni (Chrome, Firefox, Safari, Edge)
- Mobile friendly
- No JavaScript = graceful fallback

## Prossimi Step (Opzionale)

1. **Backend Verification**: Implementare verifica token server-side
2. **Custom Actions**: Aggiungere azioni per altre API (exchange rates)
3. **Score Threshold**: Bloccare richieste con score <0.3
4. **Analytics**: Dashboard personalizzata per monitorare bot
5. **Rate Limiting**: Combinare reCAPTCHA con rate limiting basato su IP

## Risorse

- [reCAPTCHA Enterprise Docs](https://cloud.google.com/recaptcha-enterprise/docs)
- [JavaScript API](https://developers.google.com/recaptcha/docs/v3)
- [Site Verification](https://developers.google.com/recaptcha/docs/verify)
