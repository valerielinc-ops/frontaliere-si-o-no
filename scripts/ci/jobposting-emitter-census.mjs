import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Versioned inventory of every public JobPosting emitter.
 *
 * The seven build/runtime modules named by issue #10501 are joined by the
 * hydrated JobBoard component: it is a public JSON-LD path too, and its
 * source must use the same canonical builder as the static paths. Keeping the
 * runtime entry in this inventory makes that otherwise easy-to-miss path part
 * of the same source contract.
 */
export const JOBPOSTING_EMITTER_MANIFEST_VERSION = 1;

export const JOBPOSTING_LOCALE_PREFIXES = Object.freeze({
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
});

export const JOBPOSTING_PUBLIC_VARIANTS = Object.freeze([
  'active',
  'expired',
  'list',
  'hub',
  'runtime',
]);

const emitter = (id, sourceFile, requiredBuilders, variants, kind) => Object.freeze({
  id,
  sourceFile,
  requiredBuilders: Object.freeze(requiredBuilders),
  localePrefixes: JOBPOSTING_LOCALE_PREFIXES,
  variants: Object.freeze(variants),
  kind,
});

export const JOBPOSTING_EMITTER_MANIFEST = Object.freeze({
  version: JOBPOSTING_EMITTER_MANIFEST_VERSION,
  localePrefixes: JOBPOSTING_LOCALE_PREFIXES,
  variants: JOBPOSTING_PUBLIC_VARIANTS,
  emitters: Object.freeze([
    emitter(
      'jobs-seo-pages',
      'build-plugins/jobsSeoPagesPlugin.ts',
      ['buildJobPostingSchema', 'buildListItemJobPosting'],
      ['active', 'expired', 'list', 'hub'],
      'static',
    ),
    emitter(
      'weekly-employers',
      'build-plugins/weeklyEmployersPlugin.ts',
      ['buildListItemJobPosting'],
      ['active', 'list', 'hub'],
      'static',
    ),
    emitter(
      'employer-profile-pages',
      'build-plugins/employerProfilePagesPlugin.ts',
      ['buildListItemJobPosting'],
      ['active', 'list', 'hub'],
      'static',
    ),
    emitter(
      'health-facilities',
      'build-plugins/healthFacilitiesPlugin.ts',
      ['buildJobPostingSchema'],
      ['active', 'list'],
      'static',
    ),
    emitter(
      'publisher-ad-pages',
      'build-plugins/publisherAdPagesPlugin.ts',
      ['buildJobPostingSchema'],
      ['active'],
      'static',
    ),
    emitter(
      'salary-profession-canton-pages',
      'build-plugins/salaryProfessionCantonPages.ts',
      ['buildListItemJobPosting'],
      ['active', 'list', 'hub'],
      'static',
    ),
    emitter(
      'seo-service-runtime',
      'services/seoService.ts',
      ['buildJobPostingSchema'],
      ['active', 'runtime'],
      'runtime',
    ),
    emitter(
      'job-board-runtime',
      'components/community/JobBoard.tsx',
      ['buildJobPostingSchema'],
      ['active', 'list', 'hub', 'runtime'],
      'runtime',
    ),
  ]),
});

// Short alias used by the metric/reporting guard and by tests.
export const JOBPOSTING_EMITTERS = JOBPOSTING_EMITTER_MANIFEST.emitters;

const HELPER_SOURCES = new Set([
  'build-plugins/shared/jobPostingSchema.ts',
  'build-plugins/shared/jobPostingFaq.ts',
  'build-plugins/shared/jobPostingListItem.ts',
]);

