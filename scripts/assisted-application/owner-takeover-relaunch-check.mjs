#!/usr/bin/env node

/**
 * @manual-tool — recovery one-shot con autorizzazione esplicita del proprietario;
 * non è un gate da eseguire automaticamente in CI.
 */

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

const USAGE = 'node scripts/assisted-application/owner-takeover-relaunch-check.mjs --order <id> --authorized-order <same-id>';

/** Parse the two required, explicit authorisation inputs. */
export function parseRelaunchArgs(argv = process.argv.slice(2)) {
  const values = { order: '', authorizedOrder: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--order') {
      if (values.order || !argv[index + 1]) throw new Error('order_required_once');
      values.order = String(argv[++index]).trim();
    } else if (flag === '--authorized-order') {
      if (values.authorizedOrder || !argv[index + 1]) throw new Error('authorized_order_required_once');
      values.authorizedOrder = String(argv[++index]).trim();
    } else {
      throw new Error(`unknown_argument:${flag}`);
    }
  }
  if (!values.order) throw new Error('order_required');
  if (!values.authorizedOrder) throw new Error('authorized_order_required');
  if (values.order !== values.authorizedOrder) throw new Error('order_not_authorized');
  return values;
}

export async function runOwnerTakeoverRelaunchCheck({ db, orderId, authorizedOrderId, runEffect, nowMs = Date.now() }) {
  const { relaunchAuthorizedOwnerTakeover } = await import('../../functions/src/assistedApplicationAutomation.js');
  const effect = runEffect || (await import('../../functions/src/assistedApplicationAutomationEffects.js')).runAutomationEffect;
  return relaunchAuthorizedOwnerTakeover({ db, orderId, authorizedOrderId, runEffect: effect, nowMs });
}

async function main() {
  const { order, authorizedOrder } = parseRelaunchArgs();
  const { getFirestoreDb } = await import('../lib/firestore-admin.mjs');
  const db = await getFirestoreDb();
  const result = await runOwnerTakeoverRelaunchCheck({
    db,
    orderId: order,
    authorizedOrderId: authorizedOrder,
  });
  if (!result.ok) {
    throw new Error(`relaunch_refused:${result.ignored || 'unknown'}`);
  }
  const failedEffect = (result.effectResults || []).find((effect) => effect && effect.ok === false);
  if (failedEffect) throw new Error(`relaunch_effect_failed:${failedEffect.error || failedEffect.effect || 'unknown'}`);
  console.log(`owner-takeover relaunch dispatched once for round ${Number(result.flow?.round) || 1}`);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`${error instanceof Error ? error.message : String(error)}\nUsage: ${USAGE}`);
    process.exitCode = 1;
  });
}
