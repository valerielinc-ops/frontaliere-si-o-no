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
#   Il numero "candidati" usato nella pitch è CONSERVATIVO = min(persone, sessioni):
#   per il traffico anonimo `person_id` può gonfiare (reset cookie / cross-device),
#   quindi il claim "vi abbiamo mandato N candidati" non sovrastima mai. Il report
#   mostra anche persone e sessioni separate + il rapporto P/S (≈1.0 = stabile,
#   >>1 = person_id frammentato → controllare l'identity-merge di PostHog).

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

**Nessuna azienda è esclusa**: i target sono le prime `--top` per candidati
inviati. Ogni contatto è etichettato col settore (`pubblico` /
`multinazionale` / `pmi`) come contesto per calibrare il tono a mano — il tag
non filtra nulla.

## Enrichment contatti

```bash
node scripts/enrich-employer-contacts.mjs --report data/employer-outreach/report.json --top 15
```

Trova il ruolo più cliccato per azienda (PostHog) e prova a estrarre un'email HR
dalle pagine careers/contatti (best-effort). Le email non trovate vanno
completate a mano in `contacts.json` (LinkedIn / form).

## Prossimi step (non ancora implementati)

- Enrichment automatico delle email HR dalle pagine careers crawlate.
- Step di invio gated (provider via cascade esistente) — separato, con conferma.
- Report in-prodotto per azienda (dashboard inserzionista).
