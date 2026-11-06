/**
 * CI-only declaration boundary for the published article registries.
 *
 * The runtime modules are generated corpus entrypoints reached through
 * `data/` symlinks. The full checkout is intentional for related tests, but
 * the TypeScript baseline must check application code without traversing that
 * corpus. `tsconfig.ci.json` maps both registry aliases here, preserving the
 * contract consumed by the application while keeping generated files out of
 * the compiler program.
 */
export interface Article {
  id: string;
  category: 'fiscale' | 'pratico' | 'novita' | 'pensione';
  date: string;
  updatedAt?: string;
  image: string;
  hasCalculator: boolean;
  articleType?: 'news' | 'evergreen';
  verifiedAt?: string;
  canton?: string[];
  authorSlug?: string;
  authorName?: string;
  aiAssisted?: boolean;
}

export declare const ARTICLES: Article[];
export declare const SWISS_ARTICLES: Article[];
