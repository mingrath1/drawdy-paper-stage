# Paper Stage backend

The Stage Durable Object behind Paper Stage. One object per stage relays the scene from the elected driver to every 3D view, relays poses between walkers, and serves cutout PNGs. It started from [earendil-works/pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) at `dcb56ce` (MIT, see `LICENSE`) and keeps its hibernating WebSockets, recovery alarms, and requestId receipts on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

The wire protocol is `../shared/protocol.ts`.

## Routes

- `GET /api/health` returns `{ ok: true, protocol }`.
- `GET /api/stages/:stageId` upgrades to the stage WebSocket. The first frame must be `hello`.
- `GET /api/stages/:stageId/assets/:hash?token=` returns a cutout PNG to any origin, cached as immutable.

## What the Stage stores

- `app.stage` holds the frame, the items keyed by element id, and the revision.
- `app.stage-control` holds the SHA-256 of the stage token, the elected writer and its epoch, and the index of stored PNGs.
- `app.stage-asset` holds one PNG per hash. The store keeps up to twice `MAX_CUTOUTS_PER_STAGE` and evicts the oldest PNG no item references.
- `app.stage-commit-receipt` maps each applied commit's requestId to its revision.

Poses, cursors, and rate budgets are never stored. A view's last pose rides in its socket attachment, so it survives hibernation.

## Commands

```sh
npm install
npm run dev      # wrangler dev
npm test         # vitest in the Workers runtime
npm run check    # format, generated types, tsc, deploy dry run
npm run deploy   # wrangler deploy
node tools/latency.mjs https://<worker-host>   # pose latency through a deployed Stage
```
