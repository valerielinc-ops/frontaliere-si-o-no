import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { DOCUMENT_CHECK_VERSION } from './assistedApplicationDocumentCheck';
import { recheckReviewDocument, type ReviewDocument, type ReviewPayload } from './assistedApplicationReviewService';

type Check = ReviewDocument['files'][number]['clientCheck'];
type Result = { check: Check; uploadedAt: number | null; size: number };
const documentIdentity = (document: ReviewDocument) => [document.id, document.label, document.kind, document.keywords, document.required, document.quote];

/** Resume cancelled checks, preserve actual failures, and never apply a result to another token or file. */
export function useAssistedApplicationDocumentRechecks(token: string, data: ReviewPayload | null, setData: Dispatch<SetStateAction<ReviewPayload | null>>) {
  const attempted = useRef(new Set<string>());
  const completed = useRef(new Map<string, Result>());
  const currentToken = useRef(token);
  currentToken.current = token;
  // A normal payload refresh or answer edit must not interrupt the same document read.
  const signature = JSON.stringify((data?.documents || []).map(document => ({
    document: documentIdentity(document),
    files: document.files.map(file => [file.id, file.name, file.detectedType, file.uploadedAt, file.size, file.clientCheck.version]),
  })));
  const round = data?.round;
  const stale = data?.stale;
  useEffect(() => {
    if (!data || stale) return undefined;
    let cancelled = false;
    const active = new Set<string>();
    const controller = new AbortController();
    void (async () => {
      const results = new Map<string, Result>();
      for (const document of data.documents || []) {
        for (const file of document.files) {
          if (cancelled || (file.clientCheck.version || 1) >= DOCUMENT_CHECK_VERSION) continue;
          const key = JSON.stringify([token, round, documentIdentity(document), file.id, file.name, file.detectedType, file.uploadedAt, file.size, DOCUMENT_CHECK_VERSION]);
          const cached = completed.current.get(key);
          if (cached) { results.set(`${document.id}:${file.id}`, cached); continue; }
          if (attempted.current.has(key)) continue;
          attempted.current.add(key);
          active.add(key);
          try {
            const check = await recheckReviewDocument(token, document, file, controller.signal);
            if (check && !cancelled) {
              const result = { check, uploadedAt: file.uploadedAt, size: file.size };
              completed.current.set(key, result);
              results.set(`${document.id}:${file.id}`, result);
            }
          } catch { /* A failed or unsupported check keeps the explicitly legacy status. */ }
          finally { if (!cancelled) active.delete(key); }
        }
      }
      if (!cancelled && currentToken.current === token && results.size) setData(current => !current || current.round !== round ? current : ({
        ...current,
        documents: (current.documents || []).map(document => ({ ...document, files: document.files.map(file => {
          const result = results.get(`${document.id}:${file.id}`);
          return result && result.uploadedAt === file.uploadedAt && result.size === file.size
            && (file.clientCheck.version || 1) <= (result.check.version || 1)
            ? { ...file, clientCheck: result.check } : file;
        }) })),
      }));
    })();
    return () => {
      cancelled = true;
      controller.abort();
      // StrictMode and a changed document snapshot restart unfinished work; real failures stay settled.
      for (const key of active) attempted.current.delete(key);
    };
  }, [token, round, stale, signature, setData]);
}
