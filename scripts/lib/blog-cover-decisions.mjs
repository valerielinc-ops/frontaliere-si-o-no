/**
 * The explicit "kept without credit" decision for a historical blog cover.
 *
 * The licence audit of October 2026 could not prove a source for part of the
 * cover archive. Those covers stay published by the owner's choice, and the
 * choice is recorded twice: in the ledger (`data/blog-cover-ledger.json`) and
 * in the unified index (`data/image-credits-blog.json`). A cover falls under
 * it only when both files say so in the same terms; one of them alone is not
 * a decision.
 *
 * One definition, because two gates ask this question: the ledger verifier
 * (scripts/ci/verify-blog-cover-ledger.mjs) and the og:image build gate
 * (published-image-policy.mjs). While each had its own answer the og gate
 * rejected what the ledger gate accepts, and the post-deploy validation was
 * red on every build (issue 12347).
 */
import fs from 'node:fs';
import path from 'node:path';

/** True when ledger and index both carry the no-credit decision for a cover. */
export function isExplicitInferredCover(ledgerItem, indexEntry) {
  return ledgerItem?.proofLevel === 6
    && ledgerItem.evidence === 'inferred'
    && typeof ledgerItem.verifiedAt === 'string'
    && ledgerItem.status === 'no-credit'
    && indexEntry?.evidence === 'inferred'
    && indexEntry.provider === null
    && indexEntry.verifiedAt === ledgerItem.verifiedAt
    && indexEntry.status === 'no-credit';
}

function readCovers(file) {
  try {
    const covers = JSON.parse(fs.readFileSync(file, 'utf8'))?.covers;
    return covers && typeof covers === 'object' ? covers : {};
  } catch {
    // A missing or unreadable file records no decision: nothing is waved through.
    return {};
  }
}

/**
 * The decisions on record under `root`, answered by cover key (the cover's
 * file name without extension). The two files are read on first use.
 */
export function loadInferredCoverDecisions({ root = process.cwd() } = {}) {
  let ledger = null;
  let index = null;
  return {
    has(key) {
      if (typeof key !== 'string' || key === '') return false;
      ledger ??= readCovers(path.join(root, 'data/blog-cover-ledger.json'));
      index ??= readCovers(path.join(root, 'data/image-credits-blog.json'));
      return Object.hasOwn(ledger, key) && Object.hasOwn(index, key)
        && isExplicitInferredCover(ledger[key], index[key]);
    },
  };
}
