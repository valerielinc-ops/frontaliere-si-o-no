/**
 * Lock test per `scripts/cloud-session-secrets.sh`, il SessionStart hook che
 * idrata i segreti Remote Config nelle sessioni Claude Code cloud.
 *
 * Verifica:
 *  1. le guardie — no-op in locale, uscita pulita quando manca il canale env,
 *     la credenziale bootstrap o quando il service account è malformato;
 *  2. l'invariante di sicurezza: le righe `export` (che contengono i segreti in
 *     chiaro) finiscono in `$CLAUDE_ENV_FILE` e MAI su stdout, che Claude Code
 *     inietta nel contesto del modello;
 *  3. il seam `env -u GITHUB_ENV`: è la presenza di quella variabile a far
 *     scegliere a load-rc-env.mjs il formato CI `KEY=value` invece degli
 *     `export` che il canale `$CLAUDE_ENV_FILE` si aspetta.
 *
 * load-rc-env.mjs è sostituito da uno stub via CLAUDE_PROJECT_DIR: il test resta
 * ermetico (nessuna chiamata a Firebase) e copre comunque il percorso completo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'cloud-session-secrets.sh');

/** Service account minimo: solo i campi che lo script valida. */
const FAKE_SA = JSON.stringify({
  type: 'service_account',
  client_email: 'test@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
});

let tmp: string;
let envFile: string;
let saPath: string;
let projectDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-session-secrets-'));
  envFile = path.join(tmp, 'sessionstart-hook-0.sh');
  saPath = path.join(tmp, 'firebase-sa.json');
  projectDir = path.join(tmp, 'project');
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  // Claude Code crea il file vuoto prima di invocare lo hook.
  fs.writeFileSync(envFile, '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Installa uno stub al posto di load-rc-env.mjs nel finto project dir. */
function stubLoadRcEnv(body: string): void {
  fs.writeFileSync(path.join(projectDir, 'scripts', 'load-rc-env.mjs'), body);
}

function run(extraEnv: Record<string, string | undefined> = {}) {
  // Ambiente costruito da zero: la sessione che gira questo test potrebbe avere
  // CLAUDE_CODE_REMOTE o GITHUB_ENV settate e falsare il risultato.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmp,
    CLOUD_SESSION_SA_PATH: saPath,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
}

const readEnvFile = () => fs.readFileSync(envFile, 'utf8');

describe('cloud-session-secrets — guardie', () => {
  it('è un no-op silenzioso in locale (CLAUDE_CODE_REMOTE non settata)', () => {
    const r = run({ CLAUDE_ENV_FILE: envFile, FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readEnvFile()).toBe('');
    expect(fs.existsSync(saPath)).toBe(false);
  });

  it('non scatta nemmeno se CLAUDE_CODE_REMOTE ha un valore diverso da "true"', () => {
    const r = run({
      CLAUDE_CODE_REMOTE: 'false',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA,
    });
    expect(r.status).toBe(0);
    expect(readEnvFile()).toBe('');
  });

  it('esce pulito quando manca $CLAUDE_ENV_FILE, senza scrivere il service account', () => {
    const r = run({ CLAUDE_CODE_REMOTE: 'true', FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CLAUDE_ENV_FILE');
    expect(fs.existsSync(saPath)).toBe(false);
  });

  it('spiega come rimediare quando manca la credenziale bootstrap', () => {
    const r = run({ CLAUDE_CODE_REMOTE: 'true', CLAUDE_ENV_FILE: envFile });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
    expect(r.stdout).toContain('docs/CLOUD-SESSIONS.md');
    expect(readEnvFile()).toBe('');
  });

  it('rifiuta un service account malformato e rimuove il file scritto a metà', () => {
    const r = run({
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}', // niente client_email/private_key
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('non è un service account valido');
    expect(fs.existsSync(saPath)).toBe(false);
    expect(readEnvFile()).toBe('');
  });

  it('non lascia residui quando il JSON non è nemmeno parsabile', () => {
    const r = run({
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: 'incollato-male',
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(saPath)).toBe(false);
    expect(readEnvFile()).toBe('');
  });
});

describe('cloud-session-secrets — percorso completo', () => {
  it('scrive i segreti nel canale env e mai su stdout', () => {
    stubLoadRcEnv(
      `console.log("export GEMINI_API_KEY='super-secret-value'");\n` +
        `console.log("export RESEND_API_KEY='another-secret'");\n` +
        `console.error('📦 Remote Config: 2 params');\n`,
    );

    const r = run({
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA,
    });

    expect(r.status).toBe(0);

    const written = readEnvFile();
    expect(written).toContain("export GEMINI_API_KEY='super-secret-value'");
    expect(written).toContain("export RESEND_API_KEY='another-secret'");
    expect(written).toContain(`export GOOGLE_APPLICATION_CREDENTIALS=${saPath}`);

    // L'invariante che conta: stdout finisce nel contesto del modello.
    expect(r.stdout).not.toContain('super-secret-value');
    expect(r.stdout).not.toContain('another-secret');
    expect(r.stdout).not.toContain('export ');
    expect(r.stdout).toContain('2 segreti caricati');
  });

  it('nasconde a load-rc-env.mjs la GITHUB_ENV che lo farebbe passare al formato CI', () => {
    // Lo stub fallisce se vede GITHUB_ENV: senza `env -u` scriverebbe righe
    // `KEY=value`, che il canale $CLAUDE_ENV_FILE — uno script bash — non applica.
    stubLoadRcEnv(
      `if (process.env.GITHUB_ENV) { console.error('GITHUB_ENV visibile'); process.exit(1); }\n` +
        `console.log("export OK='1'");\n`,
    );

    const r = run({
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA,
      GITHUB_ENV: path.join(tmp, 'github-env'),
    });

    expect(r.status).toBe(0);
    expect(readEnvFile()).toContain("export OK='1'");
  });

  it('non blocca la sessione se load-rc-env.mjs fallisce', () => {
    stubLoadRcEnv(`process.exit(1);\n`);

    const r = run({
      CLAUDE_CODE_REMOTE: 'true',
      CLAUDE_ENV_FILE: envFile,
      FIREBASE_SERVICE_ACCOUNT_JSON: FAKE_SA,
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('load-rc-env.mjs ha fallito');
  });
});
