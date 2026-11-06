/**
 * Scansione blog-image condivisa con il post-walk coordinator.
 *
 * Perche' esiste
 * --------------
 * `blogImageCdnFinalizePlugin` legge OGNI file .html/.xml/.txt del dist (1,8 M
 * file, ~475 s per gamba) per riscrivere i riferimenti `/images/blog/<file>`
 * verso la CDN e, soprattutto, per controllare che nessun riferimento
 * sopravviva alla cancellazione delle immagini. Sul deploy riscrive 0 file.
 * `postWalkCoordinatorPlugin` legge GIA' ogni pagina HTML subito dopo (stessa
 * popolazione, 1,88 M file), quindi la seconda lettura paga il disco due
 * volte per un'informazione che il coordinatore ha in memoria.
 *
 * Contratto (esatto, non euristico)
 * ---------------------------------
 * Le tre regex del finalize (`reAbs`, `reRel`, `reLeak`) richiedono la
 * sottostringa ASCII `/images/blog/`: un file che non la contiene non puo' ne'
 * essere riscritto ne' contare come leak. Il coordinatore (in worker o
 * single-thread) controlla quella sottostringa sul contenuto FINALE di ogni
 * pagina che legge e riporta i soli path che la contengono (`markerPaths`).
 * Il finalize rilegge SOLO quelli, piu' tutto cio' che il coordinatore non ha
 * letto (`extraPaths`: .xml/.txt, sotto-directory annidate chiamate
 * assets|data|images, bridge pre-emessi, pagine fuori dalla lista di
 * lavoro, letture/scritture fallite). Il perimetro del finalize resta quello
 * di sempre: lo calcola `collectHtmlWithBlogScope`, che applica gli stessi
 * filtri del walker originale (`dist/{assets,data,images}` di primo livello
 * saltati, sottoalbero di un locale non posseduto escluso).
 *
 * Se il coordinatore non puo' garantire la copertura (walk incrementale,
 * nessun HTML, errore) non pubblica nulla e il finalize ricade sullo sweep
 * completo originale.
 */
import fs from 'node:fs';
import path from 'node:path';

import { shouldEmitPath } from './localeEmitFilter';

/** Unica sequenza che le regex del finalize possono riconoscere. */
export const BLOG_IMAGE_REF_MARKER = '/images/blog/';

const SCAN_EXT = new Set(['.html', '.xml', '.txt']);

/**
 * La scansione condivisa e' accesa di default; `BLOG_IMAGE_CDN_FOLD=0` riporta
 * il finalize allo sweep completo storico (e al suo hook senza `order`).
 */
export function blogImageFoldEnabled(): boolean {
  return process.env.BLOG_IMAGE_CDN_FOLD !== '0';
}

export interface PostWalkBlogScan {
  readonly distDir: string;
  /** File letti dal coordinatore il cui contenuto finale contiene il marker. */
  readonly markerPaths: readonly string[];
  /** File nel perimetro del finalize che il coordinatore NON ha verificato. */
  readonly extraPaths: readonly string[];
}

let published: PostWalkBlogScan | null = null;

export function resetPostWalkBlogScan(): void {
  published = null;
}

export function publishPostWalkBlogScan(scan: PostWalkBlogScan): void {
  published = scan;
}

/** Consuma (una sola volta) la scansione pubblicata per `distDir`. */
export function takePostWalkBlogScan(distDir: string): PostWalkBlogScan | null {
  const scan = published;
  published = null;
  if (!scan || path.resolve(scan.distDir) !== path.resolve(distDir)) return null;
  return scan;
}

export interface BlogScopedWalk {
  /** Elemento per elemento uguale a `collectHtml(dir, [])`. */
  readonly html: string[];
  /**
   * File del perimetro del finalize che NON stanno in `html`: .xml/.txt e tutto
   * il contenuto scansionabile sotto directory annidate assets|data|images
   * (il walker del coordinatore non vi scende, quello del finalize si').
   */
  readonly extras: string[];
}

const isSkippedName = (name: string): boolean => name === 'assets' || name === 'data' || name === 'images';

/**
 * Classifica le voci di UNA directory. Unica definizione delle regole di
 * visita, condivisa dalla versione sincrona e da quella parallela, cosi' non
 * possono divergere. `onDir` riceve le sottodirectory da visitare (con i flag
 * da ereditare) nell'ordine di readdir; `onHtml` e `onExtra` i file.
 */
function classifyEntries(
  dir: string,
  entries: fs.Dirent[],
  atRoot: boolean,
  owned: boolean,
  inSkipped: boolean,
  root: string,
  onDir: (child: string, childOwned: boolean, childInSkipped: boolean) => void,
  onHtml: (file: string) => void,
  onExtra: (file: string) => void,
): void {
  for (const entry of entries) {
    const name = entry.name;
    const fp = dir + path.sep + name;
    if (entry.isDirectory()) {
      if (atRoot) {
        // Primo livello: assets|data|images non vengono visitati da nessuno dei
        // due walker; le altre directory fissano il flag di proprieta'.
        if (isSkippedName(name)) continue;
        onDir(fp, shouldEmitPath(fp, root), false);
      } else if (isSkippedName(name)) {
        // collectHtml non scende mai qui; il finalize si' (solo se NON e' una
        // directory di primo livello, gia' esclusa sopra).
        onDir(fp, owned, true);
      } else {
        onDir(fp, owned, inSkipped);
      }
      continue;
    }
    if (!inSkipped && entry.isFile() && name.endsWith('.html')) {
      onHtml(fp);
      continue;
    }
    if (atRoot) {
      if (SCAN_EXT.has(path.extname(name)) && shouldEmitPath(fp, root)) onExtra(fp);
    } else if (owned && SCAN_EXT.has(path.extname(name))) {
      onExtra(fp);
    }
  }
}

