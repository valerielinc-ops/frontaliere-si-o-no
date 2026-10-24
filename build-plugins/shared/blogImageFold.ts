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

/** `BLOG_IMAGE_CDN_FOLD=1` accende la scansione condivisa (default spento fino alla misura). */
export function blogImageFoldEnabled(): boolean {
  return process.env.BLOG_IMAGE_CDN_FOLD === '1';
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

/**
 * Stessa visita DFS di `collectHtml` (stesso ordine, stessi salti) piu' la
 * raccolta degli `extras`. Una sola passata di readdir al posto di due.
 */
export function collectHtmlWithBlogScope(root: string): BlogScopedWalk {
  const html: string[] = [];
  const extras: string[] = [];

  const visit = (dir: string, owned: boolean, inSkipped: boolean): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        const skipName = name === 'assets' || name === 'data' || name === 'images';
        const child = dir + path.sep + name;
        if (skipName) {
          // collectHtml non scende mai qui; il finalize scende solo se NON e'
          // la directory di primo livello (gestita dal chiamante).
          visit(child, owned, true);
        } else {
          visit(child, owned, inSkipped);
        }
        continue;
      }
      const fp = dir + path.sep + name;
      if (!inSkipped && entry.isFile() && name.endsWith('.html')) {
        html.push(fp);
        continue;
      }
      if (owned && SCAN_EXT.has(path.extname(name))) extras.push(fp);
    }
  };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    const fp = root + path.sep + name;
    if (entry.isDirectory()) {
      // Primo livello: assets|data|images non vengono visitati da nessuno dei
      // due walker.
      if (name === 'assets' || name === 'data' || name === 'images') continue;
      visit(fp, shouldEmitPath(fp, root), false);
      continue;
    }
    if (entry.isFile() && name.endsWith('.html')) {
      html.push(fp);
      continue;
    }
    if (SCAN_EXT.has(path.extname(name)) && shouldEmitPath(fp, root)) extras.push(fp);
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
