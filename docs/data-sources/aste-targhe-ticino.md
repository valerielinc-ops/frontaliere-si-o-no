# Ticino — asta targhe (`www4.ti.ch/di/sc/veicoli/asta-targhe`)

Verifica di rete (issue #6356, follow-up di #4854 Fase 0), 2026-08-27.

## Metodo

Le due verifiche precedenti (18-08, 23-08, entrambe `no-root-cause`) avevano
controllato solo l'HTML statico della pagina. Questa verifica ha usato
Playwright headless (`page.on('request')`/`page.on('response')`) per
catturare ogni richiesta di rete durante il caricamento della pagina e
un'interazione minima (click sul checkbox della sezione "01 PARTECIPARE").

## Esito: nessun endpoint JSON/API, form assente, il vero modulo è esterno ed è irraggiungibile

1. **`https://www4.ti.ch/di/sc/veicoli/asta-targhe` non contiene alcun `<form>`**
   (`document.querySelectorAll('form')` → `[]`) e non emette nessuna XHR/fetch
   con dati di asta — solo Google Maps embed, Google Fonts, Matomo
   (`statistiche.ti.ch`) e un beacon di terze parti (`rb_bf82386zzu`).
2. Il vero modulo interattivo **non è su questa pagina**: il bottone
   "Asta targhe" (sezione "01 PARTECIPARE") è un link a un sistema esterno,
   `https://www.carieauktion.ti.ch/ecari-auktion/` (piattaforma d'asta
   white-label separata dal CMS ti.ch — non un endpoint JSON dietro la stessa
   pagina). Il codice sorgente contiene anche un `<input type="button" ...
   disabled="true">` equivalente **commentato** (versione precedente
   checkbox-gated, mai rimossa), rimpiazzato da un `<a>` sempre cliccabile.
3. **Quel sistema esterno risponde HTTP 200 ma è vuoto/decommissionato**:
   ogni path testato (`/ecari-auktion/`, `/ecari-auktion`, `/`) sulla
   sottodominio `www.carieauktion.ti.ch` restituisce la pagina generica
   ti.ch **"Pagina non disponibile"** ("la pagina desiderata non è
   disponibile oppure non è accessibile"), confermato sia via `curl` diretto
   (headers `X-Frame-Options`/`X-Content-Type-Options` di ti.ch, non un
   blocco anti-bot) sia via `curl` con `Referer` impostato sulla pagina di
   partenza sia via Playwright — stesso esito in tutti e tre i casi, quindi
   non è un blocco headless-detection: la piattaforma stessa è down o
   spostata.
4. `robots.txt` di `www4.ti.ch` non blocca `/di/sc/veicoli/asta-targhe`
   (`Allow: /`, nessun `Disallow` sul percorso); irrilevante per
   `carieauktion.ti.ch`, che non ha contenuto raggiungibile da verificare.

## Verdetto

**Nessun endpoint JSON/API scopribile**, e la ragione non è un modulo
anti-spam ben nascosto: è che il sistema d'asta reale (`carieauktion.ti.ch`)
è irraggiungibile in questo momento, indipendentemente dal metodo di accesso
(browser reale, headless, richiesta diretta). Non c'è nulla da automatizzare
finché quel sistema non torna online — e quando tornerà, la superficie di
rete da ri-ispezionare è quella sottodominio, non `www4.ti.ch`.

Il connettore Ticino resta **`blocked`** su questa fonte specifica. Prossimo
passo, se si vuole riprovare: ripetere la stessa cattura di rete puntando
direttamente a `https://www.carieauktion.ti.ch/ecari-auktion/` quando risulta
di nuovo popolata (non più "Pagina non disponibile").
