/**
 * backfill-small-images.mjs — FRO-259, updated FRO-269
 *
 * Scans public/images/blog/ for hero images under 1200px wide and regenerates
 * them via the AI provider chain (Gemini → Pollinations → Together.ai →
 * Fal.ai → HuggingFace → Wikimedia → Pixabay → Pexels → Picsum),
 * then saves at 1200×675 with Sharp.
 *
 * Usage:
 *   node scripts/backfill-small-images.mjs
 *   node scripts/backfill-small-images.mjs --dry-run
 *   node scripts/backfill-small-images.mjs --limit 10
 *   node scripts/backfill-small-images.mjs --dry-run --limit 5
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, basename, extname, join } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// ── CLI flags ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const fileIdx = args.indexOf('--file');
const ONLY_FILE = fileIdx !== -1 ? args[fileIdx + 1] : null;

// ── Constants (match create-article.mjs) ──────────────────────────────────
const BLOG_IMAGE_TARGET_MAX_BYTES = 220 * 1024;
const BLOG_IMAGE_HARD_MAX_BYTES = 320 * 1024;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const IMAGE_MODEL_PRO = 'gemini-3-pro-image-preview';
const IMAGE_MODEL_FLASH = 'gemini-2.5-flash-image';
const MIN_WIDTH = 1200;

// ── Topic keyword → Wikimedia search query map (copied from create-article.mjs) ──
const TOPIC_SEARCH_MAP = [
  { keywords: ['benzina', 'carburante', 'petrolio', 'diesel', 'rifornimento'], queries: ['fuel station Switzerland', 'gas pump Europe'], category: 'transportation' },
  { keywords: ['tasse', 'fiscale', 'imposta', 'irpef', 'fisco', 'deduzioni'], queries: ['tax office building', 'financial documents desk'], category: 'business' },
  { keywords: ['salute', 'malattia', 'lamal', 'assicurazione', 'premio'], queries: ['hospital Switzerland modern', 'health insurance card'], category: 'health' },
  { keywords: ['lavoro', 'impiego', 'occupazione', 'assunzione', 'disoccup'], queries: ['modern office workplace', 'job interview meeting'], category: 'business' },
  { keywords: ['confine', 'dogana', 'frontiera', 'frontalier', 'permesso'], queries: ['Swiss Italian border crossing', 'customs checkpoint Europe'], category: 'places' },
  { keywords: ['treno', 'ferrovia', 'trasporto', 'pendolar', 'tilo'], queries: ['train station Switzerland', 'commuter train Alps'], category: 'transportation' },
  { keywords: ['casa', 'affitto', 'immobiliare', 'appartamento', 'mutuo'], queries: ['apartment building Switzerland', 'residential area Ticino'], category: 'buildings' },
  { keywords: ['banca', 'finanziario', 'cambio', 'valuta', 'franco', 'euro'], queries: ['Swiss bank building', 'currency exchange counter'], category: 'business' },
  { keywords: ['scuola', 'formazione', 'educazione', 'universit', 'corso'], queries: ['university campus Switzerland', 'classroom education'], category: 'education' },
  { keywords: ['pensione', 'avs', 'pilastro', 'previdenza', 'anzian'], queries: ['retirement couple walking', 'pension fund documents'], category: 'people' },
  { keywords: ['salario', 'stipendio', 'busta paga', 'reddito', 'retribuzion'], queries: ['salary paycheck document', 'business accounting office'], category: 'business' },
  { keywords: ['dumping', 'sindacat', 'contratto', 'ccl'], queries: ['labor union protest Switzerland', 'workers rights demonstration'], category: 'people' },
  { keywords: ['voto', 'elezioni', 'referendum', 'iniziativa', 'parlament'], queries: ['Swiss parliament Bern', 'voting ballot Switzerland'], category: 'buildings' },
  { keywords: ['clima', 'meteo', 'alluvione', 'tempesta', 'neve'], queries: ['weather Alps Switzerland', 'storm clouds mountains'], category: 'nature' },
  { keywords: ['polizia', 'sicurezza', 'reato', 'accident'], queries: ['police patrol Switzerland', 'road safety checkpoint'], category: 'transportation' },
  { keywords: ['ospedale', 'medico', 'farmacia', 'sanitar'], queries: ['medical center Switzerland', 'doctor consultation'], category: 'health' },
  { keywords: ['costruzione', 'cantiere', 'ediliz', 'ristrutturazione'], queries: ['construction site Switzerland', 'building renovation'], category: 'industry' },
  { keywords: ['supermercato', 'spesa', 'prezzi', 'costo vita'], queries: ['supermarket grocery store', 'shopping food prices'], category: 'business' },
  { keywords: ['auto', 'macchina', 'traffico', 'stradale', 'autostrada'], queries: ['highway traffic Switzerland', 'car road Alps'], category: 'transportation' },
  { keywords: ['economia', 'pil', 'crescita', 'mercato', 'commercial'], queries: ['business district Zurich', 'economic growth chart'], category: 'business' },
  { keywords: ['bambini', 'famiglia', 'asilo', 'nido', 'genitor'], queries: ['family park Switzerland', 'kindergarten playground'], category: 'people' },
  { keywords: ['golfo', 'guerra', 'conflitto', 'geopolitica', 'medio oriente'], queries: ['oil tanker shipping port', 'cargo ship Mediterranean'], category: 'industry' },
  { keywords: ['tecnologia', 'digitale', 'intelligenza artificiale', 'innovation'], queries: ['technology office workspace', 'digital innovation center'], category: 'computer' },
];

const GENERIC_QUERIES = [
  'Swiss Alps panorama mountain', 'Lake Lugano sunset boating',
  'Ticino village stone street', 'Bellinzona castle medieval',
  'Mendrisio vineyard autumn', 'Locarno piazza grande',
  'Swiss Italian architecture colorful', 'Gotthard pass scenic road',
];

// ── Load article titles from blog-meta-it.ts ──────────────────────────────
function loadArticleTitles() {
  const metaPath = resolve('services/locales/blog-meta-it.ts');
  try {
    const src = readFileSync(metaPath, 'utf8');
    const titleMap = {};
    // Parse 'blog.article.{id}.title': 'Title text',
    const re = /'blog\.article\.([^']+)\.title':\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      titleMap[m[1]] = m[2];
    }
    return titleMap;
  } catch (e) {
    console.error(`⚠️  Impossibile leggere blog-meta-it.ts: ${e.message}`);
    return {};
  }
}

// ── Load article categories from blog-articles-data.ts ────────────────────
function loadArticleCategories() {
  const dataPath = resolve('data/blog-articles-data.ts');
  try {
    const src = readFileSync(dataPath, 'utf8');
    const catMap = {};
    // Match id: '...', ... category: '...'
    const re = /id:\s*'([^']+)'[^}]*?category:\s*'([^']+)'/gs;
    let m;
    while ((m = re.exec(src)) !== null) {
      catMap[m[1]] = m[2];
    }
    return catMap;
  } catch (e) {
    console.error(`⚠️  Impossibile leggere blog-articles-data.ts: ${e.message}`);
    return {};
  }
}

// ── Build search queries for an article ───────────────────────────────────
function buildWikimediaQueries(articleId, title, category) {
  const lowerTitle = (title || '').toLowerCase();
  const lowerCat = (category || '').toLowerCase();
  const queries = [];

  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => lowerTitle.includes(k))) {
      queries.push(...entry.queries);
      if (queries.length >= 3) break;
    }
  }

  const cities = ['lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'ascona'];
  const cityMatch = cities.find(c => lowerTitle.includes(c));
  if (cityMatch) queries.push(`${cityMatch} Switzerland photo`);

  if (queries.length === 0) {
    const catMap = {
      novita: ['Switzerland news editorial photo', 'Ticino newspaper press'],
      fisco: ['tax office documents Swiss', 'financial calculation desk'],
      lavoro: ['modern office workspace Swiss', 'job interview professional'],
      salute: ['Swiss hospital medical center', 'health care pharmacy'],
      vita: ['daily life Switzerland Ticino', 'Swiss town square people'],
      economia: ['business district Swiss bank', 'economy finance Zurich'],
    };
    if (catMap[lowerCat]) queries.push(...catMap[lowerCat]);
  }

  // Stable generic fallback based on article ID hash
  if (queries.length < 2) {
    const hash = articleId.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    queries.push(GENERIC_QUERIES[Math.abs(hash) % GENERIC_QUERIES.length]);
  }

  return queries;
}

// ── Image relevance filter (mirror of create-article.mjs) ─────────────────
const IMAGE_TAG_DENYLIST = {
  food: ['food', 'pasta', 'spaghetti', 'pizza', 'cheese', 'meal', 'dish', 'cooking', 'kitchen', 'restaurant', 'cuisine', 'recipe', 'ingredient', 'plate', 'breakfast', 'lunch', 'dinner', 'dessert', 'cake', 'bread', 'fruit', 'vegetable', 'wine', 'drink', 'coffee', 'beverage'],
  people_closeup: ['wedding', 'bride', 'groom', 'kiss', 'romance', 'love', 'couple'],
  pets: ['dog', 'cat', 'puppy', 'kitten', 'pet'],
};
const FOOD_ARTICLE_KEYWORDS = ['cibo', 'cucina', 'ristorante', 'pasta', 'pizza', 'gastronomi', 'enologi', 'vino', 'birra', 'caffè', 'caffe', 'ricetta', 'pranzo', 'cena', 'colazione'];

function isImageRelevant(tagsString, title) {
  if (!tagsString) return true;
  const tags = tagsString.toLowerCase().split(/[,;|]/).map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return true;
  const lowerTitle = (title || '').toLowerCase();
  const isFoodArticle = FOOD_ARTICLE_KEYWORDS.some(k => lowerTitle.includes(k));
  for (const [topic, denied] of Object.entries(IMAGE_TAG_DENYLIST)) {
    if (topic === 'food' && isFoodArticle) continue;
    if (tags.some(t => denied.includes(t))) return false;
  }
  return true;
}

function inferPixabayCategory(title) {
  const lowerTitle = (title || '').toLowerCase();
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => lowerTitle.includes(k))) return entry.category || null;
  }
  return null;
}

// ── Build image generation prompt ─────────────────────────────────────────
/**
 * Derive a concrete English "Subject:" clause from the title so the image
 * generator focuses on the article topic (e.g. highway, hospital) instead of
 * defaulting to people-in-a-street stock when "frontalieri" is in the title.
 */
