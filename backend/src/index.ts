import { PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { type Stage, STAGE_ID_HEADER } from "./stage.ts";

export { Stage } from "./stage.ts";

// The driver and the 3D view both run with origin `null`, so every response allows any origin.
const CORS = { "Access-Control-Allow-Origin": "*" };

const json = (body: unknown, status: number, headers?: Record<string, string>): Response =>
  Response.json(body, { status, headers: { ...CORS, ...headers } });

const stageRoute = /^\/api\/stages\/([^/]+)(?:\/assets\/([0-9a-f]{64}))?\/?$/;

const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

async function readAsset(
  stage: DurableObjectStub<Stage>,
  hash: string,
  token: string,
): Promise<Response> {
  const asset = await stage.readAsset(token, hash);
  switch (asset.status) {
    case "found":
      return new Response(asset.png, {
        headers: {
          ...CORS,
          "Content-Type": "image/png",
          // Content-addressed: the bytes behind a hash never change.
          "Cache-Control": "public, max-age=31536000, immutable",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    case "forbidden":
      return json({ error: "Bad token" }, 403, { "Cache-Control": "no-store" });
    case "missing":
      return json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok: true, protocol: PROTOCOL_VERSION }, 200);

    const match = stageRoute.exec(url.pathname);
    if (match === null) return json({ error: "Not found" }, 404);
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    const stageId = decodeSegment(match[1]!);
    if (stageId === undefined) return json({ error: "Bad stage id" }, 400);
    const stage = env.STAGES.getByName(stageId);

    const hash = match[2];
    if (hash !== undefined) return readAsset(stage, hash, url.searchParams.get("token") ?? "");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }
    const upgrade = new Request(request);
    upgrade.headers.set(STAGE_ID_HEADER, stageId);
    return stage.fetch(upgrade);
  },
} satisfies ExportedHandler<Env>;
