/**
 * Scrittura atomica per i file che altri lavoratori leggono come «fratello».
 *
 * `fs.writeFile` tronca il file e poi lo riempie: un lettore concorrente puo'
 * vedere la pagina a meta'. Nel post-walk un bridge flat `X.html` si deriva dal
 * titolo e dai tag og:* di `X/index.html`, che un altro worker puo' stare
 * riscrivendo (link contestuali, hreflang, SRI): il bridge cambiava da run a
 * run. Scrivendo in un file temporaneo nella stessa directory e rinominando
 * (`rename` e' atomico su POSIX) il lettore vede sempre la versione intera,
 * vecchia o nuova. I trasformatori non toccano ne' `<title>` ne' og:* (pinnato
 * da tests/post-walk-sibling-atomic-write.test.ts), quindi le due versioni
 * danno lo stesso bridge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

let sequence = 0;

/** True per i file che il coordinatore legge come fratello di un bridge flat. */
export function isSiblingSource(filePath) {
  return path.basename(filePath) === 'index.html';
}

function tempPathFor(filePath) {
  sequence += 1;
  return `${filePath}.tmp-${process.pid}-${threadId}-${sequence}`;
}

export async function writeFileAtomic(filePath, content) {
  const tmp = tempPathFor(filePath);
  try {
    await fs.promises.writeFile(tmp, content, 'utf-8');
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeFileAtomicSync(filePath, content) {
  const tmp = tempPathFor(filePath);
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
