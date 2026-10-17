import { describe, expect, it } from "vitest";
import {
  type ClientMessage,
  type ErrorCode,
  MAX_ASSET_BASE64,
  MAX_ASSET_SIDE_PX,
  MAX_CUTOUTS_PER_STAGE,
  MAX_FRAME_CHARACTERS,
  MAX_ITEMS_PER_COMMIT,
  MAX_NAME_CHARS,
  parseClientMessage,
  parseServerMessage,
  ProtocolError,
  type ServerMessage,
  type StageItem,
} from "../../shared/protocol.ts";

const hash = "a".repeat(64);
const participant = { presenceId: "presence-1", name: "Mai", color: "#ff7a00" };
const wall: StageItem = {
  kind: "wall",
  id: "wall-1",
  rect: { x: 0, y: 0, width: 300, height: 10 },
  shape: "rect",
  rotation: 0.5,
  color: "#333333",
};
const cutout: StageItem = {
  kind: "cutout",
  id: "cutout-1",
  rect: { x: 40, y: 40, width: 80, height: 60 },
  asset: { hash, width: 160, height: 120 },
  meshUrl: "https://example.com/mesh.glb",
};
const pawn: StageItem = { kind: "pawn", id: "pawn-1", x: 10, y: -20 };

const clientMessages: ClientMessage[] = [
  { type: "hello", v: 2, stageId: "stage-1", token: "secret", role: "driver", participant },
  {
    type: "scene.commit",
    requestId: "r1",
    epoch: 3,
    reset: true,
    frame: { x: -100, y: -100, width: 800, height: 600 },
    upserts: [wall, cutout, pawn],
    removes: ["gone"],
  },
  { type: "scene.commit", requestId: "r2", epoch: 3, upserts: [], removes: [] },
  {
    type: "asset.put",
    requestId: "r3",
    epoch: 3,
    hash,
    width: 1,
    height: MAX_ASSET_SIDE_PX,
    pngBase64: "iVBORw0KGgo=",
  },
  { type: "pose", pose: { x: 1.5, y: -2, heading: Math.PI, pitch: -1.4 } },
  { type: "cursors", epoch: 3, cursors: [{ ...participant, x: 4, y: 5 }] },
  { type: "ping", t: 1234.5 },
];

const serverMessages: ServerMessage[] = [
  {
    type: "welcome",
    v: 2,
    connectionId: "c1",
    writer: { connectionId: null, epoch: 0 },
    snapshot: {
      revision: 7,
      frame: { x: 0, y: 0, width: 10, height: 10 },
      items: [wall, cutout, pawn],
    },
    walkers: [{ connectionId: "c2", participant, pose: { x: 0, y: 0, heading: 0, pitch: 0 } }],
  },
  { type: "writer", writer: { connectionId: "c1", epoch: 4 } },
  { type: "ack", requestId: "r1", ok: true, revision: 8 },
  { type: "ack", requestId: "r1", ok: false, error: "missing_asset", message: "no such asset" },
  {
    type: "scene.patch",
    revision: 8,
    reset: true,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    upserts: [wall],
    removes: ["x"],
  },
  { type: "scene.patch", revision: 9, upserts: [], removes: [] },
  {
    type: "walker",
    walker: { connectionId: "c2", participant, pose: { x: 1, y: 2, heading: -1, pitch: 1 } },
  },
  { type: "walker.left", connectionId: "c2" },
  { type: "cursors", cursors: [{ ...participant, x: 1, y: 2 }] },
  { type: "pong", t: 99 },
  { type: "error", code: "limit", message: "" },
];

function codeOf(parse: (raw: string) => unknown, raw: string): ErrorCode {
  try {
    parse(raw);
  } catch (error) {
    if (error instanceof ProtocolError) return error.code;
    throw error;
  }
  throw new Error(`accepted ${raw.slice(0, 200)}`);
}

const clientCode = (message: unknown): ErrorCode =>
  codeOf(parseClientMessage, typeof message === "string" ? message : JSON.stringify(message));
