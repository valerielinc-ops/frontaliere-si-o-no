# Piano: convertire le aziende crawlate in inserzionisti sponsorizzati

Obiettivo: aumentare la monetizzazione trasformando il traffico gratuito che già
mandiamo alle aziende crawlate in annunci sponsorizzati pagati.

## Leva centrale
**Reciprocità misurata** — mandiamo candidati gratis a ~100 aziende ogni mese e
possiamo dimostrarlo col numero reale per azienda. Gancio: *click ≠ candidatura*;
lo sponsorizzato fa arrivare il CV diretto (apply form in-house).

## Stato

| # | Attività | Stato |
|---|----------|-------|
| — | Misura candidati/azienda (PostHog storico + GA4 `job_apply` futuro) | ✅ live (PR #2375, #2382) |
| — | Tutti i touchpoint apply tracciati (bottone+logo+titolo) | ✅ |
| — | Generatore bozze cold-email 4-touch (zero invio) | ✅ |
| 1 | **Enrichment email HR dei target** | 🔜 in corso |
| 2 | Generazione + revisione bozze (dipende da 1) | ⏳ |
| 3 | Sistema invio gated (mai automatico, solo su OK) | ⏳ |
| 4 | Verifica funnel upgrade annuncio-crawlato → sponsor | ⏳ |
| 5 | Tetto tier free (no cattura-candidato sui crawlati) | ⏳ |
| 6 | Prova in-prodotto / dashboard inserzionista | ⏳ |
| 7 | Pricing Piano Azienda/Brand bundle | ⏳ |
| 8 | Verifica post-deploy GA4 nuovi touchpoint | ⏳ |
| 9 | Misurazione campagna (reply/conversione/ARPU) + social proof | ⏳ |

## Targeting
**Nessuna azienda esclusa** (decisione owner): si contattano tutte le prime per
candidati inviati. Ogni contatto è etichettato col settore (`pubblico` /
`multinazionale` / `pmi`) solo come contesto per calibrare il tono a mano — non
filtra. Nota: per pubblici (concorsi) e multinazionali (HR globale) il tasso di
conversione atteso è più basso, ma restano nel target.

## Dati reali (candidati distinti, 90gg, da PostHog)
Top privati: Casale SA 88 · Sintetica SA 86 · ALDI 62* · Lidl 43* · TSMG 36 ·
PEMSA 22 · Coop 20* · Swisscom 20* · Ticino Premium Properties 19 · Centiel 10 ·
Medacta 11 · Rapelli 16. (* = multinazionale, deprioritizzato)

## Email — principi applicati (skill cold-email)
- Subject 2-4 parole, minuscole, "interna" (no salesy/urgency, no nome proprio).
- Personalizzazione Livello 4: numero reale + ruolo più cliccato, connessi al
  problema (click che si perdono). Il dato È la personalizzazione.
- Tono da pari, una sola call-to-action a basso attrito.
- Sequenza 4-touch: reciprocità+numero → gap click/candidatura → social proof +
  ancora vs recruiter → breakup che lascia il report.

## Pricing (proposta)
Free (crawlato, ancora) · Sponsor CHF 49/annuncio · **Piano Azienda** bundle
~CHF 199–299/mese ruoli illimitati, ancorato vs fee recruiter (15-25% stipendio).
Tetto free obbligatorio: niente cattura-candidato sui crawlati.
