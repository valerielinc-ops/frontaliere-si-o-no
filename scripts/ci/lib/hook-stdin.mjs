/**
 * hook-stdin.mjs — lettura del payload degli hook Claude Code / Codex con un
 * timeout.
 *
 * Gli hook ricevono il payload JSON su stdin e l'harness chiude stdin subito
 * dopo averlo scritto. Uno script hook lanciato A MANO dalla shell di un
 * agente invece eredita uno stdin (socket o pipe) che non arriva mai a EOF:
 * un `for await (const chunk of process.stdin)` lo teneva appeso per ore,
 * senza output (2026-09-19, `pr-body-check-gate.mjs --help`, 1h39m). Tutti i
 * lettori di stdin degli hook passano da qui, cosi' la classe si chiude in un
 * posto solo.
 */

export const DEFAULT_HOOK_STDIN_TIMEOUT_MS = 5000;

/**
 * Timeout di lettura del payload hook; `PR_BODY_GATE_STDIN_TIMEOUT_MS` (nome
 * storico del primo consumatore) o `HOOK_STDIN_TIMEOUT_MS` lo sovrascrivono.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function hookStdinTimeoutMs(env = process.env) {
  for (const key of ['PR_BODY_GATE_STDIN_TIMEOUT_MS', 'HOOK_STDIN_TIMEOUT_MS']) {
    const n = Number(env[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_HOOK_STDIN_TIMEOUT_MS;
}

/**
 * Legge `stream` fino a EOF, ma non oltre `timeoutMs`. Allo scadere
 * restituisce quanto arrivato con `timedOut: true` e rilascia lo stream,
 * cosi' il processo puo' terminare.
 *
 * @param {NodeJS.ReadableStream & { destroy?: () => void }} [stream]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ raw: string, bytes: number, timedOut: boolean }>}
 */
export function readHookStdin(stream = process.stdin, timeoutMs = hookStdinTimeoutMs()) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (timedOut) {
        stream.pause?.();
        stream.destroy?.();
      }
      resolvePromise({ raw: Buffer.concat(chunks).toString('utf8'), bytes, timedOut });
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      chunks.push(buffer);
    };
    const onEnd = () => finish(false);
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}
