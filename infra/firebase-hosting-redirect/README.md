# Firebase Hosting redirect
This tiny tracked directory is the Firebase Hosting public root; Hosting remains only for Google Authentication's reserved `/__/` endpoints, and the old `dist/` SPA must not be published again.
RE2 has no lookahead, so the regex excludes paths beginning with `/__`; Hosting continues to serve `/__/auth/*` and `/__/firebase/*`.
It was verified on a real Firebase preview channel; the local emulator does not execute regex redirects or reproduce `/__/` priority and is not reliable for this check.
All other requests permanently redirect to Cloudflare production at `https://frontaliereticino.ch/`.
