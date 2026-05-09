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
): Promise<BlogBodyTranslations | null> {
  try {
    const mod = await import(`./locales/blog-body/${locale}/${articleId}.ts`);
    return (mod as { default: BlogBodyTranslations }).default;
  } catch {
    return null;
  }
}
