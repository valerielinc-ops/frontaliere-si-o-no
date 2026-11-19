import fs from 'node:fs';
import path from 'node:path';

export const L9_PRIVATE_EVIDENCE = 'l9-private-economic-evidence';

// Older L9 artifacts copied the employer ledger's MRR into JSON snapshots,
// the CLI log and Markdown. Check them before extracting canonical rows.
export function hasL9PrivateEvidence(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return hasL9PrivateEvidence(file);
    if (!entry.isFile() || !/\.(jsonl?|md|log)$/iu.test(entry.name)) return false;
    const contents = fs.readFileSync(file, 'utf8')
      .replace(/\\u([0-9a-f]{4})/giu, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
      .normalize('NFKC');
    if (/\.(md|log)$/iu.test(entry.name)
        && /^\s*(?:>\s*)*(?:[-*+]\s+)?[*_`]*recognized\s+mrr\s+chf[*_`]*\s*:/imu.test(contents)) {
      return true;
    }
    return !/\.md$/iu.test(entry.name)
      && /"(?:mrr[ _-]*recognized|recognized[ _-]*mrr)[ _-]*chf"\s*:/iu.test(contents);
  });
}
