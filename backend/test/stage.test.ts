import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CLOSE,
  MAX_CUTOUTS_PER_STAGE,
  MAX_FRAME_CHARACTERS,
  MAX_ITEMS_PER_COMMIT,
  MAX_ITEMS_PER_STAGE,
  parseServerMessage,
  type Pose,
  type Role,
  type ServerMessage,
  type StageItem,
} from "../../shared/protocol.ts";

const TOKEN = "stage-token";
let stageCounter = 0;
const freshStage = () => `stage-${Date.now()}-${stageCounter++}`;

type Message<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

class Client {
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #inbox: ServerMessage[] = [];
  #wake: (() => void) | undefined;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.accept();
    socket.addEventListener("message", (event) => {
      // Every frame the Stage sends must satisfy the shared protocol.
      this.#inbox.push(parseServerMessage(event.data as string));
      this.#wake?.();
    });
    this.closed = new Promise((resolve) =>
      socket.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
        this.#wake?.();
      }),
    );
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  async next(): Promise<ServerMessage> {
    const deadline = Date.now() + 3_000;
    while (this.#inbox.length === 0) {
      if (Date.now() > deadline) throw new Error("no message within 3 s");
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    return this.#inbox.shift()!;
  }

  async expect<T extends ServerMessage["type"]>(type: T): Promise<Message<T>> {
    const message = await this.next();
    expect(message.type).toBe(type);
    return message as Message<T>;
  }

  /** Proves nothing else is queued: the next frame after a ping must be its pong. */
  async expectQuiet(): Promise<void> {
    const t = Math.random();
    this.send({ type: "ping", t });
    expect(await this.next()).toEqual({ type: "pong", t });
  }

  close(): void {
    this.socket.close(1000, "done");
  }
}

