/**
 * Stamp a consent decision for popupQueue, from the first module that runs.
 *
 * popupQueue arrives with a lazy chunk, seconds after the entry, and the CMP bridge
 * cannot write this value itself: it belongs to the fingerprinted shell shared with
 * the corpus repository. The queue reads the key when a prompt asks for a slot, so a
 * decision taken in between still spends the promotional cap. A decision taken
 * before this module runs is recovered by the queue through the TCF replay.
 *
 * Literals and no imports on purpose. This module has one importer, index.tsx: sharing
 * a constant with a lazy chunk would pull that module into the entry chunk, whose
 * bootstrap exports nothing (the verify-spa-module-links failure behind #15438).
 * tests/promotional-after-consent.test.ts proves both literals against the real ones.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('frontaliere:ads-consent', () => {
    try {
      sessionStorage.setItem('ft_promotional_prompt_at', String(Date.now()));
    } catch { /* storage optional: the queue's own listener covers a later decision */ }
  });
}

export {};
