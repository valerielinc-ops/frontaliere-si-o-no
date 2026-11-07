#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeJobsSeoEmitterFingerprints } from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fingerprints = computeJobsSeoEmitterFingerprints(repoRoot);
const stable = JSON.stringify(Object.fromEntries(
  Object.entries(fingerprints).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
));
const digest = createHash('sha256').update(stable).digest('hex');

process.stdout.write(`fingerprint=${digest}\n`);
