#!/usr/bin/env node
/**
 * One-shot: push new LLM provider API keys (Chutes, Z.AI) to Firebase Remote
 * Config so `scripts/load-rc-env.mjs` hydrates them into CI runs of
 * generate-article.yml and other workflows that use the AI model chain.
 *
 * Safe to re-run: writes/overwrites only the params present in env, publishes
 * a new RC template version on change.
 *
 * Auth:
 *   GOOGLE_APPLICATION_CREDENTIALS must point at a Firebase SA with the
 *   `Firebase Remote Config Admin` role.
 *
 * Usage:
 *   CHUTES_API_KEY=cpk_xxxxx ZAI_API_KEY=xxxxxx.xxxxxx \
 *     GOOGLE_APPLICATION_CREDENTIALS=mcp-gsc-main/service_account_credentials.json \
 *     node scripts/set-chutes-rc.mjs
 *
 * Keys are read from env vars (NEVER hard-coded). Each env present → one RC
 * param written. Missing envs are skipped silently.
 */

const PROVIDER_KEYS = [
  {
    rcParam: 'CHUTES_API_KEY',
    envVar: 'CHUTES_API_KEY',
    shapeHint: /^cpk_[0-9a-f]+/i,
    description: 'Chutes.ai API key for the LLM fallback chain',
  },
  {
    rcParam: 'ZAI_API_KEY',
    envVar: 'ZAI_API_KEY',
    shapeHint: /^[0-9a-f]{32}\.[A-Za-z0-9]+$/,
    description: 'Z.AI (Zhipu) GLM API key for the LLM fallback chain',
  },
];

function bail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    bail('GOOGLE_APPLICATION_CREDENTIALS not set.');
  }

  const pending = PROVIDER_KEYS
    .map(p => ({ ...p, value: (process.env[p.envVar] || '').trim() }))
    .filter(p => p.value.length > 0);

  if (pending.length === 0) {
    bail('No provider keys present in env. Set at least one of: ' + PROVIDER_KEYS.map(p => p.envVar).join(', '));
  }

  for (const p of pending) {
    if (p.shapeHint && !p.shapeHint.test(p.value)) {
      console.warn(`⚠️  ${p.envVar} does not match the expected shape — continuing anyway.`);
    }
  }

  const adminMod = await import('firebase-admin');
  const admin = adminMod.default || adminMod;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const rc = admin.remoteConfig();
  const template = await rc.getTemplate();
  template.parameters = template.parameters || {};

  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;
  for (const p of pending) {
    const existing = template.parameters[p.rcParam]?.defaultValue?.value;
    if (existing === p.value) {
      console.log(`ℹ️  ${p.rcParam} already up-to-date.`);
      continue;
    }
    template.parameters[p.rcParam] = {
      defaultValue: { value: p.value },
      valueType: 'STRING',
      description: `${p.description} (set ${today})`,
    };
    changed++;
    console.log(`📝 Staged ${p.rcParam} for publish.`);
  }

  if (changed === 0) {
    console.log('ℹ️  Nothing to publish — every key matches RC already.');
    return;
  }

  await rc.publishTemplate(template, { force: true });
  console.log(`✅ Published ${changed} LLM provider key(s) to Remote Config.`);
  console.log('   Next CI run of generate-article.yml will pick them up via load-rc-env.mjs.');
  console.log('   New free models are now live in DEFAULT_CHAIN.');
}

main().catch((err) => {
  console.error('❌ set-chutes-rc failed:', err?.message || err);
  process.exit(1);
});
