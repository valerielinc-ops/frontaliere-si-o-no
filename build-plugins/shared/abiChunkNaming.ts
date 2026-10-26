/**
 * TypeScript shim for the interface-addressed chunk naming helpers.
 *
 * The runtime definition (and the full rationale) lives in
 * `./abiChunkNaming.mjs` so raw-`node` CI scripts can import it; this `.ts`
 * re-export lets vite.config.ts and the build plugins share the exact same
 * source of truth. Same pattern as `viteAssetHashRx.mjs` / `viteAssetHashRx.ts`.
 */
export {
  ABI_HASH_LENGTH,
  ABI_SUFFIX_RX,
  CHUNK_MANIFEST_FILENAME,
  GRANDFATHERED_ABI_HASHES,
  abiChunkFileName,
  chunkAbiHash,
  chunkFileInManifest,
  expectedAbiHash,
  isAbiChunkNamingEnabled,
  isChunkManifest,
  namedChunkExports,
  parseAbiSuffix,
  usesInterfaceAddressedNames,
  withAbiSuffix,
} from './abiChunkNaming.mjs';
