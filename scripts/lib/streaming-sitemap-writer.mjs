import fs from 'node:fs';
import path from 'node:path';

/**
 * Append sitemap `<url>` blocks without retaining the whole sitemap in RAM.
 *
 * A sitemap is both a byte stream and a bounded protocol document. Callers
 * often discover entries one at a time (for example while rendering expired
 * jobs), so collecting them in an array just to call `emitSitemapXml()` turns
 * a disk-backed build into an avoidable corpus-sized allocation. This writer
 * keeps only one small pending chunk and closes each shard at `cap` URLs.
 *
 * @param {{
 *   distDir: string,
 *   filePrefix: string,
 *   cap: number,
 *   header: string,
 *   footer?: string,
 *   chunkEntries?: number,
 *   padIndex?: (index: number) => string,
 * }} options
 */
export function createStreamingSitemapWriter({
  distDir,
  filePrefix,
  cap,
  header,
  footer = '</urlset>\n',
  chunkEntries = 10_000,
  padIndex = (index) => String(index).padStart(3, '0'),
}) {
  if (!distDir || !filePrefix) throw new TypeError('streaming sitemap writer requires distDir and filePrefix');
  if (!Number.isInteger(cap) || cap <= 0) throw new TypeError('streaming sitemap writer cap must be a positive integer');
  if (!Number.isInteger(chunkEntries) || chunkEntries <= 0) throw new TypeError('streaming sitemap writer chunkEntries must be a positive integer');

  const pending = [];
  const files = [];
  let shardIndex = 0;
  let shardEntries = 0;
  let initialized = false;
  let totalEntries = 0;
  let finished = false;

  const currentPath = () => path.join(distDir, `${filePrefix}-${padIndex(shardIndex + 1)}.xml`);

  const flushPending = () => {
    if (pending.length === 0) return;
    const filePath = currentPath();
    const chunk = `${pending.join('\n')}\n`;
    if (!initialized) {
      fs.writeFileSync(filePath, `${header}${chunk}`, 'utf8');
      initialized = true;
    } else {
      fs.appendFileSync(filePath, chunk, 'utf8');
    }
    pending.length = 0;
  };

  const closeShard = () => {
    if (shardEntries === 0) return;
    flushPending();
    fs.appendFileSync(currentPath(), footer, 'utf8');
    files.push(path.basename(currentPath()));
    shardIndex += 1;
    shardEntries = 0;
    initialized = false;
  };

  return {
    /** Add one already-rendered `<url>...</url>` block. */
    push(entry) {
      if (finished) throw new Error('streaming sitemap writer is already finished');
      if (typeof entry !== 'string' || entry.length === 0) return;
      if (shardEntries >= cap) closeShard();
      pending.push(entry);
      shardEntries += 1;
      totalEntries += 1;
      if (pending.length >= chunkEntries || shardEntries >= cap) flushPending();
      if (shardEntries >= cap) closeShard();
    },

    /** Close the final partial shard and return the emitted filenames. */
    finish() {
      if (finished) return { files: [...files], entries: totalEntries };
      closeShard();
      finished = true;
      return { files: [...files], entries: totalEntries };
    },

    get files() { return [...files]; },
    get entries() { return totalEntries; },
  };
}
