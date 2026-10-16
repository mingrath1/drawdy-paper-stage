# Paper Stage backend

The Stage Durable Object behind Paper Stage. One object per stage relays the scene from the elected driver to every 3D view, relays poses between walkers, and serves cutout PNGs. It started from [earendil-works/pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) at `dcb56ce` (MIT, see `LICENSE`) and keeps its hibernating WebSockets, recovery alarms, and requestId receipts on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

The wire protocol is `../shared/protocol.ts`.

## Routes

- `GET /api/health` returns `{ ok: true, protocol }`.
- `GET /api/stages/:stageId` upgrades to the stage WebSocket. The first frame must be `hello`.
- `GET /api/stages/:stageId/assets/:hash?token=` returns a cutout PNG to any origin, cached privately as immutable. Logs and traces drop the query string, so the token stays out of them.

## What the Stage stores

- `app.stage` holds the frame, the items keyed by element id, and the revision.
- `app.stage-control` holds the SHA-256 of the stage token, the elected writer and its epoch, and the index of stored PNGs.
- `app.stage-asset` holds one PNG per hash. The store keeps up to twice `MAX_CUTOUTS_PER_STAGE` and evicts the oldest PNG no item references.
- `app.stage-commit-receipts` holds the newest 256 accepted commits, each keyed by writer epoch and requestId with a digest of its payload. A resend of the same commit gets its first ack. A reused requestId with another payload gets `bad_message`.

The scene, control, and receipts documents store a full copy every 32 changes, so a load replays at most 32 deltas. A commit that changes nothing keeps the revision and sends no patch.

Poses, cursors, and rate budgets are never stored. A view's last pose and a driver's last frame time ride in the socket attachment, so they survive hibernation.

## Limits

- A stage holds 64 sockets, and one `presenceId` holds 8 of them. A socket past either cap closes with 1013, which clients retry with backoff.
- A socket that sends no `hello` within 10 s closes with 1008. An alarm sweep enforces it, so no timer keeps the object awake.
- A socket may send 60 frames a second, and the elected writer 150. The Stage parses each frame and spends the budget as the frame arrives. Past the budget, poses and cursors drop silently, `scene.commit` and `asset.put` get an `ack` with error `limit` in order, and other frames drop with at most one `limit` error a second. Malformed and oversized frames close with their code whatever the budget. A socket with 200 frames still waiting closes with 1008.
- A writer that sends no frame for 30 s loses its seat. The election runs again on every driver `hello`, every refused writer request, every alarm sweep, and the first frame from a driver while the seat is empty.

## Commands

```sh
npm install
npm run dev      # wrangler dev
npm test         # vitest in the Workers runtime
npm run check    # format, generated types, tsc, deploy dry run
npm run deploy   # wrangler deploy
node tools/latency.mjs https://<worker-host>   # pose latency through a deployed Stage
```
