#!/usr/bin/env node
/**
 * Verdict per translation provider, for translate-pending.
 *
 * Phase 2b usually reaches its deadline before calling any provider (corpus
 * runs 36530884398 and 36549190748: «Cascade deadline reached … 0 jobs
 * translated so far»), so the cascade summary never says whether DeepL, Azure
 * or Google Cloud could serve the run. That is how two revoked Azure keys and
 * a Google tier refused on every call (403 ACCESS_TOKEN_SCOPE_INSUFFICIENT on
 * the GSC OAuth token) stayed unseen. This probe answers it at the start of
 * every credentialed run, with the endpoints and credentials the cascade uses:
 *   - DeepL: GET /v2/usage per key, which consumes no characters;
 *   - Azure: a two-character translation per key;
 *   - Google Cloud: a two-character translation with the service account
 *     under the cloud-translation scope, else the GSC OAuth token.
 * A credential the provider rejects is an owner action (rotate it where the
 * workflow reads it: Remote Config for DeepL and Azure, the Actions secret for
 * the Google service account); an exhausted quota is not — DeepL resets monthly and the Google
 * project is capped on purpose at 16,000 characters a day.
 *
 *   node scripts/translation-provider-readiness.mjs [--summary] [--json FILE]
 *   node scripts/translation-provider-readiness.mjs --alert-from FILE [--run-url URL]
 *
 * A rejected or exhausted provider is a verdict, not a failure: the exit code
 * is non-zero only when the probe itself crashes, and the workflow step is
 * continue-on-error so even that never stops the translation run.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';

const TIMEOUT_MS = 15_000;
const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-translation';
const PROBE_TEXT = 'ok';

const text = async (res) => {
  try {
    return await res.text();
  } catch {
    return '';
  }
};

export async function probeDeepL(label, key, { fetcher = globalThis.fetch } = {}) {
  const base = { provider: 'deepl', credential: label };
  if (!key) return { ...base, verdict: 'not-configured' };
  try {
    // The cascade calls api-free.deepl.com, so that is the host that matters.
    const res = await fetcher('https://api-free.deepl.com/v2/usage', {
      headers: { Authorization: `DeepL-Auth-Key ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const usage = await res.json();
      const used = Number(usage?.character_count);
      const limit = Number(usage?.character_limit);
      const detail = `${used}/${limit} characters this month`;
      return { ...base, verdict: limit > 0 && used >= limit ? 'quota-exhausted' : 'ok', detail };
    }
    if (res.status === 456) return { ...base, verdict: 'quota-exhausted', detail: 'HTTP 456' };
    if (res.status === 401 || res.status === 403) return { ...base, verdict: 'auth-failed', detail: `HTTP ${res.status}` };
    if (res.status === 429) return { ...base, verdict: 'rate-limited', detail: 'HTTP 429' };
    return { ...base, verdict: 'error', detail: `HTTP ${res.status}` };
  } catch (error) {
    return { ...base, verdict: 'error', detail: error?.name || 'request-error' };
  }
}

export async function probeAzure(label, key, { fetcher = globalThis.fetch, region = 'westeurope' } = {}) {
  const base = { provider: 'azure', credential: label };
  if (!key) return { ...base, verdict: 'not-configured' };
  try {
    const res = await fetcher('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=it&to=en', {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ Text: PROBE_TEXT }]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ...base, verdict: 'ok', detail: `region=${region}` };
    let code = '';
    try {
      code = String(JSON.parse(await text(res))?.error?.code ?? '');
    } catch {
      // Body without a JSON error: the status is enough.
    }
    const detail = `HTTP ${res.status}${code ? ` (${code})` : ''}, region=${region}`;
    if (res.status === 401 || res.status === 403) return { ...base, verdict: 'auth-failed', detail };
    if (res.status === 429) return { ...base, verdict: 'quota-exhausted', detail };
    return { ...base, verdict: 'error', detail };
  } catch (error) {
    return { ...base, verdict: 'error', detail: error?.name || 'request-error' };
  }
}

function readServiceAccount(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const credentials = JSON.parse(readFileSync(path, 'utf8'));
    return credentials?.client_email && credentials?.private_key && credentials?.project_id ? credentials : null;
  } catch {
    return null;
  }
}

async function oauthAccessToken({ clientId, clientSecret, refreshToken }, fetcher) {
  const res = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return '';
  return (await res.json())?.access_token || '';
}

/**
 * Google Cloud Translation with the same credential order as the cascade
 * (scripts/lib/free-translate.mjs): service account first, OAuth fallback.
 */