const SOURCE_ROOTS = Object.freeze([
  'build-plugins',
  'services',
  'components',
  'App.tsx',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const BUILDER_MODULE_RE = /(?:^|\/)(?:jobPostingSchema|jobPostingListItem)(?:\.[cm]?[jt]sx?)?$/u;
const DIRECT_JOBPOSTING_SOURCE_RE = /['"]@type['"]\s*:\s*['"]JobPosting['"]/u;

function propertyNameText(name) {
  if (!name) return '';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return '';
}

function stringLiteralText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function scriptKindFor(filePath) {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Inspect one emitter with the TypeScript parser so comments and prose cannot
 * satisfy the guard. A direct `{ '@type': 'JobPosting' }` object is an
 * emitter declaration; comparisons used by runtime cleanup code are not.
 */
export function inspectJobPostingEmitter(rootDir, emitterEntry) {
  const absolutePath = path.join(rootDir, emitterEntry.sourceFile);
  if (!fs.existsSync(absolutePath)) {
    return {
      sourceFile: emitterEntry.sourceFile,
      exists: false,
      importedBuilders: [],
      calledBuilders: [],
      directDeclarations: [],
    };
  }

  const source = fs.readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    emitterEntry.sourceFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(emitterEntry.sourceFile),
  );
  const importedBuilders = new Map();
  const directDeclarations = [];
  const calledBuilders = new Set();

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = stringLiteralText(node.moduleSpecifier);
      if (moduleName && BUILDER_MODULE_RE.test(moduleName)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = propertyNameText(element.propertyName) || propertyNameText(element.name);
            importedBuilders.set(propertyNameText(element.name), importedName);
          }
        }
      }
    }

    if (ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === '@type'
      && stringLiteralText(node.initializer) === 'JobPosting') {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      directDeclarations.push({ line, text: node.getText(sourceFile) });
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const importedName = importedBuilders.get(propertyNameText(node.expression));
      if (importedName) calledBuilders.add(importedName);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    sourceFile: emitterEntry.sourceFile,
    exists: true,
    importedBuilders: [...importedBuilders.values()].sort(),
    calledBuilders: [...calledBuilders].sort(),
    directDeclarations,
    hasBuilderImport: importedBuilders.size > 0,
    hasBuilderImportText: DIRECT_JOBPOSTING_SOURCE_RE.test(source) || importedBuilders.size > 0,
  };
}

function collectSourceFiles(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return SOURCE_EXTENSIONS.has(path.extname(absolutePath)) ? [relativePath] : [];
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    const childRelative = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(rootDir, childRelative));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(childRelative);
  }
  return files;
}

