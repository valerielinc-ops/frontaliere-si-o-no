#!/usr/bin/env node
/**
 * manage-article.mjs — Remove or list blog articles with SEO-safe cleanup.
 *
 * Usage:
 *   node scripts/manage-article.mjs list                          # List all articles
 *   node scripts/manage-article.mjs remove <article-id>           # Remove article
 *   node scripts/manage-article.mjs remove <article-id> --redirect-to <other-id>  # Remove + redirect
 *   node scripts/manage-article.mjs remove <article-id> --force   # Skip confirmation
 *
 * What "remove" does:
 *   1. Removes article from BlogArticleId type union in router.ts
 *   2. Removes from ALL_BLOG_ARTICLE_IDS array in router.ts
 *   3. Removes slug entries from all 4 locale SlugTable objects in router.ts
 *   4. Removes from BLOG_ARTICLE_TO_SLUG mapping in router.ts
 *   5. Removes article entry from ARTICLES array in BlogArticles.tsx
 *   6. Removes all i18n keys (title, excerpt, body1-3, ctaTitle, ctaDescription, imageAlt) from i18n.ts
 *   7. Removes same keys from en.ts, de.ts, fr.ts
 *   8. Removes SEO_METADATA entry from seoService.ts
 *   9. Removes breadcrumb entry from seoService.ts
 *  10. Removes <url> block from sitemap-blog.xml
 *  11. Deletes generated image from public/images/blog/ (if exists)
 *  12. If --redirect-to specified, adds a redirect mapping for SEO
 *  13. Stages all changes with git add
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function resolve(rel) { return `${PROJECT_ROOT}/${rel}`; }
function read(rel) { return readFileSync(resolve(rel), 'utf-8'); }
function write(rel, content) { writeFileSync(resolve(rel), content, 'utf-8'); }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(r => rl.question(question, ans => { rl.close(); r(ans.trim()); }));
}

// ── List all articles ───────────────────────────────────────
function listArticles() {
  const blogSrc = read('components/community/BlogArticles.tsx');
  const i18nSrc = read('services/i18n.ts');

  // Extract articles from ARTICLES array
  const articleRegex = /\{\s*id:\s*'([^']+)',\s*category:\s*'([^']+)',\s*date:\s*'([^']+)',\s*image:\s*'([^']+)'/g;
  const articles = [];
  let m;
  while ((m = articleRegex.exec(blogSrc)) !== null) {
    const [, id, category, date, image] = m;
    // Get title from i18n
    const titleMatch = i18nSrc.match(new RegExp(`'blog\\.article\\.${escapeRegex(id)}\\.title':\s*'([^']+)'`));
    const title = titleMatch ? titleMatch[1] : '(title not found)';
    articles.push({ id, category, date, image, title });
  }

  if (articles.length === 0) {
    console.error('❌ Nessun articolo trovato.');
    return;
  }

  console.error(`\n📚 ${articles.length} articoli trovati:\n`);
  console.error('─'.repeat(100));
  console.error(` ${'#'.padEnd(3)} ${'ID'.padEnd(45)} ${'Categoria'.padEnd(12)} ${'Data'.padEnd(12)} Titolo`);
  console.error('─'.repeat(100));
  articles.forEach((a, i) => {
    console.error(` ${String(i + 1).padEnd(3)} ${a.id.padEnd(45)} ${a.category.padEnd(12)} ${a.date.padEnd(12)} ${a.title.slice(0, 55)}`);
  });
  console.error('─'.repeat(100));
}

// ── Remove article from router.ts + routerBlogData.ts ───────
function removeFromRouter(articleId) {
  const escaped = escapeRegex(articleId);

  // 1. Remove from BlogArticleId type union in router.ts: | 'article-id'
  let routerSrc = read('services/router.ts');
  routerSrc = routerSrc.replace(new RegExp(`\\s*\\|\\s*'${escaped}'`, 'g'), '');
  write('services/router.ts', routerSrc);

  // 2-5. Remove from routerBlogData.ts (ALL_BLOG_ARTICLE_IDS, BLOG_SLUGS)
  let blogSrc = read('services/routerBlogData.ts');

  // 2. Remove from ALL_BLOG_ARTICLE_IDS array: 'article-id',
  blogSrc = blogSrc.replace(new RegExp(`\\s*'${escaped}',?\\n?`, 'g'), (match) => {
    return '';
  });
  blogSrc = blogSrc.replace(/,(\s*\])/g, '$1');

  // 3. Remove slug interface entry: articleId: string;
  const slugKey = articleId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  blogSrc = blogSrc.replace(new RegExp(`\\s*${escapeRegex(slugKey)}:\\s*string;?\\n?`, 'g'), '');

  // 4. Remove from locale slug tables: slugKey: 'slug-value',
  blogSrc = blogSrc.replace(new RegExp(`\\s*${escapeRegex(slugKey)}:\\s*'[^']*',?\\n?`, 'g'), '');

  // 5. Remove from BLOG_SLUGS mapping: 'article-id': { ... },
  blogSrc = blogSrc.replace(new RegExp(`\\s*'${escaped}':\\s*\\{[^}]+\\},?\\n?`, 'g'), '');

  write('services/routerBlogData.ts', blogSrc);
  console.error('  ✅ router.ts + routerBlogData.ts aggiornati');
}

// ── Remove article from BlogArticles.tsx ────────────────────
function removeFromBlogArticles(articleId) {
  let src = read('components/community/BlogArticles.tsx');
  const escaped = escapeRegex(articleId);

  // Match the full article object block: { id: 'xxx', ... },
  const blockRegex = new RegExp(`\\s*\\{[^}]*id:\\s*'${escaped}'[^}]*\\},?`, 's');
  src = src.replace(blockRegex, '');

  write('components/community/BlogArticles.tsx', src);
  console.error('  ✅ BlogArticles.tsx aggiornato');
}

// ── Remove i18n keys from a meta file + delete per-article body file ────
function removeI18nKeys(articleId, locale) {
  // 1. Remove meta keys from blog-meta-{locale}.ts
  const metaFile = `services/locales/blog-meta-${locale}.ts`;
  if (existsSync(resolve(metaFile))) {
    let src = read(metaFile);
    const escaped = escapeRegex(articleId);
    const keyRegex = new RegExp(`\\s*'blog\\.article\\.${escaped}\\.[^']*':\\s*'[^']*',?\\n?`, 'g');
    src = src.replace(keyRegex, '');
    write(metaFile, src);
    console.error(`  ✅ ${metaFile} aggiornato`);
  }

  // 2. Delete per-article body file
  const bodyFile = `services/locales/blog-body/${locale}/${articleId}.ts`;
  if (existsSync(resolve(bodyFile))) {
    unlinkSync(resolve(bodyFile));
    console.error(`  🗑️  ${bodyFile} eliminato`);
  }
}

// ── Remove SEO metadata from seoService.ts ──────────────────
function removeFromSeoService(articleId) {
  let src = read('services/seoService.ts');
  const escaped = escapeRegex(articleId);

  // Remove SEO_METADATA block: 'blog-<id>': { ... },
  // This is a multi-line block so we need to match it carefully
  const seoRegex = new RegExp(`\\s*'blog-${escaped}':\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\},?`, 's');
  src = src.replace(seoRegex, '');

  // Remove breadcrumb entry if it exists
  const breadcrumbRegex = new RegExp(`\\s*'blog-${escaped}':\\s*'[^']*',?\\n?`, 'g');
  src = src.replace(breadcrumbRegex, '');

  write('services/seoService.ts', src);
  console.error('  ✅ seoService.ts aggiornato');
}

// ── Remove URL block from sitemap-blog.xml ───────────────────────
function removeFromSitemap(articleId) {
  let src = read('public/sitemap-blog.xml');
  const escaped = escapeRegex(articleId);

  // Match the entire <url>...</url> block that contains the article slug
  // The slug in the sitemap is the Italian slug, which we need to find
  // Look for <url> blocks containing the article ID or its slug
  const routerSrc = read('services/router.ts');
  const slugKey = articleId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  // Try to find the IT slug from router.ts
  const slugMatch = routerSrc.match(new RegExp(`${escapeRegex(slugKey)}:\\s*'([^']+)'`));
  const itSlug = slugMatch ? slugMatch[1] : articleId;

  // Remove the <url>...</url> block containing this slug
  const urlBlockRegex = new RegExp(`\\s*<url>\\s*<loc>[^<]*${escapeRegex(itSlug)}[^<]*</loc>[\\s\\S]*?</url>`, 'g');
  src = src.replace(urlBlockRegex, '');

  write('public/sitemap-blog.xml', src);
  console.error('  ✅ sitemap-blog.xml aggiornato');
}

// ── Delete generated image ──────────────────────────────────
function deleteGeneratedImage(articleId) {
  const imgDir = resolve('public/images/blog');
  if (!existsSync(imgDir)) return;

  const files = readdirSync(imgDir);
  const matches = files.filter(f => f.startsWith(articleId));

  for (const file of matches) {
    const fullPath = resolve(`public/images/blog/${file}`);
    unlinkSync(fullPath);
    console.error(`  🗑️  Immagine eliminata: public/images/blog/${file}`);
  }

  if (matches.length === 0) {
    console.error('  ℹ️  Nessuna immagine generata trovata per questo articolo');
  }
}

// ── Add redirect mapping (SEO safety) ───────────────────────
function addRedirectMapping(fromId, toId) {
  const redirectsPath = 'data/article-redirects.json';
  let redirects = {};

  if (existsSync(resolve(redirectsPath))) {
    try {
      redirects = JSON.parse(read(redirectsPath));
    } catch { /* start fresh */ }
  }

  // Get the IT slugs for both articles
  const routerSrc = read('services/router.ts');
  const fromSlugKey = fromId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const toSlugKey = toId.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  for (const locale of ['it', 'en', 'de', 'fr']) {
    // Find slugs in locale tables (search pattern: slugKey: 'value')
    const fromSlugMatch = routerSrc.match(new RegExp(`${escapeRegex(fromSlugKey)}:\\s*'([^']+)'`));
    const toSlugMatch = routerSrc.match(new RegExp(`${escapeRegex(toSlugKey)}:\\s*'([^']+)'`));

    if (fromSlugMatch && toSlugMatch) {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      redirects[`${prefix}/articoli-frontaliere/${fromSlugMatch[1]}`] = `${prefix}/articoli-frontaliere/${toSlugMatch[1]}`;
    }
  }

  write(redirectsPath, JSON.stringify(redirects, null, 2) + '\n');
  console.error(`  🔄 Redirect mapping aggiunto: ${fromId} → ${toId}`);
  console.error(`     File: ${redirectsPath}`);
}