export async function probeGoogleCloud({
  fetcher = globalThis.fetch,
  serviceAccount = readServiceAccount((process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()),
  oauth = {
    clientId: (process.env.GSC_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GSC_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.GSC_REFRESH_TOKEN || '').trim(),
  },
  projectId = (process.env.VITE_FIREBASE_PROJECT_ID || process.env.GCP_PROJECT_ID || 'frontaliere-ticino').trim(),
  serviceAccountToken = (credentials) => getServiceAccountAccessToken(credentials, GOOGLE_CLOUD_SCOPE),
} = {}) {
  const hasOAuth = Boolean(oauth.clientId && oauth.clientSecret && oauth.refreshToken);
  if (!serviceAccount && !hasOAuth) return { provider: 'google-cloud', credential: 'none', verdict: 'not-configured' };

  const translate = async (credential, token) => {
    const base = { provider: 'google-cloud', credential };
    try {
      const res = await fetcher('https://translation.googleapis.com/language/translate/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-goog-user-project': projectId },
        body: JSON.stringify({ q: PROBE_TEXT, source: 'it', target: 'en', format: 'text' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { ...base, verdict: 'ok' };
      const body = await text(res);
      let reason = '';
      let message = '';
      try {
        const error = JSON.parse(body)?.error;
        reason = (error?.details || []).map((detail) => detail?.reason).filter(Boolean).join(',')
          || (error?.errors || []).map((entry) => entry?.reason).filter(Boolean).join(',');
        message = String(error?.message || '');
      } catch {
        // Not JSON: the status decides.
      }
      const detail = `HTTP ${res.status}${reason ? ` ${reason}` : ''}${message ? ` — ${message.slice(0, 80)}` : ''}`;
      if (res.status === 429 || /rate ?limit|quota|dailyLimit|RESOURCE_EXHAUSTED/i.test(`${reason} ${message}`)) {
        return { ...base, verdict: 'quota-exhausted', detail };
      }
      if (res.status === 401 || res.status === 403) return { ...base, verdict: 'auth-failed', detail };
      return { ...base, verdict: 'error', detail };
    } catch (error) {
      return { ...base, verdict: 'error', detail: error?.name || 'request-error' };
    }
  };

  let serviceAccountVerdict;
  if (serviceAccount) {
    let token = '';
    try {
      token = await serviceAccountToken(serviceAccount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A 4xx from the token endpoint is a rejected credential; a timeout or a
      // 5xx that outlived the helper's retries is transient and alerts no one.
      if (!/failed: 4\d\d\b/.test(message)) {
        return { provider: 'google-cloud', credential: 'service-account', verdict: 'error', detail: `token exchange: ${message.slice(0, 80)}` };
      }
      serviceAccountVerdict = { provider: 'google-cloud', credential: 'service-account', verdict: 'auth-failed', detail: `token exchange: ${message.slice(0, 80)}` };
    }
    if (token) {
      serviceAccountVerdict = await translate('service-account', token);
      if (serviceAccountVerdict.verdict !== 'auth-failed') return serviceAccountVerdict;
    }
  }
  // Same order as the cascade: a rejected service account falls back to OAuth.
  if (!hasOAuth) return serviceAccountVerdict;
  let token = '';
  try {
    token = await oauthAccessToken(oauth, fetcher);
  } catch {
    token = '';
  }
  if (!token) return serviceAccountVerdict || { provider: 'google-cloud', credential: 'oauth', verdict: 'auth-failed', detail: 'no access token' };
  const oauthVerdict = await translate('oauth', token);
  if (oauthVerdict.verdict === 'ok' || !serviceAccountVerdict) return oauthVerdict;
  // Both refused: report the service account, the credential the fix is about.
  return { ...serviceAccountVerdict, detail: `${serviceAccountVerdict.detail}; oauth fallback: ${oauthVerdict.detail || oauthVerdict.verdict}` };
}

export async function probeTranslationProviders({ env = process.env, fetcher = globalThis.fetch, google = {} } = {}) {
  const region = (env.AZURE_TRANSLATOR_REGION || 'westeurope').trim();
  return [
    await probeDeepL('DEEPL_API_KEY', (env.DEEPL_API_KEY || '').trim(), { fetcher }),
    await probeDeepL('DEEPL_API_KEY_2', (env.DEEPL_API_KEY_2 || '').trim(), { fetcher }),
    await probeAzure('AZURE_TRANSLATOR_KEY', (env.AZURE_TRANSLATOR_KEY || '').trim(), { fetcher, region }),
    await probeAzure('AZURE_TRANSLATOR_KEY_2', (env.AZURE_TRANSLATOR_KEY_2 || '').trim(), { fetcher, region }),
    await probeGoogleCloud({ fetcher, ...google }),
  ];
}

const PROVIDER_NAMES = { deepl: 'DeepL', azure: 'Azure Translator', 'google-cloud': 'Google Cloud Translation' };

/**
 * Providers whose every configured credential is rejected. Quota exhaustion
 * and transient errors are left out on purpose: they heal on their own.
 */
export function rejectedProviders(results) {
  const byProvider = new Map();
  for (const result of results) {
    if (result.verdict === 'not-configured') continue;
    const list = byProvider.get(result.provider) || [];
    list.push(result);
    byProvider.set(result.provider, list);
  }
  const rejected = [];
  for (const [provider, list] of byProvider) {
    if (list.every((result) => result.verdict === 'auth-failed')) rejected.push(provider);
  }
  return rejected;
}

// Where the owner rotates each credential. DeepL and Azure keys come from
// Remote Config; the Google service account is written to
// GOOGLE_APPLICATION_CREDENTIALS from the Actions secret of the repository
// that runs translate-pending, which Remote Config never feeds.
const CREDENTIAL_STORE = {
  deepl: {
    title: 'rotate them in Remote Config',
    fix: 'issue new keys in the DeepL account and update `DEEPL_API_KEY` / `DEEPL_API_KEY_2` in Firebase Remote Config (project `frontaliere-ticino`)',
  },
  azure: {
    title: 'rotate them in Remote Config',
    fix: 'regenerate the keys of the Translator resource in the Azure portal and update `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_KEY_2` (region `AZURE_TRANSLATOR_REGION`, default `westeurope`) in Firebase Remote Config (project `frontaliere-ticino`)',
  },
  'google-cloud': {
    title: 'rotate the Actions service-account secret',
    fix: 'grant the service account a role with `cloudtranslate.generalModels.predict`, or issue a new key for it, and update the GitHub Actions secret `FIREBASE_SERVICE_ACCOUNT_JSON` of the repository that runs translate-pending (nanakokyobashi-rgb/frontaliere-articles); the workflow writes it to `GOOGLE_APPLICATION_CREDENTIALS`',
  },
};

export function credentialAlertTitle(provider) {
  return `${PROVIDER_NAMES[provider] || provider} credentials rejected — ${CREDENTIAL_STORE[provider]?.title || 'rotate them'}`;
}

export function formatReadinessTable(results) {
  return [
    '| Provider | Credential | Verdict | Detail |',
    '|---|---|---|---|',
    ...results.map((result) => `| ${PROVIDER_NAMES[result.provider] || result.provider} | ${result.credential} | ${result.verdict} | ${result.detail || ''} |`),
  ].join('\n');
}

export function formatCredentialAlert(provider, results, { runUrl } = {}) {
  const rows = results.filter((result) => result.provider === provider);
  return [
    '## Scheda',
    `- CAUSA: every configured ${PROVIDER_NAMES[provider] || provider} credential is rejected by the provider (${rows.map((row) => `${row.credential}: ${row.detail || row.verdict}`).join('; ')}). Hypothesis to confirm with the COMMAND: the credentials were revoked, regenerated or lost their permission outside the stores the workflow reads.`,
    `- FIX: owner action — ${CREDENTIAL_STORE[provider]?.fix || 'renew the credentials'}. No code change: the cascade uses a renewed credential on the next run.`,
    `- METRICA: prima=${rows.length} credential(s) rejected atteso=0 | COMANDO: \`node scripts/translation-provider-readiness.mjs\` after \`source bin/rc-env.sh\``,
    '- OSSERVATORE: the provider probe in translate-pending runs on every credentialed run and closes this issue when the provider answers again.',
    '',
    formatReadinessTable(results),
    ...(runUrl ? ['', `Run: ${runUrl}`] : []),
  ].join('\n');
}

async function alertFrom(file, runUrl) {
  const { createGithubIssue, resolveGithubIssue } = await import('./lib/github-issue-creator.mjs');
  const results = JSON.parse(readFileSync(file, 'utf8')).results || [];
  const rejected = rejectedProviders(results);
  const probed = new Set(results.filter((result) => result.verdict !== 'not-configured').map((result) => result.provider));
  for (const provider of probed) {
    const title = credentialAlertTitle(provider);
    if (rejected.includes(provider)) {
      await createGithubIssue({
        title,
        description: formatCredentialAlert(provider, results, { runUrl }),
        priority: 2,
        // Rotating a credential is an owner action: keep it out of the fixer queue.
        labels: ['needs-human', 'fu-parked'],
        workflow: 'Translate Pending Jobs',
      });
    } else if (results.some((result) => result.provider === provider && result.verdict !== 'auth-failed')) {
      resolveGithubIssue(title, { workflow: 'Translate Pending Jobs', runUrl });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const from = get('--alert-from');
  if (from) {
    await alertFrom(from, get('--run-url'));
    return;
  }
  const results = await probeTranslationProviders();
  for (const result of results) {
    console.log(`🔑 ${PROVIDER_NAMES[result.provider]} ${result.credential}: ${result.verdict}${result.detail ? ` (${result.detail})` : ''}`);
  }
  const rejected = rejectedProviders(results);
  for (const provider of rejected) {
    console.log(`::warning title=Translation provider rejected::${credentialAlertTitle(provider)}`);
  }
  const json = get('--json');
  if (json) writeFileSync(json, `${JSON.stringify({ generatedAt: new Date().toISOString(), rejected, results }, null, 2)}\n`);
  if (args.includes('--summary') && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Translation provider readiness\n\n${formatReadinessTable(results)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Translation provider probe failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
