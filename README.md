# Paper Stage

Step inside the floor plan you drew on a Drawdy board. Rectangles rise as walls, doodles and stickies stand up as paper cutouts, and friends who keep drawing reach into the 3D view as giant hands.

Work in progress. See `docs/` in the planning repo for the plan.

## Layout

- `src/` is the Drawdy driver. Drawdy builds `src/index.ts` with esbuild.
- `view/` is the 3D view, bundled into `src/view-html.ts` by `scripts/build-view.mjs`.
- `shared/protocol.ts` is the wire protocol used by all three parts.
- `backend/` is the Stage Durable Object, started from [earendil-works/pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) (MIT) at commit `dcb56ce`.
