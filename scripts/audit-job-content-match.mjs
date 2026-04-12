#!/usr/bin/env node
/**
 * Job Content Match Audit
 *
 * For each company, picks 1 job from our data, fetches the apply URL (destination),
 * extracts text, and compares with our description to check for content fidelity.
 *
 * Reports:
 *  - MATCH: our description contains key terms from the source
 *  - MISMATCH: our description doesn't match the source content
 *  - UNREACHABLE: apply URL returned error or timeout
 *  - NO_CONTENT: source page had no extractable content
 */
import fs from 'node:fs';
import path from 'node:path';

const SLICES_DIR = 'data/jobs/by-crawler';
const TIMEOUT_MS = 12_000;
const CONCURRENCY = 8;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract meaningful words (>=4 chars, lowercase, no numbers-only) */
function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z]+/)
      .filter(w => w.length >= 4 && !/^\d+$/.test(w))
  )];
}

/** Jaccard similarity between two keyword sets */
function jaccardSimilarity(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Extract text from JSON-LD JobPosting if present */
function extractJsonLd(html) {
  const parts = [];
  const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'JobPosting') {
          if (item.title) parts.push(item.title);
          if (item.description) parts.push(stripHtml(item.description));
        }
      }
    } catch { /* ignore */ }
  }
  return parts.join(' ');
}

/** Extract main content from HTML */
function extractMainContent(html) {
  // Try JSON-LD first
  const ld = extractJsonLd(html);
  if (ld.split(/\s+/).length > 20) return ld;

  // Try main/article/content areas
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*(?:id|class)="[^"]*(?:job|vacancy|position|content|detail)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) {
    const text = stripHtml(mainMatch[1]);
    if (text.split(/\s+/).length > 20) return text;
  }

  // Fallback: full body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? stripHtml(bodyMatch[1]) : stripHtml(html);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8,de;q=0.7',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Load samples ─────────────────────────────────────────────────────────────

const files = fs.readdirSync(SLICES_DIR).filter(f => f.endsWith('.json')).sort();
const samples = [];

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(SLICES_DIR, f), 'utf8'));
  const jobs = (raw.jobs || []).filter(j => !j.needsRetranslation);
  if (jobs.length === 0) continue;

  // Pick the job with the longest description (best sample)
  const j = jobs.reduce((best, cur) => {
    const bestLen = (best.descriptionByLocale?.it || best.description || '').length;
    const curLen = (cur.descriptionByLocale?.it || cur.description || '').length;
    return curLen > bestLen ? cur : best;
  }, jobs[0]);

  const applyUrl = j.applyUrl || j.url || '';
  if (!applyUrl || !applyUrl.startsWith('http')) continue;

  samples.push({
    crawler: f.replace('.json', ''),
    company: j.company,
    title: j.title,
    slug: j.slugByLocale?.it || j.slug,
    applyUrl,
    ourDesc: j.descriptionByLocale?.it || j.description || '',
  });
}

console.log(`\n${'='.repeat(90)}`);
console.log(`JOB CONTENT MATCH AUDIT — ${samples.length} companies`);
console.log(`${'='.repeat(90)}\n`);

// ── Run audit ────────────────────────────────────────────────────────────────

const results = { match: [], mismatch: [], unreachable: [], noContent: [], redirect404: [] };
let done = 0;

