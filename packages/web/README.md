# @synapse/web

The 3D graph viewer and Q&A interface, built with React, react-three-fiber and
d3-force-3d.

It is served by `synapse serve`, which builds a graph if there is none, starts the API
and serves this app's production build. To work on the UI itself, run the API separately
and use the Vite dev server, which proxies `/api` to it:

```bash
node packages/cli/dist/src/index.js serve . --no-open   # API on :4317
npm run dev --workspace @synapse/web                    # UI on :5317
```

Two pages: `/` is the overview and `/graph` is the explorer. There is no router
dependency; `src/router.tsx` is the whole of it.

The overview's hero renders `src/landing/sample-graph.json`, a trimmed analysis of this
repository. Regenerate it after the codebase changes shape:

```bash
node packages/cli/dist/src/index.js analyze . --skip-summarize --out /tmp/self
npm run sample-graph --workspace @synapse/web -- /tmp/self/graph.json
```

The GitHub URL every link on both pages uses is set in `src/site.ts`.

## Before hosting the overview on a domain

These need an absolute URL, so they wait for the domain:

- `<link rel="canonical">` and `og:url` in `index.html`
- `og:image` (1200×630) and switching `twitter:card` to `summary_large_image`
- `sitemap.xml` listing `/`, and its `Sitemap:` line in `public/robots.txt`
- Submitting the sitemap to Google Search Console

HTTPS comes from the host. `synapse serve` already sends the security headers, the
DNS-rebinding guard and precompressed assets; a static host needs its own equivalents
of the headers (a `_headers` file on Netlify or Cloudflare Pages, `vercel.json` on Vercel).
