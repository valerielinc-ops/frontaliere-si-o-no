/**
 * shrink-ack-check.mjs — decide whether a tripped section-shard shrink guard is
 * covered by a pinned, human-verified acknowledgement.
 *
 * Called by scripts/lib/push-section-shard.sh ONLY after its own guard has
 * already decided the shrink is large enough to refuse. This module never
 * *creates* permission to shrink; it only answers "was THIS transition signed
 * off?" for a shrink that is already on its way to `exit 1`.
 *
 * Why not the bare SHARD_SHRINK_GUARD_OVERRIDE_<SECTION>_<LOCALE>=true env var
 * (which stays, as the break-glass hatch): a boolean is unpinned and untimed.
 * The run that legitimises one correction keeps the guard off for every later
 * run too, so the next genuine collapse pushes silently, and nothing forces the
 * flag back out. Incident that motivated this: issues #5220/#5221/#5222 —
 * giura fr/en/de refused the same 4948->1259 shrink on EVERY deploy for ~12h
 * while the shard served 2056 pages built on a fabricated locality. Because the
 * push is refused, .shard-filecount never advances, so the guard re-trips
 * identically forever: it is self-perpetuating, and only a human can end it.
 *
 * The pin: an ack matches only when `prev` equals the ack's `from` EXACTLY —
 * i.e. the shard still carries the counter the human looked at. The moment the
 * acknowledged push lands, .shard-filecount moves to the new value, `from` no
 * longer matches, and the entry is inert. No cleanup commit required, and no
 * window in which the guard is off for anything other than the one reviewed
 * transition.
 *
 * `min_new` is a FLOOR, deliberately not a target band. The hazard the shrink
 * guard exists for is force-pushing a near-empty tree over a populated shard;
 * an upward drift is not that hazard, and a band would make ordinary job churn
 * between review and deploy re-refuse a shrink a human already approved.
 *
 * Usage (exit 0 = acknowledged, 1 = refuse, 2 = bad input):
 *   node scripts/lib/shrink-ack-check.mjs --section giura --locale fr \
 *     --prev 4948 --new 1259 [--acks path/to/acks.json]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ACKS_PATH = resolve(HERE, 'section-shard-shrink-acks.json');

/**
 * Decide whether a tripped shrink is covered by a pinned acknowledgement.
 *
 * @param {object} input
 * @param {string} input.section  section key, e.g. "giura"
 * @param {string} input.locale   locale, e.g. "fr"
 * @param {number} input.prev     the shard's current .shard-filecount
 * @param {number} input.next     file count the build just produced
 * @param {object} input.acks     parsed acks document
 * @returns {{ acknowledged: boolean, reason: string }}
 */
export function checkShrinkAck({ section, locale, prev, next, acks }) {
  if (!Number.isInteger(prev) || !Number.isInteger(next) || prev < 0 || next < 0) {
    return { acknowledged: false, reason: `non-integer file counts (prev=${prev}, new=${next})` };
  }
  const ack = acks?.[section]?.[locale];
  if (!ack) {
    return { acknowledged: false, reason: `no acknowledgement for ${section}/${locale}` };
  }
  // Pinned to the exact baseline a human reviewed. Once the acknowledged push
  // lands, .shard-filecount advances and this stops matching — that is what
  // makes the entry self-expiring rather than a standing permission.
  if (ack.from !== prev) {
    return {
      acknowledged: false,
      reason:
        `acknowledgement for ${section}/${locale} is pinned to from=${ack.from} but the shard ` +
        `reports prev=${prev} — the baseline moved since it was reviewed, so it no longer applies`,
    };
  }
  // Floor, not a band: this is the "near-empty tree" hazard the guard exists for.
  if (!Number.isInteger(ack.min_new) || next < ack.min_new) {
    return {
      acknowledged: false,
      reason:
        `${section}/${locale} built ${next} files, below the acknowledged floor min_new=${ack.min_new} ` +
        `— this is a deeper drop than the one that was reviewed`,
    };
  }
  return {
    acknowledged: true,
    reason:
      `${section}/${locale} shrink ${prev} -> ${next} is acknowledged (issue #${ack.issue ?? '?'}, ` +
      `floor ${ack.min_new}): ${ack.reason ?? 'no reason recorded'}`,
  };
}

/** @param {string} name */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const section = arg('section');
  const locale = arg('locale');
  const prev = Number(arg('prev'));
  const next = Number(arg('new'));
  if (!section || !locale) {
    console.error('usage: shrink-ack-check.mjs --section <s> --locale <l> --prev <n> --new <n>');
    process.exit(2);
  }
  let acks;
  try {
    acks = JSON.parse(readFileSync(arg('acks') || DEFAULT_ACKS_PATH, 'utf8'));
  } catch (err) {
    // Fail CLOSED: an unreadable/broken acks file must refuse the shrink, never
    // wave it through. The caller is already on the refusal path.
    console.error(`shrink-ack-check: cannot read acks (${err.message}) — refusing`);
    process.exit(1);
  }
  const { acknowledged, reason } = checkShrinkAck({ section, locale, prev, next, acks });
  console.log(reason);
  process.exit(acknowledged ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
