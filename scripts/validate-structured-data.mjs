#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'dist');
const SCRIPT_RE = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && full.endsWith('.html')) out.push(full);
  }
  return out;
}

function main() {
  const files = walk(ROOT);
  let total = 0;
  const errors = [];

  for (const file of files) {
    const html = readFileSync(file, 'utf-8');
    let m;
    while ((m = SCRIPT_RE.exec(html)) !== null) {
      total += 1;
      const raw = (m[1] || '').trim();
      try {
        JSON.parse(raw);
      } catch (err) {
        errors.push({
          file,
          message: err instanceof Error ? err.message : String(err),
          snippet: raw.slice(0, 220).replace(/\s+/g, ' '),
        });
      }
    }
  }

  if (errors.length > 0) {
    console.error(`❌ Structured data non analizzabile: ${errors.length} errori su ${total} blocchi JSON-LD`);
    for (const e of errors.slice(0, 50)) {
      console.error(`- ${e.file}`);
      console.error(`  ${e.message}`);
      console.error(`  ${e.snippet}`);
    }
    process.exit(1);
  }

  console.error(`✅ Structured data validi: ${total} blocchi JSON-LD su ${files.length} pagine HTML`);
}

main();
