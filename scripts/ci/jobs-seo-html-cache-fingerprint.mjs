#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeJobsSeoEmitterFingerprints,
  computeJobsSeoHtmlCacheFingerprint,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fingerprints = computeJobsSeoEmitterFingerprints(repoRoot);
const digest = computeJobsSeoHtmlCacheFingerprint(fingerprints);

process.stdout.write(`fingerprint=${digest}\n`);
