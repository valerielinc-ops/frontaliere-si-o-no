# Reddit Posting

Automazione della pubblicazione su Reddit di **offerte di lavoro** e **articoli del blog**, in parallelo all'esistente automazione Facebook e LinkedIn.

## Panoramica

Il sistema pubblica automaticamente due tipi di contenuto su community Reddit:

- **Offerte di lavoro** — un workflow giornaliero (`reddit-jobs-daily-schedule.yml`) seleziona alcune offerte non ancora pubblicate e le posta su Reddit a basso volume.
- **Articoli del blog** — al termine di un deploy `workflow_dispatch` che ha generato un nuovo articolo, lo step "Post to Reddit Communities" in `post-deploy-publish.yml` pubblica l'articolo, esattamente come fanno gli step Facebook e LinkedIn (stessa condizione `if:`, stessi argomenti posizionali).

Si rapporta al workflow Facebook così: condivide lo stesso punto di ancoraggio (post-deploy per gli articoli, schedule giornaliero per i job), lo stesso meccanismo di caricamento segreti (`load-rc-env.mjs` da Firebase Remote Config) e lo stesso pattern di ledger committato su `main` con resolver dei conflitti. La differenza fondamentale è che **Reddit non ha scheduling lato server**: mentre Facebook accoda fino a 144 post programmati nelle 24 h successive, Reddit pubblica subito e quindi il volume è deliberatamente basso (default 2/run) per rispettare le regole anti-spam delle community.

## Architettura / file coinvolti

| File | Ruolo |
|------|-------|
| `scripts/lib/reddit-client.mjs` | Client OAuth2 di Reddit: grant via refresh-token (preferito) con fallback al password-grant per "script app"; token endpoint in Basic-auth; header `User-Agent` obbligatorio. |
| `scripts/lib/reddit-templates.mjs` | Builder dei post in italiano (titolo + corpo markdown per le offerte, titolo + link per gli articoli). |
| `data/reddit-subreddits.json` | Configurazione dei subreddit: `displayName`, `topics`, `allowsAutomation`, `flairId`, `flairText`, `rulesUrl`, `minPostIntervalHours`, `notes`, più `routing` per `jobs`/`articles`. Solo `frontalieri` ha `allowsAutomation: true` di default. |
| `scripts/post-to-reddit.mjs` | Pubblicazione di un singolo **articolo**. CLI: `node scripts/post-to-reddit.mjs <article-id> <article-url> <og-title> <og-description> [category] [--dry-run]`. Soft-fail (exit 0). |
| `scripts/schedule-reddit-jobs-daily.mjs` | Pubblicazione giornaliera delle **offerte**. Env: `REDDIT_JOB_VOLUME` (default 2), `REDDIT_POST_DELAY_MS` (default 5000), `DRY_RUN`. Aggiorna `data/reddit-posted-jobs.json`. |
| `scripts/lib/resolve-reddit-posted-jobs-conflict.mjs` | Merge-driver per risolvere i conflitti git sul ledger (unione per job id). |
| `.github/workflows/reddit-jobs-daily-schedule.yml` | Cron giornaliero (`45 13 * * *`) + `workflow_dispatch` che lancia lo scheduler dei job. |
| `.github/workflows/post-deploy-publish.yml` | Contiene lo step "Post to Reddit Communities" per gli articoli (dopo lo step LinkedIn). |
| `data/reddit-posted-jobs.json` | Ledger dei job già pubblicati (dedup per id). |

## Setup OAuth Reddit (passi manuali)

