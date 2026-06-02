/**
 * Cleanup Mailjet contacts to stay under the free-tier 1,000-contact cap.
 *
 * WHY: the transactional Send API (v3.1) auto-registers every recipient as a
 * Mailjet contact. The free plan blocks *all* sending once the account exceeds
 * 1,000 contacts ("You've surpassed the free account's 1,000 contacts limit").
 * Mailjet only ever sees the ≤200 sends/day the cascade routes to it, so a daily
 * trim keeps the account comfortably under the cap. Our subscriber source of
 * truth is Firebase — Mailjet contacts are disposable send artifacts, re-created
 * on the next send, so deleting them is safe.
 *
 * POLICY: keep the newest KEEP contacts (default 500), permanently delete the
 * oldest ones above that threshold. GDPR delete is irreversible (anonymized
 * immediately, purged within 30 days).
 *
 * API:
 *   - List:   GET    https://api.mailjet.com/v3/REST/contact   (paginated, Limit≤1000)
 *   - Delete: DELETE https://api.mailjet.com/v4/contacts/{ID}   (GDPR, single contact, 200 OK)
 *   Auth: Basic base64(MAILJET_API_KEY:MAILJET_SECRET_KEY)
 *
 * ENV:
 *   MAILJET_API_KEY, MAILJET_SECRET_KEY  — credentials (from Remote Config in CI)
 *   KEEP            — contacts to retain (default 500)
 *   DRY_RUN         — '1'/'true' to list candidates without deleting
 *   MAX_DELETE      — safety cap on deletions per run (default 3000)
 *   DELETE_DELAY_MS — throttle between DELETE calls (default 250)
 *
 * Flags mirror env: --dry-run, --keep N, --max-delete N.
 */

const API_BASE = 'https://api.mailjet.com';
const PAGE_SIZE = 1000; // Mailjet max Limit per page

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--keep') out.keep = Number(argv[++i]);
    else if (a === '--max-delete') out.maxDelete = Number(argv[++i]);
  }
  return out;
}

function truthy(v) {
  return v === '1' || String(v).toLowerCase() === 'true';
}

function authHeader() {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error('MAILJET_API_KEY / MAILJET_SECRET_KEY not set');
  }
  return `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch every contact (paginated). Returns array of { ID, Email, CreatedAt }.
 * We pull all pages and sort client-side so ordering does not depend on
 * Mailjet honouring a Sort parameter on this resource.
 */
async function fetchAllContacts(auth) {
  const all = [];
  const seen = new Set();
  let offset = 0;
  // Terminate on a short/empty page, NOT on the `Total` field. If Mailjet ever
  // omits `Total`, a count-based loop would stop after the first full page and
  // silently miss every contact beyond the first 1000 — the exact overflow this
  // script exists to trim. A full page (length === PAGE_SIZE) means "there may
  // be more"; a short page is the last one.
  for (;;) {
    const url = `${API_BASE}/v3/REST/contact?Limit=${PAGE_SIZE}&Offset=${offset}`;
    const res = await fetchWithRetry(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`List contacts failed ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const page = json.Data ?? [];
    let added = 0;
    for (const c of page) {
      if (seen.has(c.ID)) continue; // skip dupes from an ignored Offset
      seen.add(c.ID);
      all.push({ ID: c.ID, Email: c.Email, CreatedAt: c.CreatedAt });
      added++;
    }
    if (page.length < PAGE_SIZE) break; // last page
    if (added === 0) {
      // A full page that added zero new IDs means Mailjet is ignoring Offset
      // and re-serving page 1. Fail loudly instead of looping forever.
      throw new Error(
        `Pagination stalled at offset ${offset}: full page returned only already-seen IDs (Offset may be ignored).`,
      );
    }
    offset += page.length;
  }
  return all;
}

/** fetch with exponential backoff on 429 / 5xx. */
async function fetchWithRetry(url, opts, attempt = 0) {
  const res = await fetch(url, opts);
  if ((res.status === 429 || res.status >= 500) && attempt < 5) {
    const wait = Math.min(30000, 1000 * 2 ** attempt);
    console.warn(`   ⏳ ${res.status} on ${opts.method || 'GET'} — backoff ${wait}ms (retry ${attempt + 1}/5)`);
    await sleep(wait);
    return fetchWithRetry(url, opts, attempt + 1);
  }
  return res;
}

