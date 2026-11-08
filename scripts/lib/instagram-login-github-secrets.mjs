import { spawnSync } from 'node:child_process';

const ALLOWED_SECRET_NAMES = new Set([
  'INSTAGRAM_LOGIN_ACCESS_TOKEN',
  'INSTAGRAM_LOGIN_APP_SECRET',
]);

function definitiveHttpRejection(result) {
  const output = `${String(result?.stderr || '')}\n${String(result?.stdout || '')}`;
  const status = Number(output.match(/\bHTTP\s+(\d{3})\b/u)?.[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Write only Instagram Login secrets; the value is sent on stdin, never argv. */
export function setInstagramLoginGithubSecret(secretName, value, {
  env = process.env,
  spawn = spawnSync,
  attempts = 2,
} = {}) {
  if (!ALLOWED_SECRET_NAMES.has(secretName)) {
    throw new Error(`Refused to write unsupported Instagram Login secret: ${secretName}`);
  }
  const secretValue = String(value || '');
  if (!secretValue || /[\r\n\u0000]/u.test(secretValue)) {
    throw new Error(`Refused empty or invalid value for ${secretName}`);
  }

  const args = ['secret', 'set', secretName];
  const repository = String(env.GITHUB_REPOSITORY || '').trim();
  if (repository) args.push('--repo', repository);
  const childEnv = { ...env };
  for (const name of ALLOWED_SECRET_NAMES) delete childEnv[name];
  const authToken = String(env.GITHUB_PAT || env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (authToken) childEnv.GH_TOKEN = authToken;

  let result;
  let ambiguous = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawn('gh', args, {
      input: secretValue,
      encoding: 'utf8',
      env: childEnv,
      timeout: 30_000,
    });
    if (!result.error && result.status === 0) return { secretName };
    if (result.error?.code === 'ENOENT') break;
    if (definitiveHttpRejection(result)) break;
    ambiguous = true;
  }
  const error = new Error(`GitHub Actions secret update failed for ${secretName} (exit ${result?.status ?? 'unknown'})`);
  error.instagramSecretWriteAmbiguous = ambiguous;
  throw error;
}