1. Vai su <https://www.reddit.com/prefs/apps> ed esegui il login con l'account che pubblicherà.
2. Crea una nuova app:
   - **script app** — più semplice, adatta al password-grant; ottieni `client_id` (la stringa sotto il nome dell'app) e `client_secret`.
   - **web app** — necessaria se vuoi usare il refresh-token grant (consigliato per non memorizzare la password).
3. Annota `client_id` e `client_secret`.

### Due modalità di autenticazione

- **Refresh token (preferito).** Esegui una volta il flusso OAuth2 di una "web app" per ottenere un `refresh_token` con gli scope `submit` + `identity`. Il client lo usa per ottenere access token freschi senza esporre la password.
- **Password grant (fallback per "script app").** Il client autentica con `REDDIT_USERNAME` + `REDDIT_PASSWORD`. Funziona solo per le "script app" e con account senza 2FA (o usando una app-password).

### Header User-Agent (OBBLIGATORIO)

Reddit **rifiuta** le richieste senza un `User-Agent` descrittivo e univoco. Formato richiesto:

```
platform:appid:version (by /u/username)
```

Esempio:

```
node:frontaliereticino-poster:1.0.0 (by /u/iltuousername)
```

### Parametri Remote Config da impostare

Imposta questi parametri in Firebase Remote Config (i secret con prefisso `SERVER_` non vengono mai esposti al client; vedi `scripts/load-rc-env.mjs`):

| Parametro RC | Env var | Tipo |
|--------------|---------|------|
| `REDDIT_CLIENT_ID` | `REDDIT_CLIENT_ID` | client-visible |
| `SERVER_REDDIT_CLIENT_SECRET` | `REDDIT_CLIENT_SECRET` | secret |
| `REDDIT_USERNAME` | `REDDIT_USERNAME` | client-visible |
| `SERVER_REDDIT_PASSWORD` | `REDDIT_PASSWORD` | secret |
| `SERVER_REDDIT_REFRESH_TOKEN` | `REDDIT_REFRESH_TOKEN` | secret |
| `REDDIT_USER_AGENT` | `REDDIT_USER_AGENT` | client-visible |

## Regole delle community & anti-spam

- **Regola 9:1 di Reddit.** L'autopromozione deve restare minoritaria: per ogni post promozionale dovresti avere ~9 contributi non promozionali (commenti, risposte, contenuti utili). Spammare offerte/link viola questa regola e porta a shadowban o ban.
- **La maggior parte dei subreddit vieta lo spam di offerte.** Community come r/Ticino, r/Svizzera, r/italiansinswitzerland proibiscono il posting automatico di annunci e richiedono l'**approvazione dei moderatori**. Per questo `allowsAutomation` è `false` di default su tutti i subreddit tranne il nostro **r/frontalieri** (safe-by-default: si auto-pubblica solo sulla nostra community finché un umano non ottiene il permesso dei mod altrove).
- **Nessuno scheduling lato server.** Reddit non offre code di pubblicazione programmata: lo script pubblica **subito**, a basso volume (default 2/run) e con un `REDDIT_POST_DELAY_MS` (default 5000 ms) tra un post e l'altro.

### Abilitare un subreddit di terze parti (passi manuali)

1. Contatta i moderatori del subreddit e chiedi il permesso esplicito di pubblicare offerte in automatico.
2. Ottieni l'eventuale **flair** richiesto dal subreddit (molte community impongono un flair specifico per gli annunci di lavoro).
3. Recupera il `flairId` (e l'eventuale `flairText`): di solito va scoperto manualmente tramite l'API dei flair del subreddit o chiedendolo ai mod.
4. In `data/reddit-subreddits.json` imposta `allowsAutomation: true` per quel subreddit e compila `flairId`/`flairText` e `rulesUrl`.
5. Aggiungi il subreddit alle liste `routing.jobs` e/o `routing.articles` secondo i `topics`.

## Gestire una community propria (r/frontalieri)

Il canale sicuro e controllato è un subreddit di nostra proprietà:

1. Crea il subreddit (es. r/frontalieri) dal tuo account; diventi automaticamente moderatore.
2. Definisci regole e flair coerenti con i contenuti (offerte + articoli).
3. Poiché ne sei mod, l'automazione è consentita senza dipendere dall'approvazione di terzi: è l'unico subreddit con `allowsAutomation: true` di default.
4. Mantieni un rapporto sano contenuti utili / promozioni anche qui, per far crescere la community e non scoraggiare gli iscritti.

## Logging / tracking

- **Ledger `data/reddit-posted-jobs.json`.** Tiene traccia dei job già pubblicati per dedup **per job id**: un'offerta viene pubblicata una sola volta. Ogni entry registra il subreddit di destinazione e il **reddit post id** restituito dall'API.
- **Resolver dei conflitti.** `scripts/lib/resolve-reddit-posted-jobs-conflict.mjs` è un merge-driver che unisce le entry per id quando un altro commit aggiorna il ledger su `main` mentre il workflow è in corso (es. un workflow articoli concorrente). Senza di esso il push fallirebbe e il ledger andrebbe fuori sincrono rispetto a ciò che è stato realmente pubblicato. Il workflow lo invoca via `git-push-with-retry.sh --in-place-resolver-cmd`.

## Esecuzione

**Esegui sempre prima un dry-run.**

Offerte (scheduler):

```bash
DRY_RUN=1 node scripts/schedule-reddit-jobs-daily.mjs
# volume personalizzato e delay:
DRY_RUN=1 REDDIT_JOB_VOLUME=1 REDDIT_POST_DELAY_MS=5000 node scripts/schedule-reddit-jobs-daily.mjs
```

Articolo singolo:

```bash
node scripts/post-to-reddit.mjs <article-id> <article-url> "<og-title>" "<og-description>" <category> --dry-run
```

Come li lanciano i workflow GitHub Actions:

- **Offerte** — `reddit-jobs-daily-schedule.yml` gira ogni giorno alle `45 13 * * *` (UTC) e si può lanciare a mano via `workflow_dispatch` scegliendo `volume` (1/2/5) e `dry_run` (true/false). Esegue `load-rc-env.mjs` → `assemble-jobs-dataset.mjs --stats` → `schedule-reddit-jobs-daily.mjs`, poi committa `data/reddit-posted-jobs.json`.
- **Articoli** — lo step "Post to Reddit Communities" in `post-deploy-publish.yml` parte solo dopo un deploy `workflow_dispatch` con un nuovo articolo e metadata live verificati (stesse condizioni di FB/LinkedIn). È `continue-on-error: true`: un errore Reddit non blocca il deploy.

## Template di esempio (italiano)

**Post-offerta** (titolo + corpo markdown), come generato dal builder:

```
Titolo:
[Lavoro] Operatore di produzione — Chiasso (TI) | Frontalieri Ticino

Corpo:
**Operatore di produzione** a **Chiasso (TI)**.

- 💼 Contratto: tempo pieno
- 📍 Sede: Chiasso, Canton Ticino
- 💰 Salario indicativo: da definire con l'azienda

Dettagli e candidatura 👉 https://frontaliereticino.ch/offerte/operatore-di-produzione-chiasso

*Annuncio pubblicato per i lavoratori frontalieri in Ticino.*
```

**Post-articolo** (titolo + link), come generato dal builder:

```
Titolo:
Richiesta Permesso G passo dopo passo nel 2026 — guida aggiornata

Link:
https://frontaliereticino.ch/blog/richiesta-permesso-g-step-by-step-2026
```

## Limitazioni note

- **Access token a vita breve (~1 h).** Il client deve rinnovarlo a ogni run; con il password-grant questo richiede credenziali valide, con il refresh-token grant richiede un `REDDIT_REFRESH_TOKEN` non revocato.
- **Rischio anti-spam / ban.** Volume alto, mancato rispetto della regola 9:1 o posting in subreddit non consenzienti possono portare a shadowban o ban dell'account.
- **Nessuno scheduling nativo.** A differenza di Facebook, Reddit pubblica subito: il throttling è solo client-side (volume basso + delay).
- **Dipendenza dall'approvazione dei mod.** L'espansione oltre r/frontalieri richiede il permesso esplicito dei moderatori di ogni subreddit.
- **Flair id da scoprire manualmente.** I `flairId`/`flairText` richiesti da molte community vanno recuperati a mano e inseriti in `data/reddit-subreddits.json`.
