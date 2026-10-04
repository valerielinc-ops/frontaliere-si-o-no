/**
 * The owner's one line on what left with an application (scripts/assisted-application/lib/submit.mjs `sent`),
 * in Italian like the rest of the queue. Pure, so the page and the tests share it.
 */
import type { AutomationSentView } from './assistedApplicationAdminService';
import { LEGACY_RENDERER_LABEL } from './assistedApplicationPdfRendererStatus';

const WHY: Record<string, string> = {
  ad_single: 'lo chiede l’annuncio',
  switch: 'interruttore «un PDF» acceso',
  ad_separate: 'l’annuncio chiede file separati',
  apprentice: 'apprendista: mai un PDF unico',
  cv_not_pdf: 'niente PDF unico: il CV che parte non è un PDF',
  document_not_mergeable: 'niente PDF unico: un documento è un file Word',
  encrypted_or_broken: 'niente PDF unico: un file è protetto o illeggibile',
  pages: 'niente PDF unico: più di 5 pagine',
  bytes: 'niente PDF unico: troppo pesante',
  check_failed: 'niente PDF unico: il file unito non ha superato il controllo',
};
const DOCUMENTS_WHY: Record<string, string> = {
  ad_separate: 'lo chiede l’annuncio',
  document_not_mergeable: 'c’è un file Word',
  encrypted_or_broken: 'un file è protetto o illeggibile',
  bytes: 'insieme oltre 3 MB',
  check_failed: 'il file unito non ha superato il controllo',
  document_signed: 'c’è un PDF firmato digitalmente',
};
// A digitally signed PDF leaves as it is next to the merged file (dossier.mjs): merged, its signature would no longer verify.
const signedApart = (count: number) => (count === 1 ? '1 documento firmato digitalmente a parte' : `${count} documenti firmati digitalmente a parte`);
// A send whose outcome was uncertain, confirmed afterwards (assistedApplicationAutomation.js confirmSentAttempt).
const CONFIRMED: Record<string, string> = {
  owner: 'invio dall’esito incerto, confermato da te',
  acknowledgement: 'invio dall’esito incerto, confermato dalla risposta del datore',
};

export function sentSummaryIt(sent: AutomationSentView): string {
  const documents = sent.files.filter((file) => file.kind === 'document').length;
  let what = 'lettera e CV separati';
  if (sent.packaging === 'single') what = sent.documentsGrouped ? 'un PDF unico con lettera, CV e documenti richiesti' : 'un PDF unico con lettera e CV';
  if (sent.packaging === 'portal') what = `caricata sul portale: ${sent.files.length} file`;
  if (sent.packaging === 'whatsapp') what = 'via WhatsApp dal telefono del candidato: nessun file è partito da noi';
  const why = WHY[sent.reason || ''];
  const parts = [why ? `${what} (${why})` : what];
  // Next to a merged file, a document file left on its own only when it is signed.
  if (sent.packaging === 'single' && documents) parts.push(signedApart(documents));
  else if (sent.packaging === 'separate' && sent.documentsGrouped) parts.push(documents ? `documenti richiesti in un PDF, ${signedApart(documents)}` : 'documenti richiesti in un PDF');
  else if (sent.packaging === 'separate' && documents) {
    const documentsWhy = DOCUMENTS_WHY[sent.documentsReason || ''];
    parts.push(`documenti richiesti: ${documents === 1 ? '1 file' : `${documents} file separati`}${documentsWhy ? ` (${documentsWhy})` : ''}`);
  }
  if (sent.pages && sent.bytes) parts.push(`${sent.pages} ${sent.pages === 1 ? 'pagina' : 'pagine'}, ${Math.max(1, Math.round(sent.bytes / 1024))} KB`);
  if (sent.adCue) parts.push(`annuncio: «${sent.adCue}»`);
  if (sent.confirmedBy && CONFIRMED[sent.confirmedBy]) parts.push(CONFIRMED[sent.confirmedBy]);
  const renderer = sent.letterRenderer === 'typst' ? 'lettera composta con Typst'
    : sent.letterRenderer === 'legacy' ? `lettera composta con il ${LEGACY_RENDERER_LABEL}` : '';
  return renderer ? `${parts.join(' · ')} — ${renderer}` : parts.join(' · ');
}
