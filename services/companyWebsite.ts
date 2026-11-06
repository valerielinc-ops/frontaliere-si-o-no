export function companyWebsiteDomain(website: string | null | undefined): string {
 if (!website) return '';
 try {
  return new URL(website).hostname.replace(/^www\./, '');
 } catch {
  return '';
 }
}
