/**
 * FAQ_QUESTION_PREFIXES — single source of truth for the question-starter
 * words used to detect FAQ-eligible `## Heading` blocks in AI-generated
 * article bodies, across all 4 site locales (IT/EN/DE/FR).
 *
 * This file exists because the same list had drifted into two copies
 * (BlogArticles.QUESTION_PREFIXES, ogPagesPlugin's FAQ_QUESTION_PREFIXES)
 * where the client-side copy only listed Italian words — EN/DE/FR headings
 * without a literal '?' were silently skipped from FAQPage JSON-LD
 * eligibility. Pure, zero-import, safe to share between React components
 * and build plugins.
 */
export const FAQ_QUESTION_PREFIXES = [
  'Come', 'Cosa', 'Quando', 'Quanto', 'Dove', 'Chi', 'Perché', 'Quale',
  'How', 'What', 'When', 'Where', 'Who', 'Why', 'Which', 'Can', 'Should', 'Is', 'Are', 'Do', 'Does',
  'Wie', 'Was', 'Wann', 'Wo', 'Wer', 'Warum', 'Welche',
  'Comment', 'Quoi', 'Quand', 'Où', 'Qui', 'Pourquoi', 'Quel', 'Quelle', 'Est-ce',
];
