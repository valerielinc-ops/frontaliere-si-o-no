import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const TYPESCRIPT_VERSION = '5.8.3';
const require = createRequire(import.meta.url);

/**
 * Load the pinned TypeScript runtime used by static article readers.
 * Corpus CI provides its isolated compiler through ARTICLE_SOURCE_TYPESCRIPT;
 * local site builds resolve the package installed for this repository.
 */
export function loadArticleSourceTypeScript() {
  const configuredEntry = process.env.ARTICLE_SOURCE_TYPESCRIPT;
  let compilerEntry;

  if (configuredEntry !== undefined) {
    if (typeof configuredEntry !== 'string' || configuredEntry.trim() === '' || !isAbsolute(configuredEntry)) {
      throw new Error('ARTICLE_SOURCE_TYPESCRIPT must be an absolute path to the pinned TypeScript compiler entry.');
    }
    compilerEntry = resolve(configuredEntry);
  } else {
    try {
      compilerEntry = require.resolve('typescript');
    } catch (error) {
      throw new Error(
        'The article source reader requires TypeScript 5.8.3; set ARTICLE_SOURCE_TYPESCRIPT to its compiler entry.',
        { cause: error },
      );
    }
  }

  const ts = require(compilerEntry);
  if (ts.version !== TYPESCRIPT_VERSION) {
    throw new Error(
      `The article source reader requires TypeScript ${TYPESCRIPT_VERSION}; received ${String(ts.version)} from ${compilerEntry}.`,
    );
  }
  if (
    typeof ts.createSourceFile !== 'function'
    || typeof ts.forEachChild !== 'function'
    || typeof ts.createScanner !== 'function'
  ) {
    throw new Error(`TypeScript ${TYPESCRIPT_VERSION} is missing AST APIs required by the article source reader.`);
  }
  return ts;
}
