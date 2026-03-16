import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.firebase']);
const SCAN_EXTENSIONS = new Set(['.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.yml', '.yaml', '.html', '.md']);

const EXACT_FILES = [
  'data/jobs-crawler-summaries.json',
  'data/jobs.json',
  'data/jobs-source-match-audit.json',
  'data/jobs-stats-history.json',
  'public/data/jobs.json',
  'public/jobs.json',
];

const ADAPTERS_DIR = path.join(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const SCAN_DIRS = [
  'data',
  'scripts',
  'services',
  'components',
  'build-plugins',
  '.github/workflows',
];

const SUSPICIOUS_PATTERNS = [
  {
    name: 'opaque connector URL',
    regex: /https?:\/\/[^\s"'<>]*connector\.aspx\?[^\s"'<>]*(?:DM=[^&\s"'<>]{12,}|DM=[^&\s"'<>]*%(?:2F|2B|3D)[^&\s"'<>]*)/gi,
  },
  {
    name: 'secret-like query parameter',
    regex: /https?:\/\/[^\s"'<>]*[?&](?:token|api[_-]?key|secret|signature|sig|auth|access_token|client_secret)=(?!\$\{)[^&\s"'<>]{8,}/gi,
  },
  {
    name: 'Spindox ATS URL',
    regex: /https?:\/\/(?:makeamark\.spindox\.it|joblink\.allibo\.com\/ats4\/[^"'<> \n\r\t]*)/gi,
  },
];

function getFiles() {
  const files = new Set(
    EXACT_FILES
      .map((relativePath) => path.join(ROOT, relativePath))
      .filter((absolutePath) => fs.existsSync(absolutePath))
  );

  if (fs.existsSync(ADAPTERS_DIR)) {
    for (const entry of fs.readdirSync(ADAPTERS_DIR)) {
      if (entry.endsWith('.json')) files.add(path.join(ADAPTERS_DIR, entry));
    }
  }

  for (const relativeDir of SCAN_DIRS) {
    walk(path.join(ROOT, relativeDir), files);
  }

  return [...files];
}

function walk(targetPath, files) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);

  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.has(path.extname(targetPath))) files.add(targetPath);
    return;
  }

  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(targetPath, entry.name), files);
      continue;
    }

    if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.add(path.join(targetPath, entry.name));
    }
  }
}

function findMatches(filePath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);

  for (const { name, regex } of SUSPICIOUS_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const index = match.index;
      const line = content.slice(0, index).split(/\r?\n/).length;
      findings.push({
        type: name,
        line,
        excerpt: lines[line - 1]?.trim() || match[0],
        filePath,
      });
    }
  }

  return findings;
}

const findings = [];

for (const filePath of getFiles()) {
  const content = fs.readFileSync(filePath, 'utf8');
  findings.push(...findMatches(filePath, content));
}

if (findings.length > 0) {
  console.error('❌ Third-party secret/access URL validation failed:');
  for (const finding of findings.slice(0, 50)) {
    console.error(`- ${path.relative(ROOT, finding.filePath)}:${finding.line} [${finding.type}] ${finding.excerpt}`);
  }
  if (findings.length > 50) {
    console.error(`…and ${findings.length - 50} more findings`);
  }
  process.exit(1);
}

console.log('✅ No suspicious third-party secret/access URLs found in tracked data files.');
