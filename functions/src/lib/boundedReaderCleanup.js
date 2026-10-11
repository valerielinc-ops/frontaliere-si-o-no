const READER_CLEANUP_TIMEOUT_MS = 1_000;

/** Best-effort stream cleanup that cannot hold the caller forever. */
export async function cancelReaderWithDeadline(reader) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => reader?.cancel?.()),
      new Promise((resolve) => {
        timer = setTimeout(resolve, READER_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Cleanup never replaces the read or stream verdict.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