const serverCode = (message: unknown): ErrorCode =>
  codeOf(parseServerMessage, typeof message === "string" ? message : JSON.stringify(message));

const commit = (overrides: Record<string, unknown>) => ({
  type: "scene.commit",
  requestId: "r",
  epoch: 1,
  upserts: [],
  removes: [],
  ...overrides,
});

describe("parseClientMessage", () => {
  it.each(clientMessages.map((message) => [message.type, message] as const))(
    "accepts a valid %s",
    (_type, message) => {
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    },
  );

  it("rejects frames that are not a known JSON object", () => {
    expect(clientCode("{")).toBe("bad_message");
    expect(clientCode("[]")).toBe("bad_message");
    expect(clientCode({ type: "welcome" })).toBe("bad_message");
    expect(clientCode({ type: "toString" })).toBe("bad_message");
  });

  it("rejects a frame over MAX_FRAME_CHARACTERS as too large", () => {
    const raw = JSON.stringify({ type: "ping", t: 1, pad: "x".repeat(MAX_FRAME_CHARACTERS) });
    expect(clientCode(raw)).toBe("too_large");
  });

  it("rejects unknown and missing fields", () => {
    expect(clientCode({ type: "ping", t: 1, extra: true })).toBe("bad_message");
    expect(clientCode('{"type":"ping","t":1,"__proto__":{}}')).toBe("bad_message");
    expect(clientCode({ type: "ping" })).toBe("bad_message");
    expect(clientCode(commit({ upserts: [{ ...wall, height: 3 }] }))).toBe("bad_message");
  });

  it("reports a hello from another protocol version as a version error before checking its fields", () => {
    expect(
      clientCode({ type: "hello", v: 1, stageId: "s", token: "t", role: "driver", participant }),
    ).toBe("version");
    expect(clientCode({ type: "hello", v: 3 })).toBe("version");
    expect(clientCode({ type: "hello" })).toBe("version");
  });

  it("validates hello fields", () => {
    const hello = { type: "hello", v: 2, stageId: "s", token: "t", role: "driver", participant };
    expect(clientCode({ ...hello, role: "admin" })).toBe("bad_message");
    expect(clientCode({ ...hello, token: "" })).toBe("bad_message");
    expect(
      clientCode({
        ...hello,
        participant: { ...participant, name: "n".repeat(MAX_NAME_CHARS + 1) },
      }),
    ).toBe("bad_message");
    expect(
      parseClientMessage(JSON.stringify({ ...hello, participant: { ...participant, name: "" } })),
    ).toMatchObject({
      participant: { name: "" },
    });
  });

  it("rejects numbers that are not finite or out of range", () => {
    expect(clientCode('{"type":"ping","t":1e999}')).toBe("bad_message");
    expect(clientCode({ type: "ping", t: "1" })).toBe("bad_message");
    expect(clientCode({ type: "pose", pose: { x: 0, y: 0, heading: 3.2, pitch: 0 } })).toBe(
      "bad_message",
    );
    expect(clientCode({ type: "pose", pose: { x: 0, y: 0, heading: 0, pitch: 1.5 } })).toBe(
      "bad_message",
    );
    expect(clientCode(commit({ epoch: -1 }))).toBe("bad_message");
    expect(clientCode(commit({ epoch: 1.5 }))).toBe("bad_message");
    expect(clientCode(commit({ upserts: [{ ...wall, rect: { ...wall.rect, width: -1 } }] }))).toBe(
      "bad_message",
    );
  });

  it("limits a commit to MAX_ITEMS_PER_COMMIT changes", () => {
    const walls = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({ ...wall, id: `${prefix}${index}` }));
    const half = MAX_ITEMS_PER_COMMIT / 2;
    expect(
      parseClientMessage(
        JSON.stringify(
          commit({ upserts: walls(half, "a"), removes: walls(half, "b").map((w) => w.id) }),
        ),
      ),
    ).toMatchObject({ type: "scene.commit" });
    expect(clientCode(commit({ upserts: walls(MAX_ITEMS_PER_COMMIT + 1, "a") }))).toBe("too_large");
    expect(
      clientCode(
        commit({ upserts: walls(half + 1, "a"), removes: walls(half, "b").map((w) => w.id) }),
      ),
    ).toBe("too_large");
  });

  it("rejects a commit that names an element twice", () => {
    expect(clientCode(commit({ upserts: [wall, wall] }))).toBe("bad_message");
    expect(clientCode(commit({ upserts: [wall], removes: [wall.id] }))).toBe("bad_message");
  });

  it("accepts reset only as true", () => {
    expect(clientCode(commit({ reset: false }))).toBe("bad_message");
  });

  it("validates stage items", () => {
    expect(clientCode(commit({ upserts: [{ ...wall, kind: "door" }] }))).toBe("bad_message");
    expect(clientCode(commit({ upserts: [{ ...wall, shape: "star" }] }))).toBe("bad_message");
    expect(clientCode(commit({ upserts: [{ ...cutout, rotation: 1 }] }))).toBe("bad_message");
    expect(
      clientCode(commit({ upserts: [{ ...cutout, meshUrl: "http://example.com/m.glb" }] })),
    ).toBe("bad_message");
    expect(
      clientCode(
        commit({ upserts: [{ ...cutout, asset: { ...cutout.asset, hash: "A".repeat(64) } }] }),
      ),
    ).toBe("bad_message");
    expect(
      clientCode(
        commit({
          upserts: [{ ...cutout, asset: { ...cutout.asset, width: MAX_ASSET_SIDE_PX + 1 } }],
        }),
      ),
    ).toBe("bad_message");
  });

  it("validates asset uploads", () => {
    const put = {
      type: "asset.put",
      requestId: "r",
      epoch: 1,
      hash,
      width: 10,
      height: 10,
      pngBase64: "iVBORw0KGgo=",
    };
    expect(clientCode({ ...put, pngBase64: "A".repeat(MAX_ASSET_BASE64 + 4) })).toBe("too_large");
    expect(clientCode({ ...put, pngBase64: "iVBORw0KGgo" })).toBe("bad_message");
    expect(clientCode({ ...put, pngBase64: "iVBO Rw0KGgo=" })).toBe("bad_message");
    expect(clientCode({ ...put, pngBase64: "" })).toBe("bad_message");
    expect(clientCode({ ...put, width: 0 })).toBe("bad_message");
    expect(clientCode({ ...put, hash: "abc" })).toBe("bad_message");
  });
});

