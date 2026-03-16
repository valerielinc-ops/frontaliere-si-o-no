# Configurazione Firebase — Google Sign-In & Firestore

Guida per configurare Firebase Authentication (Google) e Cloud Firestore per il progetto **Frontaliere Ticino**

---

## 1. Accedi alla Console Firebase

1. Vai su [console.firebase.google.com](https://console.firebase.google.com)
2. Seleziona il progetto **frontaliere-ticino**
3. Se non esiste, creane uno nuovo con lo stesso `projectId`

---

## 2. Abilita Google Sign-In (Authentication)

1. Nella console Firebase, vai su **Build → Authentication**
2. Clicca sulla tab **Sign-in method**
3. Clicca su **Google** nella lista dei provider
4. Abilita il toggle **Enable**
5. Compila i campi:
   - **Project public-facing name**: `Frontaliere Ticino`
   - **Project support email**: seleziona la tua email
6. Clicca **Save**

### Configura i Domini Autorizzati

Sempre in **Authentication → Settings → Authorized domains**, verifica che siano presenti:

- `localhost` (per sviluppo locale)
- `frontaliere-ticino.firebaseapp.com` (authDomain legacy)
- `auth.frontaliereticino.ch` (authDomain custom per OAuth)
- `www.frontaliereticino.ch` (dominio di produzione)
- `frontaliereticino.ch`

Se manca il dominio di produzione, clicca **Add domain** e aggiungilo.

> **IMPORTANTE**: Senza il dominio di produzione autorizzato, il popup di Google Sign-In verrà bloccato.

---

## 3. Configura Firestore Database

1. Vai su **Build → Firestore Database**
2. Clicca **Create database**
3. Scegli la **location** più vicina: `europe-west6` (Zurigo) è ideale
4. Seleziona **Start in production mode** (configureremo le regole dopo)
5. Clicca **Create**

### Regole di Sicurezza Firestore

Vai su **Firestore Database → Rules** e incolla queste regole:

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // ─── Dashboard: Simulazioni personali ───
    match /simulations/{simId} {
      // Solo l'utente proprietario può leggere/scrivere
      allow read, write: if request.auth != null
                         && request.auth.uid == resource.data.userId;
      allow create: if request.auth != null
                    && request.auth.uid == request.resource.data.userId;
    }

    // ─── Forum: Domande ───
    match /forum_questions/{questionId} {
      // Tutti possono leggere
      allow read: if true;
      // Solo utenti autenticati possono creare
      allow create: if request.auth != null;
      // Solo l'autore può aggiornare (titolo/body), ma upvotes sono aperti
      allow update: if request.auth != null;
      // Solo l'autore può eliminare
      allow delete: if request.auth != null
                    && request.auth.uid == resource.data.authorId;
    }

    // ─── Forum: Risposte ───
    match /forum_answers/{answerId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update: if request.auth != null;
      allow delete: if request.auth != null
                    && request.auth.uid == resource.data.authorId;
    }
  }
}
```

Clicca **Publish** per applicare le regole.

### Indici Firestore

Il sistema crea query con filtri combinati. Crea questi indici compositi in **Firestore → Indexes → Composite**:

| Collection        | Campi                            | Ordine            |
|-------------------|----------------------------------|--------------------|
| `forum_questions` | `category` ASC, `createdAt` DESC | Query scope: Collection |
| `forum_questions` | `category` ASC, `upvotes` DESC   | Query scope: Collection |
| `simulations`     | `userId` ASC, `createdAt` DESC   | Query scope: Collection |

> **Tip**: Firebase creerà automaticamente gli indici necessari se esegui una query che li richiede — vedrai un link di errore nella console del browser che ti porta direttamente alla pagina per creare l'indice mancante.

---

## 4. Verifica la configurazione Firebase nel codice

Il file `services/firebase.ts` contiene già la configurazione del progetto. Verifica che corrisponda:

```
projectId: 'frontaliere-ticino'
authDomain: 'auth.frontaliereticino.ch'
```

Il custom domain `auth.frontaliereticino.ch` è configurato su Firebase Hosting
per servire l'auth handler OAuth (`/__/auth/handler`). Questo fa sì che il popup
di Google mostri "Continua su auth.frontaliereticino.ch" invece del dominio Firebase.

---

## 5. App Check (opzionale ma consigliato)

App Check è già configurato nel progetto con reCAPTCHA v3. Per abilitarlo anche per Auth e Firestore:

1. Vai su **Build → App Check**
2. Verifica che la tua web app sia registrata con reCAPTCHA v3
3. In **App Check → APIs**, abilita l'enforcement per:
   - **Cloud Firestore**
   - **Authentication** (opzionale)

---

## 6. Test locale

1. Avvia il dev server: `npm run dev`
2. Vai alla sezione **Dashboard** o **Community**
3. Clicca **Accedi con Google**
4. Dovrebbe aprirsi il popup di Google per la selezione dell'account
5. Dopo il login, le simulazioni si sincronizzano con Firestore
6. Nel forum puoi creare domande e risposte

### Troubleshooting

| Problema | Soluzione |
|----------|-----------|
| Popup bloccato dal browser | Assicurati che i popup siano abilitati per `localhost` |
| `auth/unauthorized-domain` | Aggiungi il dominio in Authentication → Authorized domains |
| `permission-denied` su Firestore | Verifica le regole di sicurezza (sezione 3) |
| Indice mancante | Clicca il link nell'errore della console per creare l'indice |
| `auth/popup-closed-by-user` | L'utente ha chiuso il popup — nessuna azione necessaria |

---

## 7. Newsletter webhook via Firebase Functions

Per ricevere gli eventi di `Resend` in produzione, il progetto espone una Cloud Function HTTP v2:

- function name: `newsletterResendWebhook`
- region: `europe-west6`
- codebase Firebase: `newsletter-webhooks`

### Prerequisiti

1. Installa le dipendenze della codebase functions:
   - `cd functions && npm install`
2. Associa il progetto Firebase corretto:
   - `firebase use frontaliere-ticino`
3. Configura i secret richiesti:
   - `firebase functions:secrets:set RESEND_API_KEY`
   - `firebase functions:secrets:set RESEND_WEBHOOK_SECRET`

### Deploy

```bash
firebase deploy --only functions:newsletterResendWebhook
```

### Endpoint atteso

Dopo il deploy, usa l'URL restituito da Firebase come webhook Resend, ad esempio:

```text
https://newsletterresendwebhook-<hash>-ew.a.run.app
```

### Eventi da configurare in Resend

- `email.sent`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.bounced`
- `email.complained`
- `email.failed`
- `email.suppressed`

### Verifiche post-deploy

Controlla che la function aggiorni correttamente:

- `newsletter_subscribers`
- `newsletter_events`
- `newsletter_campaign_deliveries`

e che il click tracking first-party continui a valorizzare:

- `campaign_id`
- `message_id`
- `section_id`
- `last_click_at`

---

## Riepilogo Servizi Firebase Utilizzati

| Servizio | Uso | File |
|----------|-----|------|
| **Authentication** | Google Sign-In | `services/authService.ts` |
| **Firestore** | Simulazioni cloud + Forum Q&A | `services/firestoreService.ts` |
| **Analytics** | Tracking eventi GA4 | `services/analytics.ts` |
| **Remote Config** | API keys runtime | `services/firebase.ts` |
| **App Check** | Protezione reCAPTCHA v3 | `services/firebase.ts` |
