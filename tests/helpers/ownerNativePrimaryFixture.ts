import { EventEmitter } from 'node:events';

/** Only DNS/HTTPS I/O is synthetic; callers retain the actual pinned transport, AST parser and target codec. */
export function primaryPostingFixture(read: Function, input: { applyUrl: string; jobTitle: string }, options: Record<string, any>, title: string) {
  const html = `<h1>${title}</h1><form method="post" action="${input.applyUrl}"><input name="first_name"><input name="last_name"><input type="email" name="email"><input type="file" name="cv"><button type="submit">Send application</button></form>`;
  return read(input, { ...options, resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    requestImpl: (_url: URL, _options: any, callback: Function) => {
      const request: any = new EventEmitter();
      request.destroy = (error: Error) => request.emit('error', error);
      request.end = () => queueMicrotask(() => {
        const response: any = new EventEmitter(); response.statusCode = 200; response.headers = { 'content-type': 'text/html' };
        callback(response); response.emit('data', Buffer.from(html)); response.emit('end');
      });
      return request;
    },
  });
}

/** Untrusted wire fixture: the server still derives ownership from its independently fetched posting. */
export function ownerTargetFixture(url: string) {
  return { version: 'native-application-target-v1', documentUrl: url, protocol: null,
    control: { aaId: 'submit', htmlId: '', name: '', value: '', tag: 'button', type: 'submit', label: 'Send application', href: '',
      rawHref: null, inlineHandler: '', formRelation: 'native', lookupCount: 1, connected: true, disabled: false, visible: true },
    form: { aaId: '', htmlId: '', name: '', markerCount: 1, action: url, method: 'post', target: '', enctype: 'application/x-www-form-urlencoded',
      controls: [{ tag: 'button', type: 'submit', name: '', autocomplete: '' },
        { tag: 'input', type: 'email', name: 'email', autocomplete: '' }, { tag: 'input', type: 'file', name: 'cv', autocomplete: '' },
        { tag: 'input', type: 'text', name: 'first_name', autocomplete: '' }, { tag: 'input', type: 'text', name: 'last_name', autocomplete: '' }],
      hasFiles: false, jobKeys: [], instanceKeys: [], operationKeys: [], invalidKeys: false },
    overrides: { actionPresent: false, methodPresent: false, targetPresent: false, enctypePresent: false, action: '', method: '', target: '', enctype: '' },
    destination: { kind: 'native_submit', url, method: 'post', target: '', enctype: 'application/x-www-form-urlencoded' } };
}
