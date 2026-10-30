/** Job details keep one complete X card when the SPA changes their metadata. */
export function updateJobTwitterCardMeta(card: { title: string; description: string; image: string }): void {
  const values = {
    'twitter:card': 'summary_large_image',
    'twitter:title': card.title,
    'twitter:description': card.description,
    'twitter:image': card.image,
  };
  for (const [name, content] of Object.entries(values)) {
    const [existing, ...duplicates] = document.head.querySelectorAll<HTMLMetaElement>(
      `meta[name="${name}" i], meta[property="${name}" i]`,
    );
    const meta = existing || document.createElement('meta');
    meta.removeAttribute('property');
    meta.name = name;
    meta.content = content;
    if (!existing) document.head.append(meta);
    duplicates.forEach((duplicate) => duplicate.remove());
  }
}
