import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  generatedImagePrefixForScope,
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';

const PUBLISHED_SCOPES = new Set(['editorial-profile', 'place']);
const PUBLISHED_PREFIXES = ['/images/authors/', '/images/places/'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function imagePathForUrl(rootDir, imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('/images/')) return null;
  const publicDir = path.resolve(rootDir, 'public');
  const filePath = path.resolve(publicDir, `.${imageUrl}`);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) return null;
  return filePath;
}

function listPublishedImages(rootDir) {
  const publicDir = path.resolve(rootDir, 'public');
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  };
  for (const prefix of ['images/authors', 'images/places']) visit(path.join(publicDir, prefix));
  return files;
}

export async function verifyPublishedGeneratedSiteImages({
  rootDir = process.cwd(),
  registryPath = path.join('data', 'generated-image-registry.json'),
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedRegistryPath = path.resolve(resolvedRoot, registryPath);
  const errors = [];
  if (!fs.existsSync(resolvedRegistryPath)) return { valid: false, errors: ['generated image registry is missing'] };

  const registry = JSON.parse(fs.readFileSync(resolvedRegistryPath, 'utf8'));
  const registryValidation = validateGeneratedImageRegistry(registry);
  if (!registryValidation.valid) errors.push(...registryValidation.errors);
  const records = Array.isArray(registry.assets) ? registry.assets : [];
  const publishedRecords = records.filter((record) => PUBLISHED_SCOPES.has(record?.scope));
  const byUrl = new Map();
  for (const record of publishedRecords) {
    const validation = validateGeneratedImageRecord(record);
    if (!validation.valid) errors.push(`${record?.assetId || '<unknown>'}: ${validation.errors.join(', ')}`);
    if (!PUBLISHED_SCOPES.has(record?.scope)) continue;
    if (!PUBLISHED_PREFIXES.some((prefix) => String(record?.imageUrl || '').startsWith(prefix))) {
      errors.push(`${record?.assetId || '<unknown>'}: published image URL is outside authors/places`);
      continue;
    }
    if (record.imageUrl && byUrl.has(record.imageUrl)) errors.push(`${record.assetId}: duplicate published image URL`);
    byUrl.set(record.imageUrl, record);
    const expectedPrefix = generatedImagePrefixForScope(record.scope);
    if (!String(record.imageUrl || '').startsWith(expectedPrefix)) {
      errors.push(`${record.assetId}: image URL does not match ${record.scope} prefix`);
    }
    const filePath = imagePathForUrl(resolvedRoot, record.imageUrl);
    if (!filePath || !fs.existsSync(filePath)) {
      errors.push(`${record.assetId}: published file is missing (${record.imageUrl})`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    if (buffer.byteLength !== record.bytes) errors.push(`${record.assetId}: bytes do not match registry`);
    if (sha256(buffer) !== record.sha256) errors.push(`${record.assetId}: sha256 does not match registry`);
    try {
      const metadata = await sharp(buffer).metadata();
      if (metadata.format !== 'webp') errors.push(`${record.assetId}: file is not WebP`);
      if (metadata.width !== record.width || metadata.height !== record.height) errors.push(`${record.assetId}: dimensions do not match registry`);
    } catch (error) {
      errors.push(`${record.assetId}: image metadata read failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  for (const filePath of listPublishedImages(resolvedRoot)) {
    const imageUrl = `/${path.relative(path.resolve(resolvedRoot, 'public'), filePath).split(path.sep).join('/')}`;
    if (!byUrl.has(imageUrl)) errors.push(`published file has no registry record: ${imageUrl}`);
  }

  return { valid: errors.length === 0, errors, records: publishedRecords };
}