function buildTopicSubjectClause(title) {
  const lowerTitle = (title || '').toLowerCase();
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => lowerTitle.includes(k))) {
      // Use the first topic query — it's an English noun phrase describing the subject
      return entry.queries[0] || null;
    }
  }
  return null;
}

function buildPrompt(title) {
  const subject = buildTopicSubjectClause(title);
  // Put subject FIRST so it dominates — trailing context (cross-border workers) biases
  // generators (Pollinations/flux) toward portraits regardless of title.
  const leading = subject
    ? `Professional editorial photograph of ${subject}. No people as main subject. `
    : '';
  const base = title
    ? `${leading}Editorial photo illustrating: "${title}". Setting: Ticino, Switzerland. Natural lighting, photorealistic.`
    : `Professional editorial photo for a news article about Ticino, Switzerland. Lake Lugano, warm lighting.`;
  return base
    + '\n\nIMPORTANT: Generate ONLY the image, do NOT include any text, watermarks, labels, or captions on the image.'
    + '\n\nSTYLE: Photorealistic editorial photograph indistinguishable from a real DSLR/mirrorless camera shot. Include natural lens characteristics: shallow depth of field, subtle chromatic aberration, realistic bokeh on out-of-focus areas, natural film grain, slight vignetting. Lighting must be natural and ambient — avoid flat, evenly-lit AI look. Absolutely NO AI artifacts, NO unnaturally smooth textures, NO perfect symmetry, NO CGI plastic look.';
}

