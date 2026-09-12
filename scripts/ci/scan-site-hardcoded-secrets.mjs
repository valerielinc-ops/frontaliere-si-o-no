#!/usr/bin/env node
/**
 * Scan the site source tree for credential-shaped literals.
 *
 * Client configuration may be public, but a value that belongs in Remote
 * Config must not be committed or inlined into generated shells. This gate
 * scans the tracked source tree and never prints a match verbatim.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The sparse site checkout still contains thousands of tracked source files;
// this floor catches a collapsed or unexpectedly narrow enumeration.
export const MIN_SCANNED_FILES = 1000;

export const SCAN_EXCLUDE = [
  /^public\//,
  /^data\//,
  /^packages\/articles\/content\//,
  /^package-lock\.json$/,
  /\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|eot|pdf|zip|gz|mp4|webm)$/i,
];

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const SECRET_PATTERNS = [
  { id: 'google-api-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/g },
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,255}\b/g },
  { id: 'github-pat-fine-grained', label: 'GitHub fine-grained PAT', re: /\bgithub_pat_[0-9A-Za-z_]{60,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[0-9A-Za-z_-]{20,}/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-)?[0-9A-Za-z]{32,}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g },
  { id: 'aws-access-key-id', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'private-key-block', label: 'blocco di chiave privata', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

export function redact(value) {
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-3)} (${value.length} char)`;
}

export function scanText(text, file = '<text>') {
  const findings = [];
  for (const { id, label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      findings.push({
        file,
        line: text.slice(0, match.index).split('\n').length,
        patternId: id,
        label,
        redacted: redact(match[0]),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.patternId.localeCompare(b.patternId));
}

export function isScanned(relativePath) {
  return !SCAN_EXCLUDE.some((pattern) => pattern.test(relativePath));
}

export function scannedFiles(root = ROOT) {
  let output;
  try {
    output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`git ls-files non eseguibile in ${root}: ${error.code || error.message}`);
  }
  return output.split('\0').filter(Boolean).filter(isScanned);
}

export function scanRepo(root = ROOT) {
  const files = scannedFiles(root);
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(`scansione troppo stretta: ${files.length} file, minimo ${MIN_SCANNED_FILES}`);
  }

  const findings = [];
  let scanned = 0;
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue; // sparse checkout: tracked but intentionally not materialized
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    scanned += 1;
    findings.push(...scanText(fs.readFileSync(absolutePath, 'utf8'), relativePath));
  }
  return { findings, scanned };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { findings, scanned } = scanRepo();
    if (findings.length) {
      process.stderr.write(
        `[scan-site-hardcoded-secrets] ${findings.length} finding su ${scanned} file:\n`
        + findings.map((finding) => `  ${finding.file}:${finding.line} — ${finding.label} [${finding.redacted}]`).join('\n')
        + '\nSposta il valore in Firebase Remote Config e leggilo da process.env.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`[scan-site-hardcoded-secrets] ${scanned} file, nessuna credenziale in chiaro.\n`);
  } catch (error) {
    process.stderr.write(`[scan-site-hardcoded-secrets] scansione non valida: ${error.message}\n`);
    process.exit(2);
  }
}