async function deleteContact(auth, id) {
  const res = await fetchWithRetry(`${API_BASE}/v4/contacts/${id}`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  return res;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keep = Number.isFinite(args.keep) ? args.keep : Number(process.env.KEEP ?? 500);
  const maxDelete = Number.isFinite(args.maxDelete)
    ? args.maxDelete
    : Number(process.env.MAX_DELETE ?? 3000);
  const dryRun = args.dryRun || truthy(process.env.DRY_RUN);
  const delayMs = Number(process.env.DELETE_DELAY_MS ?? 250);

  if (!Number.isFinite(keep) || keep < 0) throw new Error(`Invalid KEEP: ${keep}`);

  const auth = authHeader();

  console.log(`🧹 Mailjet contact cleanup — keep newest ${keep}, dryRun=${dryRun}, maxDelete=${maxDelete}`);

  const contacts = await fetchAllContacts(auth);
  console.log(`   📊 Total contacts: ${contacts.length}`);

  if (contacts.length <= keep) {
    console.log(`✅ Under threshold (${contacts.length} ≤ ${keep}) — nothing to delete.`);
    return;
  }

  // Oldest first: smaller CreatedAt = older. Fall back to ID order if dates equal/missing.
  contacts.sort((a, b) => {
    const ta = Date.parse(a.CreatedAt ?? '') || 0;
    const tb = Date.parse(b.CreatedAt ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return (a.ID ?? 0) - (b.ID ?? 0);
  });

  const overflow = contacts.length - keep;
  const candidates = contacts.slice(0, Math.min(overflow, maxDelete));
  console.log(`   🎯 Over threshold by ${overflow}; deleting ${candidates.length} oldest (capped at ${maxDelete}).`);

  if (dryRun) {
    console.log('   🧪 DRY RUN — would delete (oldest 10 shown):');
    for (const c of candidates.slice(0, 10)) {
      console.log(`      - ${c.ID} ${c.Email} (created ${c.CreatedAt})`);
    }
    console.log(`✅ Dry run complete — ${candidates.length} contacts would be deleted.`);
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      const res = await deleteContact(auth, c.ID);
      if (res.ok || res.status === 200 || res.status === 204) {
        deleted++;
      } else {
        failed++;
        const body = await res.text().catch(() => '');
        console.warn(`   ❌ [${i + 1}/${candidates.length}] ${c.Email} → ${res.status}: ${body.slice(0, 120)}`);
      }
    } catch (err) {
      failed++;
      console.warn(`   ❌ [${i + 1}/${candidates.length}] ${c.Email} → ${err.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`   … ${i + 1}/${candidates.length} processed (${deleted} ok, ${failed} failed)`);
    if (delayMs > 0) await sleep(delayMs);
  }

  // Re-fetch the live count instead of trusting local arithmetic
  // (contacts.length - deleted). GDPR delete returns 200 but the quota
  // decrement can lag ("purged within 30 days"): a local estimate would show
  // ~500 and exit green while the account is still > 1000 and sending stays
  // blocked — blind to the very failure this guard must catch.
  let remaining;
  try {
    remaining = (await fetchAllContacts(auth)).length;
  } catch (err) {
    console.error(`❌ Post-delete re-count failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅ Done: ${deleted} deleted, ${failed} failed. Live remaining (re-fetched): ${remaining}.`);

  // Fail the workflow loudly: a green run that left the quota blocked (remaining
  // > 1000) or hit non-retryable DELETE errors is a silent failure on a gate
  // that must keep sending unblocked. Never downgrade this to a warning.
  if (remaining > 1000) {
    console.error(`❌ Still above 1,000 (${remaining}). GDPR purge may lag; re-run or lower KEEP.`);
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`❌ ${failed} deletions failed after backoff — quota trim incomplete.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`💥 ${err.message}`);
  process.exit(1);
});
