import { Fragment } from 'react';
import { imageCreditParts, type ImageCreditRecord } from '@/packages/articles/engine/shared/imageCredits.mjs';

interface ImageCreditLineProps {
  record: ImageCreditRecord;
  locale: string;
}

/**
 * The credit of a Wikimedia Commons cover photo, at the end of the article
 * (P14; owner decision 2026-10-03: «se dobbiamo mostrare un testo facciamo lo
 * vedere in fondo all'articolo»).
 *
 * The React twin of the static page's `renderImageCreditHtml`: both render the
 * segments of `imageCreditParts`, the one copy of the wording, so the SPA and
 * the static article say the same thing with the same links. Same markup too:
 * a `<footer>` (not a `<p>`, which the speakable selector `article p` would
 * read aloud), names isolated in `<bdi>` (some authors write right-to-left),
 * and links with `rel="noopener"` only — never `rel="license"`, which would put
 * the page itself under the photo's licence, nor `rel="author"`, which the
 * byline owns. Semantic tokens only: the text is `text-subtle` and the links
 * inherit it.
 */
export default function ImageCreditLine({ record, locale }: ImageCreditLineProps) {
  const parts = imageCreditParts(record, locale);
  if (!parts) return null;
  return (
    <footer className="ft-image-credit mt-8 text-sm text-subtle" data-image-credit={record.source}>
      <small>
        {parts.segments.map((part, index) => {
          if (part.kind === 'text') return <Fragment key={index}>{part.text}</Fragment>;
          const label = (
            <>
              {part.open}
              {part.isolate ? <bdi>{part.text}</bdi> : part.text}
              {part.close}
            </>
          );
          return part.href ? (
            <a
              key={index}
              href={part.href}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-2 hover:text-body"
            >
              {label}
            </a>
          ) : (
            <Fragment key={index}>{label}</Fragment>
          );
        })}
      </small>
    </footer>
  );
}
