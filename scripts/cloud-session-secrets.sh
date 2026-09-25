#!/usr/bin/env bash
#
# Bootstrap dei segreti per le sessioni Claude Code cloud (claude.ai/code, app mobile).
#
# ─── Perché esiste ────────────────────────────────────────────────────────
#   Una sessione cloud gira su una VM Anthropic che parte da un clone fresco del
#   repo: `.env`, `.env.local` e il service account Firebase restano sul Mac e non
#   arrivano mai nel container. I cloud environment non hanno un secrets store —
#   le loro variabili d'ambiente sono in chiaro e leggibili da chiunque usi
#   l'environment — quindi ce ne mettiamo UNA sola, `FIREBASE_SERVICE_ACCOUNT_JSON`
#   (stesso nome e stesso formato JSON raw dei GitHub Secrets), e da lì idratiamo
#   i ~100 segreti già presenti in Firebase Remote Config riusando lo stesso
#   `scripts/load-rc-env.mjs` che gira in CI.
#
# ─── Come si aggancia ─────────────────────────────────────────────────────
#   SessionStart hook in `.claude/settings.json`. Claude Code espone
#   `$CLAUDE_ENV_FILE` agli hook SessionStart: quel file è uno *script bash*
#   — non un `KEY=value` in stile $GITHUB_ENV — che viene anteposto a ogni comando
#   BashTool successivo. È esattamente il formato che `load-rc-env.mjs` produce in
#   local mode (`export KEY='...'`), quindi il suo stdout ci finisce dentro così
#   com'è, senza parsing intermedio.
#
# ─── Sicurezza ────────────────────────────────────────────────────────────
#   Lo stdout di un hook SessionStart viene iniettato nel contesto del modello.
#   Le righe di export contengono i segreti in chiaro, quindi vanno redirette nel
#   file e MAI lasciate su stdout: qui su stdout va solo un conteggio.
#
# ─── Locale ───────────────────────────────────────────────────────────────
#   No-op. La guardia `CLAUDE_CODE_REMOTE` esce subito sul Mac, dove `.env` e il
#   service account su disco continuano a funzionare come prima.
#
# Non blocca mai una sessione: ogni percorso termina con exit 0, come load-rc-env.mjs.

set -uo pipefail

# `true` solo dentro una sessione cloud; mai settata dalla CLI locale.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# Assente se questa versione di Claude Code non espone il canale env agli hook:
# senza il file non c'è modo di propagare le variabili, quindi usciamo puliti.
if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  echo "ℹ️  Sessione cloud senza \$CLAUDE_ENV_FILE — segreti Remote Config non caricati."
  exit 0
fi

if [ -z "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ]; then
  echo "⚠️  Sessione cloud senza FIREBASE_SERVICE_ACCOUNT_JSON: nessun segreto caricato."
  echo "    Aggiungila alle variabili del cloud environment (claude.ai/code → selettore"
  echo "    environment → icona impostazioni) con lo stesso valore del GitHub Secret"
  echo "    omonimo. Vedi docs/CLOUD-SESSIONS.md."
  exit 0
fi

# Stesso path e stesso formato dello step "Prepare Firebase credentials" dei
# workflow, così ogni script che già si aspetta GOOGLE_APPLICATION_CREDENTIALS
# funziona in cloud senza modifiche. L'override esiste solo per i test.
SA_PATH="${CLOUD_SESSION_SA_PATH:-/tmp/firebase-sa.json}"

umask 077
printf '%s' "$FIREBASE_SERVICE_ACCOUNT_JSON" > "$SA_PATH"

# Un valore troncato o incollato male produrrebbe un fallimento oscuro dentro
# load-rc-env.mjs; qui lo intercettiamo subito senza stampare nulla del contenuto.
if ! SA_PATH="$SA_PATH" node -e 'const sa=require(process.env.SA_PATH); if(!sa.client_email||!sa.private_key) process.exit(1)' 2>/dev/null; then
  rm -f "$SA_PATH"
  echo "⚠️  FIREBASE_SERVICE_ACCOUNT_JSON non è un service account valido — segreti non caricati."
  exit 0
fi

export GOOGLE_APPLICATION_CREDENTIALS="$SA_PATH"
printf 'export GOOGLE_APPLICATION_CREDENTIALS=%s\n' "$SA_PATH" >> "$CLAUDE_ENV_FILE"

BEFORE=$(wc -l < "$CLAUDE_ENV_FILE" 2>/dev/null || echo 0)

# stdout → il file (righe `export`, contengono segreti).
# stderr → scartato: porta solo il log di stato, ma finirebbe nel debug log.
# GITHUB_ENV va tenuto fuori dall'ambiente: è lui a far scegliere allo script il
# formato CI (`KEY=value`) invece degli export che ci servono qui.
if ! env -u GITHUB_ENV node "${CLAUDE_PROJECT_DIR:-.}/scripts/load-rc-env.mjs" >> "$CLAUDE_ENV_FILE" 2>/dev/null; then
  echo "⚠️  load-rc-env.mjs ha fallito — la sessione prosegue senza segreti Remote Config."
  exit 0
fi

AFTER=$(wc -l < "$CLAUDE_ENV_FILE" 2>/dev/null || echo 0)
echo "🔐 Sessione cloud: $((AFTER - BEFORE)) segreti caricati da Firebase Remote Config."

exit 0
