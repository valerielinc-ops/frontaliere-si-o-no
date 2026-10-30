#!/usr/bin/env node
/**
 * Asserts `redact_query_string` on the locale-router Worker's Workers Logs.
 *
 * wrangler.toml cannot express this setting, so it lives in the Worker's
 * script settings and is re-asserted after every deploy. The other observability
 * fields are read back and preserved: wrangler.toml stays their source of truth.
 */
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

export const WORKER_NAME = 'frontaliere-locale-router';

export function withRedactedQueryString(observability) {
  return { ...observability, redact_query_string: true };
}

async function cloudflare(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`Cloudflare ${path}: HTTP ${res.status} ${JSON.stringify(json.errors ?? [])}`);
  }
  return json.result;
}

export async function main() {
  if (!process.env.CF_API_TOKEN || !process.env.CF_ACCOUNT_ID) {
    throw new Error('CF_API_TOKEN / CF_ACCOUNT_ID missing');
  }
  const path = `/workers/scripts/${WORKER_NAME}/script-settings`;
  const { observability } = await cloudflare(path);
  if (observability?.redact_query_string === true) {
    console.log('redact_query_string already enabled');
    return;
  }
  await cloudflare(path, {
    method: 'PATCH',
    body: JSON.stringify({ observability: withRedactedQueryString(observability) }),
  });
  console.log('redact_query_string enabled');
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