describe("parseServerMessage", () => {
  it.each(serverMessages.map((message) => [message.type, message] as const))(
    "accepts a valid %s",
    (_type, message) => {
      expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    },
  );

  it("reports a welcome from another protocol version as a version error", () => {
    expect(serverCode({ ...serverMessages[0], v: 1 })).toBe("version");
  });

  it("validates acks by their ok flag", () => {
    expect(serverCode({ type: "ack", requestId: "r", ok: true, revision: 1, error: "limit" })).toBe(
      "bad_message",
    );
    expect(serverCode({ type: "ack", requestId: "r", ok: false, error: "nope", message: "" })).toBe(
      "bad_message",
    );
    expect(
      serverCode({ type: "ack", requestId: "r", ok: "yes", error: "limit", message: "" }),
    ).toBe("bad_message");
  });

  it("limits a snapshot to MAX_CUTOUTS_PER_STAGE cutouts", () => {
    const items = Array.from({ length: MAX_CUTOUTS_PER_STAGE + 1 }, (_, index) => ({
      ...cutout,
      id: `c${index}`,
    }));
    const welcome = serverMessages[0] as Extract<ServerMessage, { type: "welcome" }>;
    expect(serverCode({ ...welcome, snapshot: { ...welcome.snapshot, items } })).toBe("too_large");
  });

  it("rejects unknown error codes and client-only message types", () => {
    expect(serverCode({ type: "error", code: "teapot", message: "" })).toBe("bad_message");
    expect(serverCode({ type: "ping", t: 1 })).toBe("bad_message");
  });
});
