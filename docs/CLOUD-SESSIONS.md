# Sessioni Claude Code cloud (web + mobile)

Come far girare le sessioni di [claude.ai/code](https://claude.ai/code) e dell'app
mobile con gli stessi segreti che l'agent ha in locale.

## Il vincolo

Una sessione cloud gira su una VM Anthropic che parte da un **clone fresco del
repo**. Vale una sola regola: *è disponibile solo ciò che è committato*.

| | In sessione cloud? |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.mcp.json`, `.claude/rules\|skills\|agents\|commands/` | ✅ parte del clone |
| Plugin dichiarati in `.claude/settings.json` | ✅ installati a session start dal marketplace |
| `.env`, `.env.local`, service account Firebase su disco | ❌ restano sul Mac |
| `~/.claude/CLAUDE.md`, `~/.claude/skills/`, `~/.claude/agents/` | ❌ user-level, non lasciano la macchina |
| Auto-memory `~/.claude/projects/<repo>/memory/` | ❌ machine-local per design |
| Indice GitNexus (`.gitnexus/`, ~8.5 GB, gitignored) | ❌ non ricostruibile nei limiti della VM |

E soprattutto: **i cloud environment non hanno un secrets store**. Le loro
variabili d'ambiente sono in chiaro e leggibili da chiunque usi l'environment.

## La soluzione: un solo segreto bootstrap

Il repo tiene già i suoi ~100 segreti in **Firebase Remote Config**, letti da
`scripts/load-rc-env.mjs` (in CI dopo lo step *Prepare Firebase credentials*).
Quindi al cloud environment ne serve **una sola**: il service account Firebase.
Tutto il resto si idrata a runtime, dalla stessa fonte che usa la CI.

```
FIREBASE_SERVICE_ACCOUNT_JSON  (env var del cloud environment, in chiaro)
        ↓  SessionStart hook → scripts/cloud-session-secrets.sh
/tmp/firebase-sa.json + GOOGLE_APPLICATION_CREDENTIALS
        ↓  scripts/load-rc-env.mjs (local mode)
~100 × `export KEY='...'`  →  $CLAUDE_ENV_FILE
        ↓
ogni comando BashTool successivo della sessione
```

### Setup (una tantum, manuale)

1. Apri [claude.ai/code](https://claude.ai/code) → selettore environment (icona
   nuvola sopra il box messaggi) → icona impostazioni sull'environment.
2. In **Environment variables** aggiungi una riga in formato `.env`:

   ```
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
   ```

   Stesso identico valore del GitHub Secret omonimo — JSON raw su una riga, non
   base64.
3. In **Network access** lascia **Trusted**: copre `*.googleapis.com`, quindi sia
   `oauth2.googleapis.com` sia `firebaseremoteconfig.googleapis.com` che servono
   allo script. Aggiungi domini in **Custom** solo per i servizi non-Google che ti
   servono in sessione (Cloudflare, Resend, Maileroo, Mailgun, PostHog, Telegram).

Nessun passo 4: l'hook è già committato in `.claude/settings.json` e arriva col
clone.

### Come verificare

All'avvio di una sessione cloud lo hook stampa nel contesto:

```
🔐 Sessione cloud: 102 segreti caricati da Firebase Remote Config.
```

Se manca la variabile, lo hook lo dice esplicitamente e la sessione prosegue
senza segreti invece di fallire.

## Perché è fatto così

**`$CLAUDE_ENV_FILE` è uno script bash, non un `KEY=value`.** A differenza di
`$GITHUB_ENV`, Claude Code legge quel file e lo antepone ai comandi BashTool
successivi. È esattamente il formato che `load-rc-env.mjs` produce in local mode
(`export KEY='...'`), quindi il suo stdout ci finisce dentro senza parsing.
Lo script fa girare `load-rc-env.mjs` con `env -u GITHUB_ENV`: è la presenza di
`GITHUB_ENV` a fargli scegliere il formato CI, che qui sarebbe quello sbagliato.

**Lo stdout di un hook SessionStart viene iniettato nel contesto del modello.**
Le righe di export contengono i segreti in chiaro, quindi vanno redirette nel
file; su stdout va solo il conteggio.

**La guardia `CLAUDE_CODE_REMOTE`** vale `true` solo in sessione cloud e non è mai
settata dalla CLI locale, quindi sul Mac lo hook è un no-op immediato e `.env`
continua a funzionare come prima.

## Rischio da conoscere

`FIREBASE_SERVICE_ACCOUNT_JSON` nell'environment è in chiaro e sblocca **tutti** i
segreti in Remote Config. È accettabile finché l'environment resta personale.
Due cose da non fare:

- **Non condividere una sessione in visibility Public** (Max/Pro): la rende
  visibile a chiunque sia loggato su claude.ai. Tieni Private.
- **Non mettere quell'environment in condivisione con l'organizzazione**: gli
  environment condivisi propagano i valori a ogni membro.

Se serve ridurre l'esposizione, l'alternativa è **Remote Control**
(`/remote-control`): pilota da web e mobile una sessione che gira sul Mac, con
credenziali, memoria e indice GitNexus veri, senza che nessun segreto lasci la
macchina. Prezzo: il Mac deve restare acceso.

## Limiti della VM

4 vCPU · 16 GB RAM · 30 GB disco. Il repo su GitHub pesa ~8.6 GB, quindi il clone
ci sta ma non lascia spazio per l'indice GitNexus. `npm run build` chiede
`--max-old-space-size=18432`: in cloud non gira, ma è già la regola del progetto
(«mai full build locale» — vedi `AGENTS.md`), quindi le build restano su GitHub
Actions come sempre.

Altre due asimmetrie da tenere a mente in sessione cloud:

- `git push` funziona **solo sul branch corrente della sessione**, quindi il
  flusso worktree-first con branch multipli va adattato, non trasposto.
- `gh` **non è preinstallato**; l'auth però arriva gratis dal proxy GitHub
  (`GH_TOKEN=proxy-injected`), quindi basta installarlo se serve.