// ── Sharp-based image optimizer (matches create-article.mjs) ─────────────
async function optimizeImageToWebp(inputPath, outputPath) {
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default || sharpModule;

  const encodeWithQuality = async (quality) =>
    sharp(inputPath)
      .rotate()
      .resize({ width: 1200, height: 675, fit: 'cover', position: 'attention' })
      .webp({ quality, effort: 4 })
      .toBuffer();

  const before = statSync(inputPath).size;
  let outBuffer = await encodeWithQuality(75);
  for (const q of [70, 65, 60, 55]) {
    if (outBuffer.length <= BLOG_IMAGE_TARGET_MAX_BYTES) break;
    outBuffer = await encodeWithQuality(q);
  }

  writeFileSync(outputPath, outBuffer);
  return { ok: true, before, after: outBuffer.length };
}

// ── Save raw buffer → temp file → optimize → final path ──────────────────
async function saveAndOptimize(rawBuffer, providerLabel, contentType, articleId, imgPath) {
  if (rawBuffer.length < 5000) {
    console.error(`  ⚠️  Immagine troppo piccola (${rawBuffer.length} bytes) da ${providerLabel}`);
    return false;
  }
  const sourceExt = (contentType || '').includes('png') ? 'png' : (contentType || '').includes('webp') ? 'webp' : 'jpg';
  const tempPath = resolve(`public/images/blog/${articleId}.source.${sourceExt}`);
  writeFileSync(tempPath, rawBuffer);
  const rawKB = (rawBuffer.length / 1024).toFixed(0);
  let result;
  try {
    result = await optimizeImageToWebp(tempPath, imgPath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }

  if (result?.ok) {
    const finalKb = (result.after / 1024).toFixed(0);
    const beforeKb = (result.before / 1024).toFixed(0);
    const overTarget = result.after > BLOG_IMAGE_HARD_MAX_BYTES ? ' ⚠️ sopra hard cap' : '';
    console.error(`  ✅ Ottimizzata: ${beforeKb} KB → ${finalKb} KB (${providerLabel})${overTarget}`);
    return true;
  }

  if (rawBuffer.length > BLOG_IMAGE_HARD_MAX_BYTES) {
    console.error(`  ⚠️  Raw troppo pesante (${rawKB} KB), provider successivo...`);
    return false;
  }
  writeFileSync(imgPath, rawBuffer);
  console.error(`  ✅ Raw fallback: ${rawKB} KB (${providerLabel})`);
  return true;
}

// ── Wikimedia URL dedup tracking ──────────────────────────────────────────
function loadUsedImageUrls() {
  const trackingFile = join(process.cwd(), 'data', 'blog-images-used.json');
  try {
    const entries = JSON.parse(readFileSync(trackingFile, 'utf8'));
    return new Set(Object.values(entries));
  } catch {
    return new Set();
  }
}

function saveUsedImageUrl(articleId, imageUrl) {
  const trackingFile = join(process.cwd(), 'data', 'blog-images-used.json');
  let entries = {};
  try { entries = JSON.parse(readFileSync(trackingFile, 'utf8')); } catch { /* first use */ }
  entries[articleId] = imageUrl;
  writeFileSync(trackingFile, JSON.stringify(entries, null, 2) + '\n');
}

// ── Provider chain (adapted from create-article.mjs) ─────────────────────
async function regenerateImage(articleId, title, category, imgPath) {
  const prompt = buildPrompt(title);

  // Strategy 1: Gemini
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const modelsToTry = [IMAGE_MODEL_FLASH, IMAGE_MODEL_PRO];
    let geminiQuotaExhausted = false;
    for (const model of modelsToTry) {
      if (geminiQuotaExhausted) break;
      try {
        const isPro = model === IMAGE_MODEL_PRO;
        console.error(`🎨 Gemini ${isPro ? 'Pro' : 'Flash'} Image...`);
        const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
        const generationConfig = isPro
          ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
          : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } };
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
          if (res.status === 429) { geminiQuotaExhausted = true; throw new Error('quota Gemini esaurita (429)'); }
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        const parts = json.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.data && !p.thought);
        if (!imagePart) throw new Error('Nessuna immagine nella risposta Gemini');
        const rawBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
        const mimeType = imagePart.inlineData.mimeType || 'image/jpeg';
        if (await saveAndOptimize(rawBuffer, `Gemini/${model}`, mimeType, articleId, imgPath)) return true;
      } catch (e) {
        console.error(`  ⚠️  Gemini fallito: ${e.message}`);
      }
    }
  }

  // Strategy 2: Pollinations.ai
  const pollinationsModels = ['flux', 'turbo'];
  let pollinationsOriginDown = false;
  for (const pModel of pollinationsModels) {
    if (pollinationsOriginDown) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          console.error(`  🔄 Retry Pollinations/${pModel} dopo 10s...`);
          await new Promise(r => setTimeout(r, 10000));
        }
        console.error(`🎨 Pollinations.ai (${pModel})...`);
        const encodedPrompt = encodeURIComponent(prompt.replace(/\n/g, ' ').slice(0, 800));
        const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1280&height=720&model=${pModel}&nologo=true&seed=${Date.now()}`;
        const res = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
        if (!res.ok) {
          if ((res.status === 530 || res.status === 502 || res.status === 503) && attempt < 1) throw new Error(`HTTP ${res.status} (retry)`);
          if (res.status === 530 || res.status === 502 || res.status === 503) pollinationsOriginDown = true;
          throw new Error(`HTTP ${res.status}`);
        }
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) throw new Error(`Risposta non è un'immagine: ${contentType}`);
        const rawBuffer = Buffer.from(await res.arrayBuffer());
        if (await saveAndOptimize(rawBuffer, `Pollinations/${pModel}`, contentType, articleId, imgPath)) return true;
        break;
      } catch (e) {
        console.error(`  ⚠️  Pollinations/${pModel} fallito: ${e.message}`);
        if (e.message.includes('(retry)')) continue;
        break;
      }
    }
  }
  if (pollinationsOriginDown) console.error('  ⚠️  Pollinations.ai non raggiungibile — origin down');

  // Strategy 2b: Together.ai (FLUX.1-schnell-Free, FRO-269)
  const togetherKey = process.env.TOGETHER_API_KEY;
  if (togetherKey) {
    try {
      console.error('🎨 Together.ai (FLUX.1-schnell-Free)...');
      const togetherRes = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${togetherKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'black-forest-labs/FLUX.1-schnell-Free',
          prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
          width: 1280, height: 720, steps: 4, n: 1, response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!togetherRes.ok) { const t = await togetherRes.text().catch(() => ''); throw new Error(`HTTP ${togetherRes.status}: ${t.slice(0, 200)}`); }
      const togetherJson = await togetherRes.json();
      const b64 = togetherJson.data?.[0]?.b64_json;
      if (!b64) throw new Error('Nessuna immagine nella risposta Together.ai');
      const rawBuffer = Buffer.from(b64, 'base64');
      if (await saveAndOptimize(rawBuffer, 'Together.ai/FLUX-schnell', 'image/jpeg', articleId, imgPath)) return true;
    } catch (e) {
      console.error(`  ⚠️  Together.ai fallito: ${e.message}`);
    }
  }

  // Strategy 2c: Fal.ai (FLUX schnell, FRO-269)
  const falKey = process.env.FAL_KEY;
  if (falKey) {
    try {
      console.error('🎨 Fal.ai (FLUX schnell)...');
      const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
        method: 'POST',
        headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.replace(/\n/g, ' ').slice(0, 800), image_size: 'landscape_16_9', num_inference_steps: 4, num_images: 1 }),
        signal: AbortSignal.timeout(90000),
      });
      if (!falRes.ok) { const t = await falRes.text().catch(() => ''); throw new Error(`HTTP ${falRes.status}: ${t.slice(0, 200)}`); }
      const falJson = await falRes.json();
      const falImgUrl = falJson.images?.[0]?.url;
      if (!falImgUrl) throw new Error('Nessuna immagine nella risposta Fal.ai');
      const falImgRes = await fetch(falImgUrl, { signal: AbortSignal.timeout(30000) });
      if (!falImgRes.ok) throw new Error(`Download HTTP ${falImgRes.status}`);
      const falBuf = Buffer.from(await falImgRes.arrayBuffer());
      if (await saveAndOptimize(falBuf, 'Fal.ai/FLUX-schnell', falImgRes.headers.get('content-type') || 'image/jpeg', articleId, imgPath)) return true;
    } catch (e) {
      console.error(`  ⚠️  Fal.ai fallito: ${e.message}`);
    }
  }

  // Strategy 3: HuggingFace
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (hfToken) {
    const hfModels = ['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0'];
    for (const hfModel of hfModels) {
      try {
        const shortName = hfModel.split('/').pop();
        console.error(`🎨 HuggingFace/${shortName}...`);
        const hfRes = await fetch(`https://router.huggingface.co/hf-inference/v2/models/${hfModel}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: prompt.replace(/\n/g, ' ').slice(0, 800), parameters: { width: 1280, height: 720 } }),
          signal: AbortSignal.timeout(120000),
        });
        if (!hfRes.ok) { const t = await hfRes.text().catch(() => ''); throw new Error(`HTTP ${hfRes.status}: ${t.slice(0, 200)}`); }
        const contentType = hfRes.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) throw new Error(`Risposta non è un'immagine: ${contentType}`);
        const rawBuffer = Buffer.from(await hfRes.arrayBuffer());
        if (await saveAndOptimize(rawBuffer, `HuggingFace/${shortName}`, contentType, articleId, imgPath)) return true;
      } catch (e) {
        console.error(`  ⚠️  HuggingFace/${hfModel.split('/').pop()} fallito: ${e.message}`);
      }
    }
  }

  // Strategy 4: Wikimedia Commons
  {
    const searchQueries = buildWikimediaQueries(articleId, title, category);
    const usedUrls = loadUsedImageUrls();
    for (const query of searchQueries) {
      try {
        console.error(`🖼️  Wikimedia ("${query}")...`);
        const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
          `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12` +
          `&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280&format=json`;
        const res = await fetch(wikiUrl, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'FrontaliereBot/1.0 (https://frontaliereticino.ch; blog image)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pages = json.query?.pages || {};
        const candidates = Object.values(pages)
          .filter(p => {
            const info = p.imageinfo?.[0];
            if (!info?.thumburl) return false;
            const mime = (info.mime || '').toLowerCase();
            if (!mime.startsWith('image/jpeg') && !mime.startsWith('image/png')) return false;
            if (usedUrls.has(info.thumburl) || usedUrls.has(info.url)) return false;
            return true;
          })
          .sort((a, b) => {
            const aInfo = a.imageinfo[0], bInfo = b.imageinfo[0];
            const aRatio = (aInfo.width || 1) / (aInfo.height || 1);
            const bRatio = (bInfo.width || 1) / (bInfo.height || 1);
            const aScore = (aRatio > 1.3 ? 10 : 0) + Math.min(aInfo.width || 0, 2000) / 200;
            const bScore = (bRatio > 1.3 ? 10 : 0) + Math.min(bInfo.width || 0, 2000) / 200;
            return bScore - aScore;
          });
        if (candidates.length === 0) { console.error(`  ⚠️  Wikimedia "${query}": nessun risultato`); continue; }
        const pick = candidates[Math.floor(Math.random() * Math.min(5, candidates.length))];
        const imgUrl = pick.imageinfo[0].thumburl;
        console.error(`  📥 ${imgUrl.slice(0, 80)}...`);
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'FrontaliereBot/1.0' } });
        if (!imgRes.ok) throw new Error(`Download HTTP ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (await saveAndOptimize(buf, `Wikimedia/${query}`, imgRes.headers.get('content-type'), articleId, imgPath)) {
          saveUsedImageUrl(articleId, imgUrl);
          return true;
        }
      } catch (e) {
        console.error(`  ⚠️  Wikimedia "${query}" fallito: ${e.message}`);
      }
    }
  }

  // Strategy 5: Pixabay
  const pixabayKey = process.env.PIXABAY_API_KEY;
  if (pixabayKey) {
    const pxQueries = buildWikimediaQueries(articleId, title, category).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pxQueries.length === 0) pxQueries.push('ticino switzerland');
    pxQueries.push('swiss landscape lake');
    const pxCategory = inferPixabayCategory(title);
    const pxCatParam = pxCategory ? `&category=${encodeURIComponent(pxCategory)}` : '';
    for (const pxQuery of pxQueries) {
      try {
        console.error(`🖼️  Pixabay ("${pxQuery}"${pxCategory ? `, cat=${pxCategory}` : ''})...`);
        const res = await fetch(
          `https://pixabay.com/api/?key=${pixabayKey}&q=${encodeURIComponent(pxQuery)}${pxCatParam}&image_type=photo&orientation=horizontal&per_page=20&min_width=1280&safesearch=true`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const hits = json.hits || [];
        if (hits.length === 0) { console.error(`  ⚠️  Pixabay "${pxQuery}": nessun risultato`); continue; }
        const relevant = hits.filter(h => isImageRelevant(h.tags, title));
        if (relevant.length === 0) { console.error(`  ⚠️  Pixabay "${pxQuery}": filtro rilevanza ha respinto tutti i risultati`); continue; }
        const pick = relevant[Math.floor(Math.random() * Math.min(5, relevant.length))];
        const imgUrl = pick.largeImageURL || pick.webformatURL;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (await saveAndOptimize(buf, `Pixabay/${pxQuery}`, imgRes.headers.get('content-type'), articleId, imgPath)) return true;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pixabay "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // Strategy 5b: Pexels (FRO-269)
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    const pxQueriesPexels = buildWikimediaQueries(articleId, title, category).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pxQueriesPexels.length === 0) pxQueriesPexels.push('ticino switzerland');
    pxQueriesPexels.push('swiss landscape lake');
    for (const pxQuery of pxQueriesPexels) {
      try {
        console.error(`🖼️  Pexels ("${pxQuery}")...`);
        const res = await fetch(
          `https://api.pexels.com/v1/search?query=${encodeURIComponent(pxQuery)}&orientation=landscape&size=large&per_page=20`,
          { headers: { Authorization: pexelsKey }, signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const photos = json.photos || [];
        if (photos.length === 0) { console.error(`  ⚠️  Pexels "${pxQuery}": nessun risultato`); continue; }
        const relevant = photos.filter(p => isImageRelevant((p.alt || '').replace(/\s+/g, ','), title));
        if (relevant.length === 0) { console.error(`  ⚠️  Pexels "${pxQuery}": filtro rilevanza ha respinto tutti i risultati`); continue; }
        const pick = relevant[Math.floor(Math.random() * Math.min(5, relevant.length))];
        const imgUrl = pick.src?.large2x || pick.src?.large || pick.src?.original;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (await saveAndOptimize(buf, `Pexels/${pxQuery}`, imgRes.headers.get('content-type'), articleId, imgPath)) return true;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pexels "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // Strategy 6: Lorem Picsum (deterministic seed per article)
  try {
    console.error('🖼️  Lorem Picsum (random)...');
    const seed = articleId.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const absSeed = Math.abs(seed) % 10000;
    const res = await fetch(`https://picsum.photos/seed/${absSeed}/1280/720`, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (await saveAndOptimize(buf, 'Picsum', contentType, articleId, imgPath)) return true;
      }
    }
  } catch (e) {
    console.error(`  ⚠️  Lorem Picsum fallito: ${e.message}`);
  }

  console.error('  ❌ Tutti i provider hanno fallito.');
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const imgDir = resolve('public/images/blog');
  if (!existsSync(imgDir)) {
    console.error(`❌ Directory non trovata: ${imgDir}`);
    process.exit(1);
  }

  const titleMap = loadArticleTitles();
  const catMap = loadArticleCategories();

  // Load sharp once to check dimensions
  const sharpModule = await import('sharp');
  const sharp = sharpModule.default || sharpModule;

  // Scan all hero files (WebP-only after migration; accept .jpg too for legacy
  // images still on disk during transition).
  const allHeroes = readdirSync(imgDir).filter(
    (f) => /\.(webp|jpg)$/i.test(f) && !f.includes('.source.'),
  );
  console.error(`\n📂 Trovati ${allHeroes.length} file hero in public/images/blog/`);

  // Find undersized images (or force a single file via --file)
  const toProcess = [];
  for (const filename of allHeroes) {
    const stem = filename.replace(/\.(webp|jpg)$/i, '');
    if (ONLY_FILE && filename !== ONLY_FILE && stem !== ONLY_FILE) continue;
    const filepath = resolve(imgDir, filename);
    try {
      const meta = await sharp(filepath).metadata();
      const w = meta.width || 0;
      if (ONLY_FILE || w < MIN_WIDTH) {
        toProcess.push({ filename, filepath, articleId: stem, width: w });
      }
    } catch (e) {
      console.error(`  ⚠️  Impossibile leggere ${filename}: ${e.message}`);
    }
  }

  console.error(`🔍 Immagini sotto ${MIN_WIDTH}px: ${toProcess.length}`);

  if (DRY_RUN) {
    console.error('\n--- DRY RUN ---');
    for (const { filename, articleId, width } of toProcess) {
      const title = titleMap[articleId] || '(titolo sconosciuto)';
      console.error(`  [${width}px] ${filename} — "${title}"`);
    }
    console.error(`\nTotale da rigenerare: ${toProcess.length}`);
    return;
  }

  const batch = toProcess.slice(0, isFinite(LIMIT) ? LIMIT : undefined);
  if (batch.length === 0) {
    console.error('✅ Nessuna immagine da rigenerare.');
    return;
  }

  console.error(`\n🚀 Rigenerazione di ${batch.length} immagini...\n`);
  let success = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const { filename, filepath, articleId, width } = batch[i];
    const title = titleMap[articleId] || '';
    const category = catMap[articleId] || '';
    console.error(`\n[${i + 1}/${batch.length}] ${filename} (${width}px) — "${title || articleId}"`);

    const ok = await regenerateImage(articleId, title, category, filepath);
    if (ok) {
      success++;
      // Verify the new image
      try {
        const meta = await sharp(filepath).metadata();
        console.error(`  📐 Nuove dimensioni: ${meta.width}×${meta.height}px`);
      } catch { /* non-blocking */ }
    } else {
      failed++;
    }
  }

  console.error(`\n✅ Completato: ${success} rigenerati, ${failed} falliti su ${batch.length} totali.`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