async function connect(stageId: string): Promise<Client> {
  const response = await exports.default.fetch(`https://example.com/api/stages/${stageId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  return new Client(response.webSocket!);
}

const participant = (name: string) => ({ presenceId: `presence-${name}`, name, color: "#ff7a00" });

const hello = (stageId: string, role: Role, token = TOKEN, name: string = role) => ({
  type: "hello",
  v: 2,
  stageId,
  token,
  role,
  participant: participant(name),
});

async function join(stageId: string, role: Role, name: string = role) {
  const client = await connect(stageId);
  client.send(hello(stageId, role, TOKEN, name));
  const welcome = await client.expect("welcome");
  return { client, welcome };
}

/** The first driver of a fresh stage, after its election. */
async function writerOf(stageId: string) {
  const { client, welcome } = await join(stageId, "driver");
  const { writer } = await client.expect("writer");
  expect(writer.connectionId).toBe(welcome.connectionId);
  return { client, epoch: writer.epoch, connectionId: welcome.connectionId };
}

const wall = (id: string, x = 0): StageItem => ({
  kind: "wall",
  id,
  rect: { x, y: 0, width: 300, height: 10 },
  shape: "rect",
  rotation: 0,
});

const commit = (epoch: number, requestId: string, fields: Record<string, unknown>) => ({
  type: "scene.commit",
  requestId,
  epoch,
  upserts: [],
  removes: [],
  ...fields,
});

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Bytes with a PNG signature and IHDR, which is all the Stage reads. */
async function png(width: number, height: number, salt: number) {
  const bytes = new Uint8Array(37);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(33, salt);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes, hash, width, height, pngBase64: toBase64(bytes) };
}

const put = (epoch: number, requestId: string, asset: Awaited<ReturnType<typeof png>>) => ({
  type: "asset.put",
  requestId,
  epoch,
  hash: asset.hash,
  width: asset.width,
  height: asset.height,
  pngBase64: asset.pngBase64,
});

const cutout = (id: string, asset: { hash: string; width: number; height: number }): StageItem => ({
  kind: "cutout",
  id,
  rect: { x: 10, y: 10, width: 40, height: 40 },
  asset: { hash: asset.hash, width: asset.width, height: asset.height },
});

const pose = (x: number): Pose => ({ x, y: 2, heading: 0.5, pitch: 0.1 });

describe("Worker routes", () => {
  it("answers health checks from any origin", async () => {
    const response = await exports.default.fetch("https://example.com/api/health", {
      headers: { Origin: "null" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ ok: true, protocol: 2 });
  });

  it("requires a WebSocket upgrade on the stage route", async () => {
    const response = await exports.default.fetch("https://example.com/api/stages/x");
    expect(response.status).toBe(426);
  });
});

describe("hello", () => {
  it("lets the first driver set the token and admits later sockets only with it", async () => {
    const stageId = freshStage();
    await writerOf(stageId);

    const { welcome } = await join(stageId, "view");
    expect(welcome.v).toBe(2);

    const intruder = await connect(stageId);
    intruder.send(hello(stageId, "driver", "wrong-token"));
    expect(await intruder.expect("error")).toMatchObject({ code: "bad_token" });
    expect((await intruder.closed).code).toBe(CLOSE.badToken);

    const lurker = await connect(stageId);
    lurker.send(hello(stageId, "view", "wrong-token"));
    expect((await lurker.closed).code).toBe(CLOSE.badToken);
  });

  it("closes a view that arrives before any driver so it can retry", async () => {
    const stageId = freshStage();
    const early = await connect(stageId);
    early.send(hello(stageId, "view"));
    expect(await early.expect("error")).toMatchObject({ code: "uninitialized" });
    expect((await early.closed).code).toBe(CLOSE.uninitialized);

    await writerOf(stageId);
    await join(stageId, "view");
  });

  it("closes a hello from another protocol version", async () => {
    const stageId = freshStage();
    const client = await connect(stageId);
    client.send({ ...hello(stageId, "driver"), v: 1 });
    expect(await client.expect("error")).toMatchObject({ code: "version" });
    expect((await client.closed).code).toBe(CLOSE.badVersion);
  });

  it("requires hello before anything else and a stage ID that matches the URL", async () => {
    const stageId = freshStage();
    const early = await connect(stageId);
    early.send({ type: "ping", t: 1 });
    expect((await early.closed).code).toBe(CLOSE.malformed);

    const lost = await connect(stageId);
    lost.send(hello("another-stage", "driver"));
    expect((await lost.closed).code).toBe(CLOSE.malformed);
  });

  it("closes malformed and oversized frames and keeps serving other sockets", async () => {
    const stageId = freshStage();
    const { client: writer } = await writerOf(stageId);

    const garbled = await connect(stageId);
    garbled.send("{not json");
    expect((await garbled.closed).code).toBe(CLOSE.malformed);

    const bloated = await connect(stageId);
    bloated.send(JSON.stringify({ type: "ping", t: 1, pad: "x".repeat(MAX_FRAME_CHARACTERS) }));
    expect((await bloated.closed).code).toBe(CLOSE.tooLarge);

    await writer.expectQuiet();
  });
});

describe("scene", () => {
  it("welcomes a new socket with the committed snapshot", async () => {
    const stageId = freshStage();
    const { client, epoch } = await writerOf(stageId);
    const frame = { x: -50, y: -50, width: 900, height: 700 };
    client.send(
      commit(epoch, "r1", { reset: true, frame, upserts: [wall("a"), wall("b"), wall("c")] }),
    );
    expect(await client.expect("ack")).toEqual({
      type: "ack",
      requestId: "r1",
      ok: true,
      revision: 1,
    });

    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot).toEqual({
      revision: 1,
      frame,
      items: [wall("a"), wall("b"), wall("c")],
    });
  });

  it("acks a repeated requestId with its first revision and applies it once", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const { client: view } = await join(stageId, "view");

    writer.send(commit(epoch, "same", { upserts: [wall("a")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    writer.send(commit(epoch, "same", { upserts: [wall("a")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });

    expect(await view.expect("scene.patch")).toEqual({
      type: "scene.patch",
      revision: 1,
      upserts: [wall("a")],
      removes: [],
    });
    await view.expectQuiet();

    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot.items).toEqual([wall("a")]);
    expect(welcome.snapshot.revision).toBe(1);
  });

  it("applies removes and resets in the patch it broadcasts", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const { client: view } = await join(stageId, "view");
    writer.send(commit(epoch, "r1", { upserts: [wall("a"), wall("b")] }));
    await writer.expect("ack");
    writer.send(commit(epoch, "r2", { removes: ["a"] }));
    await writer.expect("ack");
    writer.send(commit(epoch, "r3", { reset: true, upserts: [wall("c")] }));
    await writer.expect("ack");
    await view.expect("scene.patch");
    expect(await view.expect("scene.patch")).toMatchObject({ revision: 2, removes: ["a"] });
    expect(await view.expect("scene.patch")).toMatchObject({ revision: 3, reset: true });

    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot.items).toEqual([wall("c")]);
  });

  it("refuses commits past MAX_ITEMS_PER_STAGE", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const batches = MAX_ITEMS_PER_STAGE / MAX_ITEMS_PER_COMMIT;
    for (let batch = 0; batch < batches; batch++) {
      const upserts = Array.from({ length: MAX_ITEMS_PER_COMMIT }, (_, index) =>
        wall(`w${batch}-${index}`),
      );
      writer.send(commit(epoch, `fill-${batch}`, { upserts }));
      expect(await writer.expect("ack")).toMatchObject({ ok: true });
    }
    writer.send(commit(epoch, "one-more", { upserts: [wall("extra")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "limit" });
    writer.send(commit(epoch, "swap", { upserts: [wall("extra")], removes: ["w0-0"] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });
  });

  it("refuses commits past MAX_CUTOUTS_PER_STAGE", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const asset = await png(32, 32, 1);
    writer.send(put(epoch, "asset", asset));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });
    const cutouts = (count: number) =>
      Array.from({ length: count }, (_, index) => cutout(`c${index}`, asset));

    writer.send(commit(epoch, "too-many", { upserts: cutouts(MAX_CUTOUTS_PER_STAGE + 1) }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "limit" });
    writer.send(commit(epoch, "at-cap", { upserts: cutouts(MAX_CUTOUTS_PER_STAGE) }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });
  });

  it("keeps the stored deltas of every stage document bounded across many commits", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    for (let index = 0; index < 50; index++) {
      writer.send(commit(epoch, `move-${index}`, { upserts: [wall("a", index)] }));
      expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: index + 1 });
    }

    const revisions = await runInDurableObject(env.STAGES.getByName(stageId), (_instance, state) =>
      state.storage.sql
        .exec<{ doc: string; rows: number }>(
          `SELECT json_extract(d.kind, '$') AS doc, COUNT(*) AS rows FROM document_revisions r
            JOIN documents d ON d.id = r.document_id GROUP BY d.id HAVING doc LIKE 'app.stage%'`,
        )
        .toArray(),
    );
    expect(revisions.map(({ doc }) => doc)).toContain("app.stage");
    expect(revisions.filter(({ rows }) => rows > 33)).toEqual([]);

    await evictDurableObject(env.STAGES.getByName(stageId));
    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot).toMatchObject({ revision: 50, items: [wall("a", 49)] });
  });

  it("survives eviction of the Durable Object", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const asset = await png(20, 10, 7);
    writer.send(put(epoch, "asset", asset));
    await writer.expect("ack");
    const items = [wall("a"), cutout("doodle", asset), { kind: "pawn", id: "pawn", x: 5, y: 6 }];
    const frame = { x: 0, y: 0, width: 400, height: 300 };
    writer.send(commit(epoch, "r1", { reset: true, frame, upserts: items }));
    await writer.expect("ack");

    await evictDurableObject(env.STAGES.getByName(stageId));

    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot).toEqual({ revision: 1, frame, items });
    const image = await exports.default.fetch(
      `https://example.com/api/stages/${stageId}/assets/${asset.hash}?token=${TOKEN}`,
    );
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(asset.bytes);
  });
});

