# Newsletter Readiness (Resend + Safe Mode)

## Stato attuale
- Invii bloccati di default: `NEWSLETTER_EXPERIMENTAL_MODE=true` (default) e `NEWSLETTER_ENABLE_SEND` non attivo.
- Anteprima e analisi disponibili senza invio:
  - `node scripts/send-newsletter.mjs --preview`
  - `node scripts/send-newsletter.mjs --analyze`

## Go-live Resend (quando vuoi attivare produzione)
1. Verifica dominio in Resend: `frontaliereticino.ch`
2. Aggiungi il record DNS TXT richiesto da Resend:
   - formato tipico: `resend-domain-verification=...`
3. Verifica stato:
   - `RESEND_API_KEY=... NEWSLETTER_FROM="Frontaliere Ticino <newsletter@frontaliereticino.ch>" node scripts/check-resend-domain.mjs`
4. Solo dopo verifica dominio:
   - imposta `NEWSLETTER_EXPERIMENTAL_MODE=false`
   - imposta `NEWSLETTER_ENABLE_SEND=true`

## Sender in test
- Per test tecnici puoi usare `onboarding@resend.dev`.
- Per produzione usa solo `newsletter@frontaliereticino.ch` con dominio verificato.

## Nota preferenze utente
- Le preferenze Firestore (`exchangeRate`, `traffic`, `taxUpdates`, `tips`) sono raccolte e tracciate.
- In questa fase il template resta uguale per tutti, senza segmentazione contenuto.
