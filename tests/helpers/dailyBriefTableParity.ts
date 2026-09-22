const RAW_TABLE_SEPARATOR = /\|\s*:?-{2,}:?\s*\|/;

export function visibleTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
}

export function countRenderedTables(html: string): number {
  return (html.match(/<table\b/gi) || []).length;
}

export function hasRawTableSeparator(text: string): boolean {
  return RAW_TABLE_SEPARATOR.test(text);
}
