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
