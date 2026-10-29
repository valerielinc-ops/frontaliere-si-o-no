#!/usr/bin/env node
/** Exact catalog check for the Functions fallbacks, separate from the article engine fleet. */
import { pathToFileURL } from 'node:url';
import { SERVER_TEXT_FALLBACKS } from '../functions/src/serverAiFallbacks.js';

export async function checkServerAiFallbacks({ env = process.env, fetchImpl = fetch } = {}) {
  const providers = [...new Set(SERVER_TEXT_FALLBACKS.map(provider => provider.rcKey))];
  const results = [];
  for (const rcKey of providers) {
    const models = SERVER_TEXT_FALLBACKS.filter(provider => provider.rcKey === rcKey);
    const key = String(env[rcKey] || '').trim();
    if (!key) { results.push({ provider: rcKey, status: 'not_configured', missingModels: [] }); continue; }
    try {
      const url = models[0].base.replace(/\/chat\/completions$/, '/models');
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { results.push({ provider: rcKey, status: `http_${response.status}`, missingModels: [] }); continue; }
      const catalog = await response.json();
      if (!Array.isArray(catalog.data)) { results.push({ provider: rcKey, status: 'unverified', missingModels: [] }); continue; }
      const ids = new Set(catalog.data.filter(model => model?.active !== false).map(model => model?.id));
      const missingModels = models.map(model => model.model).filter(model => !ids.has(model));
      results.push({ provider: rcKey, status: missingModels.length ? 'retired_or_unavailable' : 'available', missingModels });
    } catch {
      results.push({ provider: rcKey, status: 'unverified', missingModels: [] });
    }
  }
  return { ok: results.every(result => ['available', 'not_configured'].includes(result.status)), providers: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkServerAiFallbacks();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
