#!/usr/bin/env node

/**
 * Apply the image-only part of the site broker to the adapted corpus broker.
 *
 * The two brokers intentionally do not have identical contracts: the corpus
 * keeps its literal model/profile/one-shot defaults for the crawler action,
 * while the site broker has a wider shared-lane contract. Replacing the corpus
 * file byte-for-byte would erase those guarantees and its trusted-runtime
 * tests catch exactly that drift. This patcher carries only the image lane and
 * refuses to operate on an unknown broker shape.
 *
 * argv: <corpus-broker> <site-broker>
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [targetArgument, sourceArgument] = process.argv.slice(2);

function fail(message) {
  console.error(`corpus image broker patch: ${message}`);
  process.exitCode = 1;
}

function readRegular(filePath, label) {
  if (!filePath) {
    fail(`${label} path is required`);
    return null;
  }
  const absolute = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    fail(`${label} is not readable: ${error.message}`);
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
    return null;
  }
  return { absolute, text: fs.readFileSync(absolute, 'utf8') };
}

function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  return text.replace(needle, replacement);
}

const target = readRegular(targetArgument, 'corpus broker');
const source = readRegular(sourceArgument, 'site broker');
if (!target || !source) process.exit(1);

const sourceMarkers = [
  'const IMAGE_EXTENSIONS = new Set([',
  "args.push('--enable', 'image_generation')",
  'const imageGenerationStartedAt = Date.now();',
  'if (!result && !imageOutputPath)',
  'imageGeneration: job.parsed.imageGeneration === true',
];
for (const marker of sourceMarkers) {
  if (!source.text.includes(marker)) {
    fail(`site broker lacks the attested image-lane marker: ${marker}`);
    process.exit(1);
  }
}

const legacyContractMarkers = [
  "const CODEX_MODEL = 'gpt-5.6-luna';",
  "const CODEX_EFFORT = 'max';",
  "const CODEX_PROFILE = 'claude-haiku-fallback';",
  'const DEFAULT_MAX_REQUESTS = 1;',
  'const versionMatch = versionOutput.match(/(?:^|[^0-9A-Za-z._-])v?(\\d+\\.\\d+\\.\\d+)(?:[^0-9A-Za-z._-]|$)/);',
];

const targetMarkers = [
  'const IMAGE_EXTENSIONS = new Set([',
  'imageGeneration = false',
  "args.push('--enable', 'image_generation')",
  'const imageGenerationStartedAt = Date.now();',
  'if (!result && !imageOutputPath)',
  'request.imageOutputPath',
  'imageGeneration: job.parsed.imageGeneration === true',
];
const targetHasPartialPatch = targetMarkers.some((marker) => target.text.includes(marker));
const targetHasCompletePatch = targetMarkers.every((marker) => target.text.includes(marker));
if (targetHasCompletePatch) {
  for (const marker of legacyContractMarkers) {
    if (!target.text.includes(marker)) {
      fail(`already-patched corpus broker lost its adapted contract: ${marker}`);
      process.exit(1);
    }
  }
  console.log('corpus image broker already contains the attested image lane');
  process.exit(0);
}
if (targetHasPartialPatch) {
  fail('corpus broker contains a partial image-lane patch; refusing to guess the missing hunk');
  process.exit(1);
}
for (const marker of legacyContractMarkers) {
  if (!target.text.includes(marker)) {
    fail(`unexpected corpus broker shape; missing adapted contract marker: ${marker}`);
    process.exit(1);
  }
}

let patched = target.text;
patched = replaceOnce(
  patched,
  "function sha256File(filePath) {\n  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');\n}\n",
  "function sha256File(filePath) {\n  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');\n}\n\nconst IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif']);\n\nfunction newestGeneratedImage(root, minimumMtimeMs = 0) {\n  if (!root || !fs.existsSync(root)) return '';\n  const files = [];\n  const visit = (directory) => {\n    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {\n      const filePath = path.join(directory, entry.name);\n      if (entry.isDirectory()) visit(filePath);\n      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {\n        const mtimeMs = fs.statSync(filePath).mtimeMs;\n        if (mtimeMs >= minimumMtimeMs) files.push({ filePath, mtimeMs });\n      }\n    }\n  };\n  visit(root);\n  files.sort((a, b) => b.mtimeMs - a.mtimeMs);\n  return files[0]?.filePath || '';\n}\n",
  'image discovery helper',
);
patched = replaceOnce(
  patched,
  "function runCodex({ authJson: credential, prompt, timeoutMs, schema, profile = 'agent', onSpawn = () => {}, job }) {",
  "function runCodex({ authJson: credential, prompt, timeoutMs, schema, profile = 'agent', imageGeneration = false, imagePath = '', imageOutputPath = '', onSpawn = () => {}, job }) {",
  'image-aware broker signature',
);
patched = replaceOnce(
  patched,
  "      ];\n      if (schema) {",
  "      ];\n      if (imageGeneration) args.push('--enable', 'image_generation');\n      if (imagePath) {\n        const workspaceRoot = fs.realpathSync(process.cwd());\n        const sourcePath = path.resolve(imagePath);\n        const relative = path.relative(workspaceRoot, sourcePath);\n        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {\n          throw new Error('imagePath must stay inside the job workspace');\n        }\n        const extension = path.extname(sourcePath).toLowerCase() || '.bin';\n        const inputPath = path.join(codexWorkspace, `input-image${extension}`);\n        fs.copyFileSync(sourcePath, inputPath);\n        args.push('--image', inputPath);\n      }\n      if (schema) {",
  'image input arguments',
);
patched = replaceOnce(
  patched,
  "      if (fs.realpathSync(codexCliPath) !== codexCliPath || sha256File(codexCliPath) !== codexCliSha256) {\n        throw new Error('Codex CLI changed after attestation');\n      }\n      child = spawn(codexCliPath, args, {",
  "      if (fs.realpathSync(codexCliPath) !== codexCliPath || sha256File(codexCliPath) !== codexCliSha256) {\n        throw new Error('Codex CLI changed after attestation');\n      }\n      const imageGenerationStartedAt = Date.now();\n      child = spawn(codexCliPath, args, {",
  'image generation start timestamp',
);
patched = replaceOnce(
  patched,
  "        try {\n          const result = fs.readFileSync(outputPath, 'utf8').trim();\n          if (!result) throw new Error('Codex CLI returned an empty last message');\n          resolve(result);",
  "        try {\n          const result = fs.readFileSync(outputPath, 'utf8').trim();\n          if (imageOutputPath) {\n            const workspaceRoot = fs.realpathSync(process.cwd());\n            const destination = path.resolve(imageOutputPath);\n            const relative = path.relative(workspaceRoot, destination);\n            if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {\n              throw new Error('imageOutputPath must stay inside the job workspace');\n            }\n            const generated = newestGeneratedImage(path.join(codexHome, 'generated_images'), imageGenerationStartedAt - 1000);\n            if (!generated) {\n              const reason = codexFailureReason(stderrTail);\n              throw new Error(`Codex completed without a generated image file${reason ? `: ${reason}` : ''}`);\n            }\n            fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });\n            fs.copyFileSync(generated, destination);\n          }\n          // Image-only Codex calls are successful even when the CLI does not\n          // write a textual last message. The generated file is the result;\n          // requiring outputPath first made the broker discard valid images.\n          if (!result && !imageOutputPath) throw new Error('Codex CLI returned an empty last message');\n          resolve(result);",
  'image-only result handling',
);
patched = replaceOnce(
  patched,
  "  if (request.profile !== null && request.profile !== undefined && !REQUEST_PROFILES.has(request.profile)) {\n    return 'invalid profile';\n  }\n  return '';",
  "  if (request.profile !== null && request.profile !== undefined && !REQUEST_PROFILES.has(request.profile)) {\n    return 'invalid profile';\n  }\n  if (request.imageGeneration !== undefined && typeof request.imageGeneration !== 'boolean') return 'invalid imageGeneration flag';\n  if (request.imagePath !== undefined && (typeof request.imagePath !== 'string' || request.imagePath.length > 4096)) return 'invalid imagePath';\n  if (request.imageOutputPath !== undefined && (typeof request.imageOutputPath !== 'string' || request.imageOutputPath.length > 4096)) return 'invalid imageOutputPath';\n  return '';",
  'image request validation',
);
patched = replaceOnce(
  patched,
  "    profile: job.parsed.profile === 'function' ? 'function' : 'agent',\n    onSpawn,",
  "    profile: job.parsed.profile === 'function' ? 'function' : 'agent',\n    imageGeneration: job.parsed.imageGeneration === true,\n    imagePath: job.parsed.imagePath || '',\n    imageOutputPath: job.parsed.imageOutputPath || '',\n    onSpawn,",
  'image request forwarding',
);

for (const marker of targetMarkers) {
  if (!patched.includes(marker)) {
    fail(`patch did not produce the required image-lane marker: ${marker}`);
    process.exit(1);
  }
}
for (const marker of legacyContractMarkers) {
  if (!patched.includes(marker)) {
    fail(`patch would erase the adapted corpus contract: ${marker}`);
    process.exit(1);
  }
}

fs.writeFileSync(target.absolute, patched, 'utf8');
console.log('patched corpus broker image lane while preserving its adapted contract');
