#!/usr/bin/env node
// Diagnostic dump of a running OmniRoute instance's provider registry health
// — which connections are loaded, which are actually working (testStatus),
// and why the broken ones aren't. Complements the per-call
// "OmniRoute routed auto → provider=X model=Y" log lines emitted by
// scripts/lib/ai-models.mjs (_callOpenAICompatible) for a single request;
// this script shows the full registry at a point in time.
//
// Read-only (GET /api/providers only) — never touches connections.
//
// Usage:
//   node scripts/omniroute-diagnose.mjs
//   OMNIROUTE_URL=http://localhost:20128 node scripts/omniroute-diagnose.mjs

const OMNIROUTE_URL = (process.env.OMNIROUTE_URL || 'http://localhost:20128').trim();

async function main() {
  let res;
  try {
    res = await fetch(`${OMNIROUTE_URL}/api/providers`);
  } catch (err) {
    console.error(`❌ Could not reach OmniRoute at ${OMNIROUTE_URL}: ${err.message}`);
    process.exitCode = 0; // diagnostic-only, never fail the calling CI step
    return;
  }
  if (!res.ok) {
    console.error(`❌ GET /api/providers → HTTP ${res.status}`);
    process.exitCode = 0;
    return;
  }

  const { connections = [] } = await res.json().catch(() => ({ connections: [] }));

  const byStatus = {};
  for (const c of connections) {
    (byStatus[c.testStatus] ||= []).push(c);
  }

  console.log(`OmniRoute provider registry (${OMNIROUTE_URL}): ${connections.length} connections`);
  for (const status of Object.keys(byStatus).sort()) {
    console.log(`  ${status.padEnd(10)} ${byStatus[status].length}`);
  }

  const broken = connections.filter((c) => c.testStatus !== 'active');
  if (broken.length) {
    console.log(`\nNon-active (needs attention):`);
    for (const c of broken.sort((a, b) => a.testStatus.localeCompare(b.testStatus))) {
      const err = c.lastError ? ` lastError="${c.lastError}" (${c.lastErrorType || '?'}/${c.lastErrorSource || '?'})` : '';
      console.log(`  [${c.testStatus}] ${(c.provider || '?').padEnd(14)} "${c.name || '?'}" priority=${c.priority ?? '?'} backoff=${c.backoffLevel ?? '?'}${err}`);
    }
  }

  const active = connections.filter((c) => c.testStatus === 'active').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  if (active.length) {
    console.log(`\nActive roster (sorted by priority):`);
    for (const c of active) {
      console.log(`  priority=${String(c.priority ?? '?').padEnd(3)} ${(c.provider || '?').padEnd(14)} "${c.name || '?'}"`);
    }
  }
}

main();