async function auditJob(sample) {
  const { crawler, company, title, applyUrl, ourDesc } = sample;
  const ourKeywords = extractKeywords(ourDesc);

  try {
    const res = await fetchWithTimeout(applyUrl);
    const finalUrl = res.url;
    const status = res.status;

    if (status >= 400) {
      results.redirect404.push({ crawler, company, title, applyUrl, status, finalUrl });
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('json')) {
      results.noContent.push({ crawler, company, title, applyUrl, reason: `non-HTML: ${contentType.substring(0, 50)}` });
      return;
    }

    const html = await res.text();
    const sourceText = extractMainContent(html);
    const sourceKeywords = extractKeywords(sourceText);

    if (sourceKeywords.length < 5) {
      // Check if it's a JS-rendered page (likely SPA that needs browser)
      const isJsRendered = html.includes('__NEXT_DATA__') || html.includes('react-root')
        || html.includes('ng-app') || html.includes('nuxt') || /<div id="(root|app)"[^>]*>\s*<\/div>/i.test(html);
      results.noContent.push({
        crawler, company, title, applyUrl,
        reason: isJsRendered ? 'JS-rendered SPA (needs browser)' : `only ${sourceKeywords.length} keywords extracted`,
        finalUrl: finalUrl !== applyUrl ? finalUrl : undefined,
      });
      return;
    }

    const similarity = jaccardSimilarity(ourKeywords, sourceKeywords);

    // Also check if job title words appear in source
    const titleWords = title.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4);
    const titleInSource = titleWords.length > 0
      ? titleWords.filter(w => sourceText.toLowerCase().includes(w)).length / titleWords.length
      : 0;

    const entry = {
      crawler, company, title, applyUrl,
      similarity: Math.round(similarity * 100),
      titleMatch: Math.round(titleInSource * 100),
      ourWords: ourKeywords.length,
      sourceWords: sourceKeywords.length,
      finalUrl: finalUrl !== applyUrl ? finalUrl : undefined,
    };

    // Content matches if either similarity is decent OR title matches well
    if (similarity >= 0.08 || titleInSource >= 0.5) {
      results.match.push(entry);
    } else {
      entry.ourPreview = ourDesc.substring(0, 150);
      entry.sourcePreview = sourceText.substring(0, 150);
      results.mismatch.push(entry);
    }
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message?.substring(0, 80);
    results.unreachable.push({ crawler, company, title, applyUrl, reason });
  }

  done++;
  if (done % 20 === 0) process.stderr.write(`  ... ${done}/${samples.length}\n`);
}

// Process in batches for concurrency
for (let i = 0; i < samples.length; i += CONCURRENCY) {
  const batch = samples.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(auditJob));
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n✅ CONTENT MATCH: ${results.match.length} companies\n`);
// Show lowest-similarity matches as potential concerns
const lowMatch = results.match.filter(r => r.similarity < 15).sort((a, b) => a.similarity - b.similarity);
if (lowMatch.length > 0) {
  console.log('  ⚠️  Low similarity matches (may need review):');
  for (const r of lowMatch.slice(0, 20)) {
    console.log(`    ${r.crawler} (${r.similarity}% sim, ${r.titleMatch}% title) — ${r.title.substring(0, 60)}`);
  }
  console.log();
}

if (results.mismatch.length > 0) {
  console.log(`\n❌ CONTENT MISMATCH: ${results.mismatch.length} companies\n`);
  for (const r of results.mismatch) {
    console.log(`  ${r.crawler} — "${r.title.substring(0, 50)}" (${r.similarity}% sim, ${r.titleMatch}% title)`);
    console.log(`    Apply URL: ${r.applyUrl.substring(0, 100)}`);
    if (r.finalUrl) console.log(`    Redirected: ${r.finalUrl.substring(0, 100)}`);
    console.log(`    Our desc:    ${r.ourPreview}`);
    console.log(`    Source desc:  ${r.sourcePreview}`);
    console.log();
  }
}

if (results.redirect404.length > 0) {
  console.log(`\n🔴 DEAD LINKS (HTTP 4xx/5xx): ${results.redirect404.length} companies\n`);
  for (const r of results.redirect404) {
    console.log(`  ${r.crawler} — HTTP ${r.status} — ${r.applyUrl.substring(0, 100)}`);
    if (r.finalUrl && r.finalUrl !== r.applyUrl) console.log(`    Redirected to: ${r.finalUrl.substring(0, 100)}`);
  }
}

if (results.unreachable.length > 0) {
  console.log(`\n🟡 UNREACHABLE: ${results.unreachable.length} companies\n`);
  for (const r of results.unreachable) {
    console.log(`  ${r.crawler} — ${r.reason} — ${r.applyUrl.substring(0, 100)}`);
  }
}

if (results.noContent.length > 0) {
  console.log(`\n🟠 NO EXTRACTABLE CONTENT: ${results.noContent.length} companies\n`);
  for (const r of results.noContent) {
    console.log(`  ${r.crawler} — ${r.reason} — ${r.applyUrl.substring(0, 80)}`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(90)}`);
console.log(`SUMMARY`);
console.log(`${'='.repeat(90)}`);
console.log(`  ✅ Content match:    ${results.match.length}`);
console.log(`  ❌ Content mismatch: ${results.mismatch.length}`);
console.log(`  🔴 Dead links:       ${results.redirect404.length}`);
console.log(`  🟡 Unreachable:      ${results.unreachable.length}`);
console.log(`  🟠 No content:       ${results.noContent.length}`);
console.log(`  Total:               ${samples.length}`);
console.log();