// ── Git add all modified files ──────────────────────────────
function gitAddAll() {
  const files = [
    'services/router.ts',
    'components/community/BlogArticles.tsx',
    'services/i18n.ts',
    'services/locales/blog-meta-it.ts',
    'services/locales/blog-meta-en.ts',
    'services/locales/blog-meta-de.ts',
    'services/locales/blog-meta-fr.ts',
    'services/seoService.ts',
    'public/sitemap-blog.xml',
  ];

  if (existsSync(resolve('data/article-redirects.json'))) {
    files.push('data/article-redirects.json');
  }

  const existing = files.filter(f => existsSync(resolve(f)));
  if (existing.length > 0) {
    execSync(`git add ${existing.join(' ')}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
    console.error('  ✅ File modificati aggiunti a git');
  }
}

// ── Verify article exists ───────────────────────────────────
function articleExists(articleId) {
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];
  return existingIds.includes(articleId);
}

function getAllArticleIds() {
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  return idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.error(`
📰 manage-article.mjs — Gestione articoli del blog

Comandi:
  list                                    Lista tutti gli articoli
  remove <id>                             Rimuovi un articolo
  remove <id> --redirect-to <other-id>    Rimuovi con redirect SEO
  remove <id> --force                     Rimuovi senza conferma

Esempi:
  node scripts/manage-article.mjs list
  node scripts/manage-article.mjs remove telelavoro-frontalieri-via-libera-italia
  node scripts/manage-article.mjs remove old-article --redirect-to new-article
`);
    process.exit(0);
  }

  if (command === 'list') {
    listArticles();
    process.exit(0);
  }

  if (command === 'remove') {
    const articleId = args[0];
    if (!articleId) {
      console.error('❌ Specifica l\'ID dell\'articolo da rimuovere.');
      console.error('   Usa "node scripts/manage-article.mjs list" per vedere gli ID disponibili.');
      process.exit(1);
    }

    if (!articleExists(articleId)) {
      console.error(`❌ Articolo "${articleId}" non trovato.`);
      console.error('   Articoli disponibili:');
      getAllArticleIds().forEach(id => console.error(`     - ${id}`));
      process.exit(1);
    }

    const forceFlag = args.includes('--force');
    const redirectToIdx = args.indexOf('--redirect-to');
    const redirectTo = redirectToIdx !== -1 ? args[redirectToIdx + 1] : null;

    if (redirectTo && !articleExists(redirectTo)) {
      console.error(`❌ Articolo target per redirect "${redirectTo}" non trovato.`);
      process.exit(1);
    }

    // Get article title for confirmation
    const i18nSrc = read('services/i18n.ts');
    const titleMatch = i18nSrc.match(new RegExp(`'blog\\.article\\.${escapeRegex(articleId)}\\.title':\\s*'([^']+)'`));
    const title = titleMatch ? titleMatch[1] : articleId;

    if (!forceFlag) {
      console.error(`\n⚠️  Stai per rimuovere l'articolo:`);
      console.error(`   ID: ${articleId}`);
      console.error(`   Titolo: ${title}`);
      if (redirectTo) {
        console.error(`   Redirect a: ${redirectTo}`);
      }
      console.error('');
      const answer = await ask('Confermi la rimozione? (s/n): ');
      if (answer.toLowerCase() !== 's' && answer.toLowerCase() !== 'si' && answer.toLowerCase() !== 'sì' && answer.toLowerCase() !== 'y') {
        console.error('❌ Operazione annullata.');
        process.exit(0);
      }
    }

    console.error(`\n🗑️  Rimozione articolo: ${articleId}\n`);

    // If redirect requested, save mapping BEFORE removal (need slug data)
    if (redirectTo) {
      addRedirectMapping(articleId, redirectTo);
    }

    // Remove from all source files
    removeFromRouter(articleId);
    removeFromBlogArticles(articleId);
    removeI18nKeys(articleId, 'it');
    removeI18nKeys(articleId, 'en');
    removeI18nKeys(articleId, 'de');
    removeI18nKeys(articleId, 'fr');
    removeFromSeoService(articleId);
    removeFromSitemap(articleId);
    deleteGeneratedImage(articleId);

    // Git add
    console.error('\n📦 Staging file:');
    gitAddAll();

    console.error(`\n✅ Articolo "${articleId}" rimosso con successo!`);
    if (redirectTo) {
      console.error(`   🔄 Redirect configurato verso: ${redirectTo}`);
    }
    console.error('   Esegui "npm test && npx vite build" per verificare che tutto funzioni.');
    process.exit(0);
  }

  console.error(`❌ Comando sconosciuto: ${command}`);
  console.error('   Usa "list" o "remove <id>". Vedi --help per dettagli.');
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ Errore: ${e.message}`);
  process.exit(1);
});
