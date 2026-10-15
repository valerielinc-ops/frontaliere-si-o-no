# Audit — Bollettino email

> Audit a codice statico + DNS pubblico, eseguito il 2026-08-10 nell'ambito della issue #5555.
> Metodo: ispezione di `scripts/`, `functions/src/`, `.github/workflows/`, `tests/`, e lookup DNS pubblici
> (`dig`) sul dominio `frontaliereticino.ch`. **Non include** dati live da provider (delivery/open/bounce
> reali) né screenshot di rendering client — quell'accesso richiede credenziali (Firebase SA / provider
> dashboard) non disponibili in questo ambiente CI; vedi §7 "Non verificabile in questo audit".

Il sito ha **due sistemi email distinti**, entrambi in ambito:

| Sistema | Cadenza | Script | Workflow |
|---|---|---|---|
| Newsletter settimanale (jobs/tax/general, segmentata) | giornaliero per-subscriber (invio scaglionato sull'ora locale del destinatario, non un big-bang) | `scripts/send-newsletter.mjs` | `.github/workflows/send-newsletter.yml` (cron `33 3 * * *` UTC) |
| Bollettino del Frontaliere (daily brief editoriale) | 2×/giorno | `scripts/send-daily-brief.mjs` | `.github/workflows/send-daily-brief.yml` (cron `33 6,9 * * *` UTC) |

## 1. Trigger, scheduling e contenuto

- **Newsletter settimanale**: `send-newsletter.yml`, cron giornaliero `33 3 * * *` (03:33 UTC). Il commento nel
  workflow documenta un'analisi audit del 2026-08-05 (#3798): l'orario nominale non è l'orario reale di
  esecuzione (GitHub scheduled-dispatch backlog, mediana +160min), e da quando esiste lo scheduling
  per-subscriber (`scripts/lib/send-schedule.mjs`) il cron decide solo quando la campagna viene composta,
  non quando arriva in inbox — il provider trattiene ogni messaggio fino all'ora locale del singolo iscritto.
  **Già auditato e documentato**, nessuna azione necessaria qui.
- **Bollettino daily brief**: `send-daily-brief.yml`, cron 2×/giorno (`33 6,9`). Contenuto generato dal corpus
  esterno `nanakokyobashi-rgb/frontaliere-articles` (repo separato) via `scripts/lib/daily-brief-content.mjs`.
- **Selezione/ranking contenuti**: la newsletter deriva dinamicamente da Firestore (tasso di cambio, top 3
  articoli per view, weekly fact, tool rotante settimanale su 6 calcolatori) — vedi `services/newsletter-content.mjs`.
  Nessun contenuto statico hardcoded oltre il template.
- **Duplicati/vuoti/scaduti**: `NEWSLETTER_SYSTEM_ANALYSIS.md` (root repo, analisi pregressa più ampia)
  documenta i safety gate (`NEWSLETTER_EXPERIMENTAL_MODE`, `NEWSLETTER_ENABLE_SEND`) che bloccano invii
  accidentali; `tests/newsletter-qa-gate.test.ts` copre contenuti-scaduti/qualità pre-invio.
- **Link assoluti/HTTPS/UTM**: confermato — `services/newsletter-content.mjs`/template usano
  `BASE_URL = 'https://frontaliereticino.ch'` e UTM standard
  `utm_source=newsletter&utm_medium=email&utm_campaign=weekly_YYYY-MM-DD` (verificato in `NEWSLETTER_SYSTEM_ANALYSIS.md`
  e `tests/newsletter-template-tracking.test.ts`).
- **Fallback immagini/logo**: gestiti via CSS inline (email-safe) — non ri-verificato riga per riga in
  questo audit (basso rischio, coperto da `tests/newsletter-email-quality.test.ts`).

**Gap noto e già tracciato**: issue #5415 (OPEN, `fu-parked`+`needs-human`, aperta 2026-08-08) documenta due
problemi concreti e non banali sul **bollettino daily brief**, distinti da quanto sopra:
1. Markdown-lite (tabelle pipe, bold/link/callout) non renderizzato correttamente nella versione idratata
   SPA vs quella statica — costrutti mostrati crudi.
2. L'email del bollettino quotidiano è visivamente indistinguibile dalla newsletter settimanale (nessuna
   identità propria) — rischio percepito di spam/duplicazione per il destinatario che riceve entrambe.

