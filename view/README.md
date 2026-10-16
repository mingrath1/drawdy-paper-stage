# 3D view

The view is the walkable stage that opens in a floating iframe on the Drawdy board. The iframe is sandboxed to `allow-scripts`, so the view has origin `null`, no pointer lock, and no channel to the driver. It connects straight to the Stage object over a WebSocket and fetches cutout pictures over HTTPS.

## Build

Drawdy builds only `src/index.ts` and allows no runtime npm dependencies. `npm run build:view` bundles `view/main.ts`, the vendored three.js, and `shared/protocol.ts` into one inline script and writes `src/view-html.ts`. The driver calls its `buildViewHtml(boot)` to get the iframe's `srcDoc`. Commit the generated file with the change that produced it. `npm test` fails when it is stale.

## Files

- `main.ts` wires the renderer, the socket, and the frame loop.
- `stage.ts` keeps one object per stage item and glides moved items into place.
- `layout.ts` turns stage items into floor positions, wall outlines, and collision edges.
- `walk.ts` moves the camera with keys and click-and-drag.
- `bodies.ts` and `hands.ts` show other people as paper dolls and glowing hands.
- `paper.ts` cuts a captured picture out of its board background.
- `link.ts` holds the socket, its reconnect backoff, and the close codes that stop it.

## Develop

`npm run dev:view` starts a fake Stage object and serves the view at `http://localhost:5180/?stage=demo`, inside the same sandboxed iframe Drawdy uses. Stage `demo` is a two-room plan where a walker circles and a hand drags the cart. Stage `perf` has 40 walls and 30 cutouts. `/bare?stage=perf` serves the view document on its own.

`ego-browser nodejs < view/dev/measure-fps.ego.mjs` measures frame rate on the perf stage while the dev server runs. It writes `/tmp/paper-stage-view/fps.json`.
