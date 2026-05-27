// Cloudflare Worker — staging-only frontend for frontaliereticino.ch artifacts on R2.
//
// Hard rules baked into responses (never disable):
//   1. x-robots-tag: noindex, nofollow on every response (block search engines on staging)
//   2. /robots.txt always returns "Disallow: /" (regardless of object in bucket)
//   3. /sitemap*  is short-circuited to 404 (block sitemap discovery)
//
// Prod must use a separate Worker without these blocks.

const CONTENT_TYPE_BY_EXT = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

function contentTypeFor(key) {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function cacheControlFor(key) {
  // Hashed assets (Vite output) get aggressive caching; HTML stays short.
  if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpe?g|webp|avif|svg)$/i.test(key)) {
    return "public, max-age=31536000, immutable";
  }
  if (key.endsWith(".html")) return "public, max-age=60, s-maxage=300";
  return "public, max-age=300, s-maxage=600";
}

function withStagingHeaders(headers) {
  // ALWAYS noindex on staging. No exceptions.
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("x-staging", "1");
  return headers;
}

async function serveObject(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType ?? contentTypeFor(key));
  headers.set("cache-control", cacheControlFor(key));
  if (obj.httpEtag) headers.set("etag", obj.httpEtag);
  if (obj.size != null) headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: withStagingHeaders(headers) });
}

async function serve404(env) {
  const fb = await env.BUCKET.get("404.html");
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  return new Response(fb?.body ?? "<h1>404</h1>", {
    status: 404,
    headers: withStagingHeaders(headers),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Block crawlers explicitly via robots.txt
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: withStagingHeaders(
          new Headers({ "content-type": "text/plain; charset=utf-8" }),
        ),
      });
    }

    // Hide sitemaps entirely on staging
    if (url.pathname.startsWith("/sitemap")) {
      return new Response("Not Found", {
        status: 404,
        headers: withStagingHeaders(new Headers({ "content-type": "text/plain" })),
      });
    }

    // Method gate (R2 is read-only via this Worker)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: withStagingHeaders(new Headers({ allow: "GET, HEAD" })),
      });
    }

    let key = decodeURIComponent(url.pathname.slice(1));

    // Directory request → index.html
    if (key === "" || key.endsWith("/")) {
      key += "index.html";
    }

    // Try exact key, then directory-style fallback (path → path/index.html)
    let res = await serveObject(env, key);
    if (!res && !key.endsWith(".html") && !key.includes(".")) {
      res = await serveObject(env, `${key}/index.html`);
    }

    return res ?? (await serve404(env));
  },
};