/**
 * Stessa visita DFS di `collectHtml` (stesso ordine, stessi salti) piu' la
 * raccolta degli `extras`. Una sola passata di readdir al posto di due.
 */
export function collectHtmlWithBlogScope(root: string): BlogScopedWalk {
  const html: string[] = [];
  const extras: string[] = [];

  const visit = (dir: string, atRoot: boolean, owned: boolean, inSkipped: boolean): void => {
    classifyEntries(
      dir,
      fs.readdirSync(dir, { withFileTypes: true }),
      atRoot,
      owned,
      inSkipped,
      root,
      (child, childOwned, childInSkipped) => visit(child, false, childOwned, childInSkipped),
      (file) => html.push(file),
      (file) => extras.push(file),
    );
  };
  visit(root, true, true, false);
  return { html, extras };
}

interface DirNode {
  items: Array<string | DirNode>;
}

/**
 * Come `collectHtmlWithBlogScope`, ma con `lanes` readdir asincroni in volo: su
 * un albero freddo da ~1,3 M directory il walker sincrono paga una latenza di
 * disco alla volta (~230 s a gamba). L'ORDINE dell'elenco `html` e' lo stesso
 * del DFS sincrono: ogni directory conserva le proprie voci in ordine di
 * readdir, con un segnaposto al posto di ciascuna sottodirectory, e l'elenco
 * si ricompone alla fine visitando i segnaposto in ordine. Gli `extras` non
 * hanno un ordine di consumo (il finalize li passa da un Set).
 */
export async function collectHtmlWithBlogScopeParallel(
  root: string,
  lanes: number,
): Promise<BlogScopedWalk> {
  const extras: string[] = [];
  const rootNode: DirNode = { items: [] };
  type Task = { dir: string; node: DirNode; atRoot: boolean; owned: boolean; inSkipped: boolean };
  const stack: Task[] = [{ dir: root, node: rootNode, atRoot: true, owned: true, inSkipped: false }];
  let inFlight = 0;
  let failure: unknown = null;
  let wake: Array<() => void> = [];
  const notify = (): void => {
    const waiting = wake;
    wake = [];
    for (const resolve of waiting) resolve();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure) return;
      const task = stack.pop();
      if (!task) {
        if (inFlight === 0) return;
        await new Promise<void>((resolve) => wake.push(resolve));
        continue;
      }
      inFlight++;
      try {
        const entries = await fs.promises.readdir(task.dir, { withFileTypes: true });
        classifyEntries(
          task.dir,
          entries,
          task.atRoot,
          task.owned,
          task.inSkipped,
          root,
          (child, childOwned, childInSkipped) => {
            const node: DirNode = { items: [] };
            task.node.items.push(node);
            stack.push({ dir: child, node, atRoot: false, owned: childOwned, inSkipped: childInSkipped });
          },
          (file) => task.node.items.push(file),
          (file) => extras.push(file),
        );
      } catch (error) {
        failure = failure ?? error;
      } finally {
        inFlight--;
        notify();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, lanes) }, () => worker()));
  if (failure) throw failure;

  const html: string[] = [];
  // Appiattimento iterativo (nessuna ricorsione profonda): pila di cursori.
  const frames: Array<{ items: Array<string | DirNode>; i: number }> = [{ items: rootNode.items, i: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.i >= frame.items.length) {
      frames.pop();
      continue;
    }
    const item = frame.items[frame.i++];
    if (typeof item === 'string') html.push(item);
    else frames.push({ items: item.items, i: 0 });
  }
  return { html, extras };
}

/**
 * True se il finalize originale avrebbe visitato questo file della lista HTML.
 * `topLevelOwned` e' una cache per directory di primo livello.
 */
export function isInBlogSweepScope(
  distDir: string,
  filePath: string,
  topLevelOwned: Map<string, boolean>,
): boolean {
  if (!SCAN_EXT.has(path.extname(filePath))) return false;
  const prefix = distDir.endsWith(path.sep) ? distDir : distDir + path.sep;
  if (!filePath.startsWith(prefix)) return true; // fuori dall'albero: fail-safe, rileggi
  const rest = filePath.slice(prefix.length);
  const sep = rest.indexOf(path.sep);
  if (sep < 0) return shouldEmitPath(filePath, distDir);
  const top = rest.slice(0, sep);
  let owned = topLevelOwned.get(top);
  if (owned === undefined) {
    owned = shouldEmitPath(prefix + top, distDir);
    topLevelOwned.set(top, owned);
  }
  return owned;
}
