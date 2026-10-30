#!/usr/bin/env node
/** The sandboxed child claims its private job directory before loading candidate code. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.ASSISTED_APPLICATION_JOB_ROOT;
if (!root || !fs.statSync(root).isDirectory()) throw new Error('execution_job_root_missing');
const started = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim();
fs.writeFileSync(path.join(root, 'process.json'), JSON.stringify({ state: 'running', pid: process.pid, started }), { mode: 0o600 });
const { runAgentAndClose } = await import('./agent.mjs');
await runAgentAndClose();
