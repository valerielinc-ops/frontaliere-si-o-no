# Employer outreach — convertire le aziende crawlate in inserzionisti sponsorizzati

Sistema per il pitch commerciale alle aziende di cui crawliamo gli annunci. Leva
centrale: **reciprocità misurata** — mandiamo loro candidati gratis ogni mese e
possiamo dimostrarlo col numero reale. Gancio: click ≠ candidatura; lo
sponsorizzato fa arrivare il CV diretto.

## ⚠️ Nessun invio automatico

Questo modulo **non invia email**. `generate-cold-emails.mjs` produce solo bozze
markdown per revisione umana e non importa alcun provider di invio. L'invio
resta un passo separato, manuale e deliberato.

## Pipeline

```bash
# 1) Estrai la classifica candidati-per-azienda (storico, da PostHog)
eval "$(GOOGLE_APPLICATION_CREDENTIALS=/path/sa.json node scripts/load-rc-env.mjs)"
node scripts/employer-traffic-report.mjs --source posthog --days 90 \
  --json data/employer-outreach/report.json

# 2) (enrichment manuale) crea contacts.json dalle email HR delle aziende target
cp data/employer-outreach/contacts.example.json data/employer-outreach/contacts.json
#   …compila le email reali (pagine careers / LinkedIn)

# 3) Genera le bozze personalizzate (4-touch) per i top target privati
node scripts/generate-cold-emails.mjs \
  --report data/employer-outreach/report.json --top 10
#   → bozze in data/employer-outreach/drafts/*.md (una per azienda)
```

## File

- `contacts.example.json` — template registry contatti (committato).
- `contacts.json` — contatti reali (**untracked**, `.gitignore`).
- `report.json` — output del report (**untracked**: contiene dati di traffico).
- `drafts/` — bozze email generate (**untracked**).

## Targeting

Di default il generatore **esclude gli enti pubblici** (EOC, Città di Lugano,
Amministrazione Cantonale, USI/SUPSI, FFS…): pubblicano concorsi obbligatori e
difficilmente comprano sponsorizzati. I target sono i datori privati ad alto
volume di candidati inviati. Usa `--include-public` per forzarne l'inclusione.

## Prossimi step (non ancora implementati)

- Enrichment automatico delle email HR dalle pagine careers crawlate.
- Step di invio gated (provider via cascade esistente) — separato, con conferma.
- Report in-prodotto per azienda (dashboard inserzionista).
