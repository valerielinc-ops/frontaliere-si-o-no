export interface CapturedPageError {
  name: string;
  message: string;
  stack: string;
}

function frameUrls(stack: unknown): string[] | null {
  if (typeof stack !== 'string' || stack.trim() === '') return [];

  const urls: string[] = [];
  for (const line of stack.split(/\r?\n/)) {
    if (!/^\s*at\s+/.test(line)) continue;
    const match = line.match(/https?:\/\/[^\s)]+/);
    if (!match) continue;

    try {
      new URL(match[0]);
      urls.push(match[0]);
    } catch {
      return null;
    }
  }
  return urls;
}

export function isThirdPartyOnlyStack(stack: string, ownHost: string): boolean {
  if (!ownHost) return false;
  const urls = frameUrls(stack);
  if (!urls || urls.length === 0) return false;

  const normalizedOwnHost = ownHost.toLowerCase();
  return urls.every((url) => {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname !== normalizedOwnHost && !hostname.endsWith(`.${normalizedOwnHost}`);
  });
}

export function splitPageErrors(
  errors: CapturedPageError[],
  ownHost: string,
): { own: CapturedPageError[]; thirdParty: CapturedPageError[] } {
  const own: CapturedPageError[] = [];
  const thirdParty: CapturedPageError[] = [];
  for (const error of errors) {
    (isThirdPartyOnlyStack(error.stack, ownHost) ? thirdParty : own).push(error);
  }
  return { own, thirdParty };
}

export function ownHostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}

export function firstPageErrorFrameUrl(stack: string): string | null {
  return frameUrls(stack)?.[0] ?? null;
}