Questo è il gap più concreto e ad alto impatto trovato nell'intero audit del bollettino; è già stato
diagnosticato in profondità (issue #5415, con riferimenti a righe di codice precisi su due repo) e marcato
`needs-human` — **non ri-diagnosticato qui** per evitare duplicazione di lavoro (stessa root cause, issue
già aperta). Vedi tabella priorità §6.

## 2. Deliverability e compliance

### DNS (lookup pubblico, 2026-08-10)

```
TXT frontaliereticino.ch:
  v=spf1 include:spf.mailjet.com include:sendersrv.com include:mailgun.org
        include:_spf.maileroo.com include:_spf.mx.cloudflare.net ~all
  google-site-verification=... (ownership Search Console — vedi audit Discover)
  MX: route1/2/3.mx.cloudflare.net (Cloudflare Email Routing)

TXT _dmarc.frontaliereticino.ch:
  v=DMARC1; p=reject; pct=100; fo=1; ri=86400; rf=afrf; rua=...; ruf=...
```

- **DMARC è già a `p=reject`** (enforcement pieno) — confermato anche da GitHub issue #2673 ("DMARC:
  p=reject", chiusa 2026-06-22), risultato di una progressione automatica `p=none → p=quarantine → p=reject`
  gestita da `scripts/dmarc-monitor.mjs`.
- **DKIM presente** per almeno mailjet e resend (selettori `mailjet._domainkey`, `resend._domainkey`
  verificati via `dig`). Non tutti i selettori per-provider sono ricavabili da lookup pubblico spot senza
  conoscere il naming esatto di ciascun provider (mailgun/maileroo/cloudflare usano selettori generati che
  variano); questo NON è un gap — è esattamente il motivo per cui esiste il watchdog automatico (punto sotto).
- **Non serve un audit DNS manuale ricorrente**: `scripts/dmarc-monitor.mjs` + `.github/workflows/dmarc-monitor.yml`
  leggono i report aggregati RUA reali via Cloudflare GraphQL (non spot-check DNS) e aprono automaticamente
  una issue `priority:high` quando una sorgente fallisce DMARC in volume (esempio reale: issue #3066, chiusa),
  e una issue `priority:low` quando è sicuro avanzare la policy di un gradino. Questo meccanismo è **più
  affidabile** di un audit manuale one-off perché usa dati reali di consegna, non un'istantanea DNS.
  **Azione per questo audit**: nessuna — il sistema di monitoraggio esiste già e funziona (progressione fino
  a `p=reject` ne è la prova). Verificare periodicamente `gh issue list --search "dmarc" --state all` per lo
  storico.
- **Mittente**: `newsletter@frontaliereticino.ch` (newsletter settimanale),
  `confirmation@frontaliereticino.ch` (double opt-in, vedi `functions/src/newsletterConfirmationEmail.js`).
  Dominio allineato al brand.
- **Cascade multi-provider**: `functions/src/emailCascade.js` — provider attivi: `mailgun`, `mailjet`,
  `resend` (piano a pagamento attivato 2026-07-06, 50k/mese), `cloudflare`, `maileroo`. **`mailtrap` è stato
  rimosso dalla cascade il 2026-07-29** (owner decision, commento in codice: l'API accettava messaggi senza
  mai consegnarli, e il webhook `suspension` marcava erroneamente >1700 iscritti come soppressi). Nota minore:
  gli indirizzi `dmarc@smtp-staging.mailtrap.net` sono ancora presenti nel record `_dmarc` come destinatario
  report RUA/RUF — innocuo (riceve solo report aggregati, non blocca nulla) ma stale; pulizia DNS non urgente,
  fuori dallo scope di questo repo (richiede accesso al pannello DNS, non versionato qui).

### Bounce, suppression, unsubscribe, double opt-in

Tutti presenti e con copertura test dedicata:
- `functions/src/lib/bounceClassification.js`, `functions/src/lib/emailSuppression.js` — classificazione
  bounce e suppression list.
- `functions/src/lib/subscriberReactivation.js`, `scripts/dev/reactivate-false-positive-bounces.mjs` — gestione
  falsi positivi (rilevante dato l'incidente mailtrap sopra).
- Webhook dedicati per provider: `newsletterResendWebhookCore.js`, `newsletterMailgunWebhookCore.js`,
  `newsletterMailjetWebhookCore.js`, `newsletterMailerooWebhookCore.js`, `newsletterMailtrapWebhookCore.js`
  (legacy, provider rimosso ma webhook mantenuto per compat storica).
- **Double opt-in**: `functions/src/newsletterConfirmationEmail.js` — token HMAC, cooldown 1h anti-spam.
  Coperto da `tests/newsletter-confirmation.test.ts`.
- **Unsubscribe one-click**: `tests/newsletter-unsubscribe-oneclick.test.ts`, `tests/newsletter-subscriber-status.test.ts`.
- **Engagement/rate-limit**: `functions/src/lib/engagementScore.js`, `tests/newsletter-engagement-ratelimit.test.ts`
  — infra di rallentamento invii per destinatari a basso engagement (rilevante per il punto "no spam" di #5415).

**Verdetto**: la compliance strutturale (opt-in, unsubscribe, bounce, SPF/DKIM/DMARC) è **matura e già
monitorata in autonomia**. Non è il gap che l'issue sospettava; il gap reale è editoriale/UX (§1, #5415).

## 3. Analytics

- **Tracking eventi**: `services/analytics.ts` — evento dedicato `newsletter` (subscribe/unsubscribe, azioni)
  loggato via gtag.js (GA4-compatibile) + Firebase Analytics in parallelo (righe ~851-873: gestione esplicita
  del doppio tracking per compensare ad-blocker su gtag.js, ~30-40% utenti).
- **UTM**: `utm_source=newsletter&utm_medium=email&utm_campaign=weekly_YYYY-MM-DD` su ogni link — misurabile
  lato GA4 come landing/sorgente traffico.
- **Delivery/bounce/click a livello provider**: catturati via webhook (§2) e persistiti (Firestore, non
  ispezionato in questo audit — dato, non codice).
- **KPI dashboard consolidata (delivery rate, CTR, conversione a candidatura, unsubscribe rate)**: esiste
  `scripts/newsletter-ab-report.mjs` (report A/B subject-line), ma **non è stato trovato uno script/workflow
  che consolidi delivery-rate + CTR + conversion + unsubscribe-rate in un'unica dashboard/report periodico**.
  Questo è un **gap reale**, coerente con quanto chiesto esplicitamente dalla issue ("Definire dashboard KPI").

## 4. Test rendering client (Gmail/Apple Mail/Outlook)

Non trovato un harness automatizzato di rendering cross-client (es. Litmus/Email on Acid) nel repo. Il
template usa CSS inline + `@media (prefers-color-scheme: dark)` (buona pratica per compatibilità), validato
da `tests/newsletter-email-quality.test.ts` (struttura/contenuto HTML), ma **non da un test di rendering
visivo reale**. Un invio di test reale su Gmail/Outlook/Apple Mail richiede l'invio effettivo di un'email a
caselle reali — **non eseguibile in questo audit** (nessuna casella di test configurata in CI, e un invio
reale da CI sarebbe comunque una side-effect esterna da evitare in un run di audit).

## 5. Priorità

| # | Rilievo | Stato | Priorità | Azione | Evidenza |
|---|---|---|---|---|---|
| 1 | Bollettino daily brief: markdown non renderizzato + nessuna identità visiva distinta dalla newsletter settimanale | Bloccante percepito (rischio "sembra spam") | **Alta** | Già in issue #5415 (`needs-human`, `fu-parked`) — riprendere da lì, non ri-aprire | #5415 |
| 2 | Nessuna dashboard KPI consolidata (delivery/CTR/conversione/unsubscribe) | Gap | Media | Costruire script che aggrega i webhook event già persistiti (nessun nuovo tracking da aggiungere) | §3 |
| 3 | Nessun test automatizzato di rendering cross-client | Gap | Bassa | Valutare integrazione Litmus/Email-on-Acid API (richiede credenziali/servizio esterno) | §4 |
| 4 | `_dmarc` RUA/RUF elenca ancora `mailtrap.net` (provider rimosso dalla cascade il 2026-07-29) | Cosmetico | Bassa | Pulizia DNS manuale (fuori repo) — nessun impatto funzionale | §2 |

## 6. Già OK — nessuna azione richiesta

- Trigger/scheduling newsletter e bollettino: mappati, già auditati (#3798 per lo scheduling).
- SPF/DKIM presenti per i provider attivi; DMARC a `p=reject` con monitoraggio automatico continuo
  (`dmarc-monitor.mjs`/`.yml`), storicamente efficace (progressione automatica documentata da issue chiuse).
- Double opt-in, unsubscribe one-click, bounce/suppression: implementati e coperti da test dedicati.
- UTM e link HTTPS assoluti: presenti e testati.
- Eventi GA4/Firebase Analytics per azioni newsletter: presenti.

## 7. Non verificabile in questo audit (richiede credenziali/accesso non disponibili in CI issue-fix)

- Dati reali di delivery/open/bounce/CTR (richiede accesso Firestore/dashboard provider, Firebase SA non
  disponibile in questo ambiente).
- Test di rendering reale su Gmail/Apple Mail/Outlook (richiede invio a caselle reali o servizio esterno a
  pagamento tipo Litmus).
- Verifica GA4 "sessioni e conversioni dal bollettino" con numeri reali (richiede accesso al progetto
  GA4/Firebase Analytics).

Questi punti restano nei criteri di accettazione della issue ma vanno eseguiti da un umano con accesso alle
dashboard/credenziali indicate, oppure delegati a un run con Firebase SA disponibile (es. `/fix-issue`
locale, non il fixer CI automatico).
