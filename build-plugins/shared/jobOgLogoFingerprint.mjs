import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function readCompanyLogosManifest(rootDir) {
  const file = path.join(rootDir, 'data/company-logos-manifest.json');
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function companyLogoFingerprint(manifestPath, imageBytes) {
  if (!manifestPath || !manifestPath.startsWith('/images/brands/')) return 'no-logo';
  return createHash('sha1')
    .update(manifestPath)
    .update(imageBytes ?? 'missing')
    .digest('hex')
    .slice(0, 10);
}

export function createJobOgLogoFingerprintResolver(rootDir) {
  const manifest = readCompanyLogosManifest(rootDir);
  const fingerprints = new Map();

  return (companyKey) => {
    const manifestPath = companyKey ? manifest[companyKey] : undefined;
    if (!manifestPath || !manifestPath.startsWith('/images/brands/')) return 'no-logo';
    const cached = fingerprints.get(manifestPath);
    if (cached) return cached;

    let imageBytes = null;
    const relativePath = manifestPath.slice('/images/brands/'.length);
    if (!relativePath.includes('..')) {
      const abs = path.join(rootDir, 'public/images/brands', relativePath);
      if (existsSync(abs)) {
        try {
          imageBytes = readFileSync(abs);
        } catch {
          /* a missing or unreadable logo still has a stable fallback fingerprint */
        }
      }
    }

    const fingerprint = companyLogoFingerprint(manifestPath, imageBytes);
    fingerprints.set(manifestPath, fingerprint);
    return fingerprint;
  };
}