function discoverPublicJobPostingSources(rootDir) {
  const sources = [];
  for (const root of SOURCE_ROOTS) {
    for (const sourceFile of collectSourceFiles(rootDir, root)) {
      if (HELPER_SOURCES.has(sourceFile)) continue;
      const absolutePath = path.join(rootDir, sourceFile);
      const source = fs.readFileSync(absolutePath, 'utf8');
      if (!DIRECT_JOBPOSTING_SOURCE_RE.test(source)
        && !/(?:jobPostingSchema|jobPostingListItem)/u.test(source)) continue;
      const syntheticEntry = { sourceFile };
      const inspected = inspectJobPostingEmitter(rootDir, syntheticEntry);
      if (inspected.hasBuilderImport || inspected.directDeclarations.length > 0) sources.push(inspected);
    }
  }
  return sources;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Run the complete source/census contract. The return value is deliberately
 * plain data so the same check powers the CLI gate and the Vitest observer.
 */
export function checkJobPostingEmitterCensus(rootDir = process.cwd()) {
  const failures = [];
  const manifest = JOBPOSTING_EMITTER_MANIFEST;
  const entries = manifest.emitters;
  const manifestSources = entries.map((entry) => entry.sourceFile);
  const discovered = discoverPublicJobPostingSources(rootDir);
  const discoveredSources = discovered.map((entry) => entry.sourceFile);

  if (manifest.version !== JOBPOSTING_EMITTER_MANIFEST_VERSION) {
    failures.push(`manifest version ${manifest.version} does not match ${JOBPOSTING_EMITTER_MANIFEST_VERSION}`);
  }
  if (entries.length < 7) failures.push(`expected at least the seven issue-listed emitters, found ${entries.length}`);
  if (new Set(manifestSources).size !== manifestSources.length) failures.push('manifest contains duplicate source files');
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) failures.push('manifest contains duplicate emitter ids');

  const localeKeys = Object.keys(manifest.localePrefixes).sort();
  if (localeKeys.join(',') !== 'de,en,fr,it') failures.push(`locale census is ${localeKeys.join(',')}, expected de,en,fr,it`);
  for (const [locale, prefix] of Object.entries(manifest.localePrefixes)) {
    if (!prefix.startsWith('/') || !prefix.endsWith('/')) {
      failures.push(`locale prefix ${locale} must be slash-canonical: ${prefix}`);
    }
  }

  const variants = new Set(manifest.variants);
  for (const requiredVariant of JOBPOSTING_PUBLIC_VARIANTS) {
    if (!variants.has(requiredVariant)) failures.push(`manifest is missing public variant ${requiredVariant}`);
  }

  const emitterVariantUnion = new Set();
  for (const entry of entries) {
    for (const locale of Object.keys(manifest.localePrefixes)) {
      if (entry.localePrefixes?.[locale] !== manifest.localePrefixes[locale]) {
        failures.push(`${entry.id} does not carry locale prefix ${locale}`);
      }
    }
    for (const variant of entry.variants) {
      if (!variants.has(variant)) failures.push(`${entry.id} declares unknown variant ${variant}`);
      emitterVariantUnion.add(variant);
    }

    const inspection = inspectJobPostingEmitter(rootDir, entry);
    if (!inspection.exists) {
      failures.push(`${entry.id} source is missing: ${entry.sourceFile}`);
      continue;
    }
    if (inspection.directDeclarations.length > 0) {
      const lines = inspection.directDeclarations.map((declaration) => declaration.line).join(', ');
      failures.push(`${entry.sourceFile} declares JobPosting directly at line(s) ${lines}; use the canonical builder`);
    }
    const requiredBuilders = new Set(entry.requiredBuilders);
    const calledRequired = inspection.calledBuilders.filter((builder) => requiredBuilders.has(builder));
    if (calledRequired.length === 0) {
      failures.push(`${entry.sourceFile} does not call one of ${[...requiredBuilders].join(', ')}`);
    }
    for (const requiredBuilder of requiredBuilders) {
      if (inspection.calledBuilders.includes(requiredBuilder)) continue;
      // An emitter may legitimately use either canonical builder. The
      // manifest can require both only when both paths are present in the
      // module, so the per-entry requirement is an OR, not an AND.
      if (requiredBuilders.size > 1) continue;
    }
  }
  for (const requiredVariant of JOBPOSTING_PUBLIC_VARIANTS) {
    if (!emitterVariantUnion.has(requiredVariant)) failures.push(`no emitter covers public variant ${requiredVariant}`);
  }

  const unregistered = sortedUnique(discoveredSources.filter((sourceFile) => !manifestSources.includes(sourceFile)));
  if (unregistered.length > 0) failures.push(`unregistered public JobPosting emitter(s): ${unregistered.join(', ')}`);

  const missingFromDiscovery = sortedUnique(manifestSources.filter((sourceFile) => !discoveredSources.includes(sourceFile)));
  if (missingFromDiscovery.length > 0) failures.push(`manifest source(s) are not discoverable as builder-backed emitters: ${missingFromDiscovery.join(', ')}`);

  const directUnregistered = discovered.filter((entry) => !manifestSources.includes(entry.sourceFile) && entry.directDeclarations.length > 0);
  if (directUnregistered.length > 0) {
    failures.push(`direct JobPosting declaration outside the census: ${directUnregistered.map((entry) => entry.sourceFile).join(', ')}`);
  }

  return {
    failures,
    manifestVersion: manifest.version,
    emitterCount: entries.length,
    discoveredSourceCount: discoveredSources.length,
    staticEmitterCount: entries.filter((entry) => entry.kind === 'static').length,
    runtimeEmitterCount: entries.filter((entry) => entry.kind === 'runtime').length,
    emitters: entries,
    discovered,
  };
}
