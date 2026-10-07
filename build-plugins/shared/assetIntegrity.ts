import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

type OutputAssetLike = {
  readonly type: 'asset';
  readonly source: string | Uint8Array;
};

type OutputChunkLike = {
  readonly type: 'chunk';
  readonly code: string;
};

/**
 * Build-time Subresource Integrity registry for assets served from the CDN.
 *
 * The site deliberately keeps public asset names stable, so a URL alone does
 * not identify the bytes a page expects.  Registering the bytes at build time
 * lets every HTML emitter add the matching sha384 value without downloading
 * from the live CDN or hashing each generated page.
 */
const integrityByAsset = new Map<string, string>();

function isIntegrityEligibleAsset(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0] || value;
  return /\.(?:css|js|mjs|wasm)$/i.test(pathname);
}

function normalizeAssetName(value: string): string {
  let pathname = value.split(/[?#]/, 1)[0] || value;
  try {
    pathname = new URL(pathname, 'https://frontaliereticino.ch').pathname;
  } catch {
    // Keep the raw path for malformed test fixtures; it may still be a valid
    // relative asset name after the normalization below.
  }
  pathname = pathname.replace(/^\/+/, '');
  return pathname.startsWith('assets/') ? pathname : `assets/${pathname}`;
}

export function sriIntegrity(content: string | Uint8Array): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

export function registerAssetIntegrity(assetName: string, content: string | Uint8Array): void {
  integrityByAsset.set(normalizeAssetName(assetName), sriIntegrity(content));
}

export function registerAssetFile(assetName: string, filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  registerAssetIntegrity(assetName, fs.readFileSync(filePath));
  return true;
}

export function integrityForAsset(value: string): string | undefined {
  return integrityByAsset.get(normalizeAssetName(value));
}

/** Return a structured-clone-friendly snapshot for post-walk workers. */
export function assetIntegritySnapshot(): ReadonlyMap<string, string> {
  return new Map(integrityByAsset);
}

/** Stable fingerprint used to invalidate incremental HTML transforms. */
export function assetIntegrityFingerprint(
  registry: ReadonlyMap<string, string> = integrityByAsset,
): string {
  const hash = createHash('sha256');
  for (const [name, integrity] of [...registry.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update('\0').update(integrity).update('\0');
  }
  return hash.digest('hex');
}

export function integrityAttributeForAsset(value: string): string {
  const integrity = integrityForAsset(value);
  return integrity ? ` integrity="${integrity}"` : '';
}

function sourceForOutput(output: OutputAssetLike | OutputChunkLike): string | Uint8Array {
  return output.type === 'asset' ? output.source : output.code;
}

/** Add SRI to Vite's own index.html after its asset URLs have been resolved. */
export function addIntegrityToHtml(
  html: string,
  registry: ReadonlyMap<string, string> = integrityByAsset,
): string {
  return html.replace(/<(script|link)\b([^>]*?)>/gi, (tag, _kind: string, attrs: string) => {
    const resource = attrs.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!resource || !/\/assets\//i.test(resource)) return tag;
    const integrityValue = registry.get(normalizeAssetName(resource));
    const integrity = integrityValue ? ` integrity="${integrityValue}"` : '';
    if (!integrity) return tag;
    const attrsWithoutIntegrity = attrs.replace(/\s+integrity\s*=\s*["'][^"']*["']/i, '');
    const crossorigin = /\bcrossorigin(?:\s*=\s*["'][^"']*["'])?/i.test(attrsWithoutIntegrity)
      ? ''
      : ' crossorigin="anonymous"';
    const selfClosing = /\s*\/$/.test(attrsWithoutIntegrity);
    const cleanAttrs = selfClosing ? attrsWithoutIntegrity.replace(/\s*\/$/, '') : attrsWithoutIntegrity;
    return `<${_kind}${cleanAttrs}${crossorigin}${integrity}${selfClosing ? ' /' : ''}>`;
  });
}

export function registerDistAssets(distDir: string): number {
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) return 0;
  let registered = 0;
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isIntegrityEligibleAsset(entry.name)) continue;
    if (registerAssetFile(`assets/${entry.name}`, path.join(assetsDir, entry.name))) {
      registered += 1;
    }
  }
  return registered;
}

/**
 * Register generated/public assets before closeBundle emitters render pages.
 * This hook also covers Vite's root index.html, whose tags do not pass through
 * the static-page template helpers.
 */
export function assetIntegrityManifestPlugin(rootDir: string): Plugin {
  return {
    name: 'asset-integrity-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!fileName.startsWith('assets/') || !isIntegrityEligibleAsset(fileName)) continue;
        registerAssetIntegrity(fileName, sourceForOutput(output));
      }

      for (const fileName of ['seo-static.css', 'bridge.css']) {
        registerAssetFile(
          `assets/${fileName}`,
          path.join(rootDir, 'public', 'assets', fileName),
        );
      }

      const index = bundle['index.html'];
      if (index?.type === 'asset' && typeof index.source === 'string') {
        index.source = addIntegrityToHtml(index.source);
      }
    },
  };
}

/** Test helper: isolate registry state between synthetic builds. */
export function resetAssetIntegrityForTests(): void {
  integrityByAsset.clear();
}
