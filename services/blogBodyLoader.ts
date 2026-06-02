/**
 * Blog body chunk loader — isolated module so the Vite-generated
 * dynamic-import resolution table for `services/locales/blog-body/**` lives
 * in a chunk loaded only when an article is opened, instead of polluting
 * the global i18n chunk on every page.
 */

export type BlogBodyTranslations = Record<string, string>;

export async function loadBlogBodyChunk(
  locale: string,
  articleId: string,
  section: 'frontaliere' | 'svizzera' = 'frontaliere',
): Promise<BlogBodyTranslations | null> {
  try {
    // Two distinct literal globs so Vite emits a resolution table per section.
    const mod = section === 'svizzera'
      ? await import(`./locales/blog-body-ch/${locale}/${articleId}.ts`)
      : await import(`./locales/blog-body/${locale}/${articleId}.ts`);
    return (mod as { default: BlogBodyTranslations }).default;
  } catch {
    return null;
  }
}
