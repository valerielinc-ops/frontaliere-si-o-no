import { useEffect, useState } from 'react';

type FaqItem = { question: string; answer: string };

/** Domande del blocco FAQPage presente nella pagina, così testo e schema coincidono. */
export function readStructuredFaq(root: ParentNode = document): FaqItem[] {
 for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
  try {
   const parsed: unknown = JSON.parse(script.textContent ?? '');
   const blocks = Array.isArray(parsed) ? parsed : [parsed];
   for (const block of blocks as Array<{ '@type'?: string; mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }> }>) {
    if (block?.['@type'] !== 'FAQPage' || !Array.isArray(block.mainEntity)) continue;
    return block.mainEntity
     .filter((entry) => entry.name && entry.acceptedAnswer?.text)
     .map((entry) => ({ question: entry.name as string, answer: entry.acceptedAnswer?.text as string }));
   }
  } catch { /* un blocco non valido non deve fermare gli altri */ }
 }
 return [];
}

export default function StructuredFaqList({ title }: { title: string }) {
 const [items, setItems] = useState<FaqItem[]>([]);
 useEffect(() => { setItems(readStructuredFaq()); }, []);
 if (items.length === 0) return null;
 return (
  <section className="mt-8" data-testid="structured-faq-list">
   <h2 className="text-lg font-bold font-display text-heading mb-3">{title}</h2>
   <div className="space-y-2">
    {items.map((item) => (
     <details key={item.question} className="rounded-xl border border-edge bg-surface p-3">
      <summary className="cursor-pointer font-semibold text-strong">{item.question}</summary>
      <p className="mt-2 text-sm text-body">{item.answer}</p>
     </details>
    ))}
   </div>
  </section>
 );
}
