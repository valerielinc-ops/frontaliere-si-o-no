# Contratto delle pagine dettaglio lavoro

Decisione esplicita del proprietario del 29 ottobre 2026. Sostituisce la
politica statica introdotta dalla PR 10937. Non ripristinare un gate statico
per allinearlo all'anteprima della SPA.

| Superficie | Contenuto | Accesso |
| --- | --- | --- |
| HTML statico / JavaScript disabilitato / prima dell'idratazione | Tutto il testo originale disponibile, requisiti, heading, paragrafi ed elenchi | Completo per ogni utente e user-agent, nessun gate |
| SPA idratata, persona anonima senza accesso email | Anteprima esistente di 220 caratteri più ellissi | Gate gratuito esistente |
| SPA idratata, autenticato oppure accesso email valido | Dettagli sbloccati | Nessun gate |
| SPA idratata, crawler SEO riconosciuto | Testo completo e markup semantico, senza attendere Firebase Auth | Nessun gate |

La regola riguarda offerte attive, scadute, archiviate, fallback storici con
record verificato, vecchi slug, mirror di cantone/locale e bridge con un
dettaglio reale. La mancanza di traffico non autorizza a sostituire il corpo
reale con una thin page. Le offerte publisher `/lavoro/<slug>/` sono pagine
statiche pubbliche conservate dal router anche dopo il boot della shell:
restano complete come prima. `/candidatura/` è un modulo, non un secondo
annuncio, e resta noindex.

Decisione del proprietario del 31 ottobre 2026: l'audit SEO proponeva di
togliere il gate agli utenti anonimi e di omettere `baseSalary` stimato; il
gate resta come nella tabella qui sopra e `baseSalary` resta la stima del
sito, senza etichette e senza rimozioni.

La copertura dei campi JobPosting resta invariata o cresce mentre migliora la
qualità: si sostituisce un valore debole con un valore migliore, non si omette
il campo. `streetAddress` resta obbligatorio e segue la gerarchia di prove in
`docs/SEO-RULES.md`; quando manca una strada reale si conserva il miglior dato
esistente con `streetAddressSource: 'to-enrich'`, senza inventare via o civico.
`validThrough` resta obbligatorio: usa una scadenza sorgente plausibile oppure
una finestra legata all'ultima osservazione reale dell'annuncio attivo e alla
sua età. La pipeline rinnova la finestra solo dopo una nuova osservazione;
nessun build-clock la rinnova.

## SEO e semantica

- Un H1 di identità per documento; descrizione con heading e liste reali,
  serializzati dal parser/sanitizer condiviso, mai HTML ATS grezzo.
- Title, meta description, robots, canonical, alternate/hreflang, Open Graph
  (immagine inclusa), Twitter card e BreadcrumbList coerenti con il dettaglio.
- JobPosting completo nei campi obbligatori; descrizione e campi editoriali
  non vengono accorciati al budget dell'anteprima quando compare il gate.
- Per un archivio, JobPosting solo se identità e data di pubblicazione hanno
  evidenza reale e precedono una scadenza effettivamente passata. Non usare
  il fallback temporale delle offerte attive per inventare nuove posizioni.
- Record parziali senza prova di un'offerta: WebPage/BreadcrumbList e stato
  esplicito, senza identità, date o candidature fabbricate.
- Gli alias preservano il contenuto ma mantengono canonical e robots di
  consolidamento; non sono nuove offerte nelle sitemap.
- Le Twitter card statiche usano il builder condiviso; il dettaglio idratato
  aggiorna una sola copia per campo. I link sorgente generici conservano testo
  e href, con la destinazione verificata resa esplicita nel nome del link.

## Verifica obbligatoria quando cambia questo comportamento

Controllare output emesso in IT/EN/DE/FR per active, expired e previousSlugs;
renderer storico; HTML senza JavaScript; SPA anonima e con accesso; crawler
con JavaScript. Verificare tail del testo, requisiti oltre i vecchi limiti,
H1 unico, heading/liste e schemi sia prima sia dopo l'idratazione.

Regressioni: `tests/job-description-preview.test.ts`,
`tests/build-plugins/job-board-hub-output.test.ts`,
`tests/archived-jobposting-contract.test.ts`,
`tests/job-status-gated-behind-auth.test.tsx`,
`tests/jobboard-archived-schema-lifecycle.test.tsx` e
`tests/e2e/company-follow-cta-position-live.spec.ts`.
