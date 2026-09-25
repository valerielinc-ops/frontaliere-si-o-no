#!/usr/bin/env node
/** Mark one successful ASTRA article workflow dispatch as delivered. */

import admin from "firebase-admin";

const FIRESTORE_COLLECTION = "config";
const FIRESTORE_DOC = "astra_vehicle_stats";

function parseArticleUrl(value) {
  const match = String(value || "").match(
    /^stats-astra:\/\/(weekly|monthly)\/([^/]+)\/(frontaliere|svizzera)$/,
  );
  if (!match) {
    throw new Error(
      `Invalid ASTRA article dispatch URL: ${value}; expected stats-astra://<weekly|monthly>/<period>/<section>`,
    );
  }
  return {
    cadence: match[1],
    period: decodeURIComponent(match[2]),
    section: match[3],
  };
}

async function main() {
  const url = process.argv[2];
  const parsed = parseArticleUrl(url);
  const key = `${parsed.cadence}/${parsed.period}/${parsed.section}`;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || "frontaliere-ticino",
    });
  }

  const db = admin.firestore();
  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error("ASTRA Firestore document is missing.");
    const data = snapshot.data() || {};
    const outbox = Array.isArray(data.articleOutbox) ? data.articleOutbox : [];
    const index = outbox.findIndex(
      (entry) => entry?.key === key && entry?.url === url,
    );
    if (index < 0) {
      throw new Error(`ASTRA article outbox entry not found: ${key}`);
    }
    if (outbox[index].status === "dispatched") return;
    outbox[index] = {
      ...outbox[index],
      status: "dispatched",
      dispatchedAt: new Date().toISOString(),
    };
    transaction.update(ref, { articleOutbox: outbox });
  });
  console.error(`✅ ASTRA article dispatch recorded: ${key}`);
}

main().catch((error) => {
  console.error(`❌ ASTRA article dispatch acknowledgement failed: ${error?.stack || error?.message || error}`);
  process.exit(1);
});