describe("commit receipts", () => {
  it("fences a reused requestId by writer and epoch before answering from a receipt", async () => {
    const stageId = freshStage();
    const first = await writerOf(stageId);
    first.client.send(commit(first.epoch, "r1", { upserts: [wall("a")] }));
    expect(await first.client.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    first.client.send(commit(first.epoch - 1, "r1", { upserts: [wall("a")] }));
    expect(await first.client.expect("ack")).toMatchObject({ ok: false, error: "stale_epoch" });

    const second = await join(stageId, "driver", "second");
    second.client.send(commit(first.epoch, "r1", { upserts: [wall("a")] }));
    expect(await second.client.expect("ack")).toMatchObject({ ok: false, error: "not_writer" });

    first.client.close();
    const { writer } = await second.client.expect("writer");
    second.client.send(commit(writer.epoch, "r1", { upserts: [wall("b")] }));
    expect(await second.client.expect("ack")).toMatchObject({ ok: true, revision: 2 });
    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot.items).toEqual([wall("a"), wall("b")]);
  });

  it("refuses a requestId reused for a different commit and applies nothing", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const { client: view } = await join(stageId, "view");
    writer.send(commit(epoch, "r1", { upserts: [wall("a")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    await view.expect("scene.patch");

    writer.send(commit(epoch, "r1", { upserts: [wall("b")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "bad_message" });
    await view.expectQuiet();
    const { welcome } = await join(stageId, "view");
    expect(welcome.snapshot).toMatchObject({ revision: 1, items: [wall("a")] });
  });

  it("acks a commit that changes nothing with the current revision and broadcasts no patch", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const { client: view } = await join(stageId, "view");
    const frame = { x: 0, y: 0, width: 400, height: 300 };
    writer.send(commit(epoch, "r1", { frame, upserts: [wall("a"), wall("b")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    await view.expect("scene.patch");

    writer.send(commit(epoch, "same", { frame, upserts: [wall("a")], removes: ["gone"] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    writer.send(commit(epoch, "same-reset", { reset: true, upserts: [wall("b"), wall("a")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    writer.send(commit(epoch, "empty", {}));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    await view.expectQuiet();

    writer.send(commit(epoch, "shrink", { reset: true, upserts: [wall("a")] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true, revision: 2 });
    expect(await view.expect("scene.patch")).toMatchObject({ revision: 2, reset: true });
  });
});

describe("writer election", () => {
  it("fences commits to the elected writer and its epoch, and promotes the next driver on close", async () => {
    const stageId = freshStage();
    const first = await writerOf(stageId);
    const second = await join(stageId, "driver", "second");
    expect(second.welcome.writer).toEqual({ connectionId: first.connectionId, epoch: first.epoch });
    const { client: view } = await join(stageId, "view");

    second.client.send(commit(first.epoch, "r1", { upserts: [wall("a")] }));
    expect(await second.client.expect("ack")).toMatchObject({ ok: false, error: "not_writer" });
    first.client.send(commit(first.epoch - 1, "r2", { upserts: [wall("a")] }));
    expect(await first.client.expect("ack")).toMatchObject({ ok: false, error: "stale_epoch" });

    first.client.close();
    const promoted = await second.client.expect("writer");
    expect(promoted.writer).toEqual({
      connectionId: second.welcome.connectionId,
      epoch: first.epoch + 1,
    });
    expect((await view.expect("writer")).writer).toEqual(promoted.writer);

    second.client.send(commit(promoted.writer.epoch, "r3", { upserts: [wall("a")] }));
    expect(await second.client.expect("ack")).toMatchObject({ ok: true, revision: 1 });
  });

  it("refuses scene changes from a view", async () => {
    const stageId = freshStage();
    const { epoch } = await writerOf(stageId);
    const { client: view } = await join(stageId, "view");
    view.send(commit(epoch, "r1", { upserts: [wall("a")] }));
    expect(await view.expect("ack")).toMatchObject({ ok: false, error: "not_writer" });
  });
});

describe("assets", () => {
  it("stores a verified upload once and serves it to any origin with the stage token", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const asset = await png(64, 48, 3);
    writer.send(put(epoch, "a1", asset));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });
    writer.send(put(epoch, "a2", asset));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });

    const url = `https://example.com/api/stages/${stageId}/assets/${asset.hash}`;
    const image = await exports.default.fetch(`${url}?token=${TOKEN}`, {
      headers: { Origin: "null" },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(image.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(asset.bytes);

    expect((await exports.default.fetch(`${url}?token=wrong`)).status).toBe(403);
    expect((await exports.default.fetch(url)).status).toBe(403);
    const unknown = `https://example.com/api/stages/${stageId}/assets/${"0".repeat(64)}?token=${TOKEN}`;
    expect((await exports.default.fetch(unknown)).status).toBe(404);
  });

  it("refuses uploads whose bytes do not match their hash or size", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const asset = await png(16, 16, 9);
    writer.send(put(epoch, "wrong-hash", { ...asset, hash: "f".repeat(64) }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "bad_message" });
    writer.send(put(epoch, "wrong-size", { ...asset, width: 17 }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "bad_message" });
    writer.send(
      put(epoch, "not-png", { ...asset, pngBase64: btoa("not a png at all, really not") }),
    );
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "bad_message" });
  });

  it("refuses a cutout that references an asset never uploaded", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const asset = await png(16, 16, 11);
    writer.send(commit(epoch, "r1", { upserts: [cutout("c", asset)] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "missing_asset" });
  });

  it("evicts the oldest unreferenced asset once the store is full", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const capacity = 2 * MAX_CUTOUTS_PER_STAGE;
    const assets = await Promise.all(
      Array.from({ length: capacity + 1 }, (_, index) => png(8, 8, 1_000 + index)),
    );
    writer.send(put(epoch, "p0", assets[0]!));
    await writer.expect("ack");
    writer.send(commit(epoch, "keep-oldest", { upserts: [cutout("kept", assets[0]!)] }));
    await writer.expect("ack");
    for (let index = 1; index <= capacity; index++) {
      // Stay under the 60 messages per second budget.
      await new Promise((resolve) => setTimeout(resolve, 20));
      writer.send(put(epoch, `p${index}`, assets[index]!));
      expect(await writer.expect("ack")).toMatchObject({ ok: true });
    }

    const status = async (index: number) =>
      (
        await exports.default.fetch(
          `https://example.com/api/stages/${stageId}/assets/${assets[index]!.hash}?token=${TOKEN}`,
        )
      ).status;
    expect(await status(0)).toBe(200);
    expect(await status(1)).toBe(404);
    expect(await status(2)).toBe(200);
    expect(await status(capacity)).toBe(200);
  });

  it("counts a repeat upload as fresh, so the commit that follows still finds it", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const capacity = 2 * MAX_CUTOUTS_PER_STAGE;
    const assets = await Promise.all(
      Array.from({ length: capacity + 1 }, (_, index) => png(8, 8, 5_000 + index)),
    );
    const upload = async (index: number) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      writer.send(put(epoch, `p${index}-${Math.random()}`, assets[index]!));
      expect(await writer.expect("ack")).toMatchObject({ ok: true });
    };
    for (let index = 0; index < capacity; index++) await upload(index);
    await upload(0);
    await upload(capacity);

    writer.send(commit(epoch, "use-first", { upserts: [cutout("c", assets[0]!)] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: true });
    writer.send(commit(epoch, "use-second", { upserts: [cutout("d", assets[1]!)] }));
    expect(await writer.expect("ack")).toMatchObject({ ok: false, error: "missing_asset" });
  });
});

describe("walkers", () => {
  it("broadcasts a view's pose to every other socket and not back to the sender", async () => {
    const stageId = freshStage();
    const { client: driver } = await writerOf(stageId);
    const walkerA = await join(stageId, "view", "a");
    const { client: viewB } = await join(stageId, "view", "b");

    walkerA.client.send({ type: "pose", pose: pose(1) });
    const expected = {
      type: "walker",
      walker: {
        connectionId: walkerA.welcome.connectionId,
        participant: participant("a"),
        pose: pose(1),
      },
    };
    expect(await viewB.next()).toEqual(expected);
    expect(await driver.next()).toEqual(expected);
    await walkerA.client.expectQuiet();

    const { welcome } = await join(stageId, "view", "c");
    expect(welcome.walkers).toEqual([expected.walker]);
  });

  it("refuses poses from drivers without closing them", async () => {
    const stageId = freshStage();
    const { client: driver } = await writerOf(stageId);
    driver.send({ type: "pose", pose: pose(1) });
    expect(await driver.expect("error")).toMatchObject({ code: "bad_message" });
    await driver.expectQuiet();
  });

  it("throttles a burst of poses", async () => {
    const stageId = freshStage();
    await writerOf(stageId);
    const { client: walker } = await join(stageId, "view", "a");
    const { client: watcher } = await join(stageId, "view", "b");
    for (let index = 0; index < 20; index++) walker.send({ type: "pose", pose: pose(index) });
    await walker.expectQuiet();
    let walkers = 0;
    watcher.send({ type: "ping", t: 0 });
    while ((await watcher.next()).type === "walker") walkers++;
    expect(walkers).toBeGreaterThanOrEqual(5);
    expect(walkers).toBeLessThan(20);
  });

  it("broadcasts walker.left when a view closes", async () => {
    const stageId = freshStage();
    const { client: driver } = await writerOf(stageId);
    const leaving = await join(stageId, "view", "a");
    const { client: staying } = await join(stageId, "view", "b");
    leaving.client.close();
    const left = { type: "walker.left", connectionId: leaving.welcome.connectionId };
    expect(await staying.next()).toEqual(left);
    expect(await driver.next()).toEqual(left);
  });

  it("never writes poses to storage", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    writer.send(commit(epoch, "r1", { upserts: [wall("stored-wall-31337")] }));
    await writer.expect("ack");
    const { client: walker } = await join(stageId, "view");
    for (let index = 0; index < 5; index++) walker.send({ type: "pose", pose: pose(4242.4242) });
    await walker.expectQuiet();

    const stored = await runInDurableObject(env.STAGES.getByName(stageId), (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map(({ name }) => name)
        .filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_"));
      return tables
        .map((table) =>
          JSON.stringify(state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()),
        )
        .join("\n");
    });
    expect(stored).toContain("stored-wall-31337");
    expect(stored).not.toContain("4242.4242");
  });
});

describe("cursors", () => {
  it("relays the writer's cursors to views only and refuses them from other drivers", async () => {
    const stageId = freshStage();
    const { client: writer, epoch } = await writerOf(stageId);
    const { client: other } = await join(stageId, "driver", "other");
    const { client: view } = await join(stageId, "view");
    const cursors = [{ ...participant("friend"), x: 5, y: 6 }];

    writer.send({ type: "cursors", epoch, cursors });
    expect(await view.next()).toEqual({ type: "cursors", cursors });
    await writer.expectQuiet();
    await other.expectQuiet();

    other.send({ type: "cursors", epoch, cursors });
    expect(await other.expect("error")).toMatchObject({ code: "not_writer" });
  });
});

describe("rate limit", () => {
  it("drops frames past 60 per second with a single limit error", async () => {
    const stageId = freshStage();
    const { client } = await writerOf(stageId);
    for (let index = 0; index < 100; index++) client.send({ type: "ping", t: index });
    client.send({ type: "ping", t: -1 });

    const received: ServerMessage[] = [];
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (;;) {
      const message = await client.next().catch(() => undefined);
      if (message === undefined) break;
      received.push(message);
    }
    const errors = received.filter((message) => message.type === "error");
    const pongs = received.filter((message) => message.type === "pong");
    expect(errors).toEqual([expect.objectContaining({ code: "limit" })]);
    expect(pongs.length).toBeGreaterThanOrEqual(58);
    expect(pongs.length).toBeLessThan(70);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.expectQuiet();
  });
});
