// Wire protocol between the Drawdy driver, the Stage Durable Object, and the 3D view.
// Pure TypeScript with no imports: the driver (esbuild), the view (build-view.mjs), and the backend (wrangler) all bundle it.
//
// Trust boundary. The stage token lives in the stage frame's meta, so anyone who can read the board can join the stage.
// That matches Drawdy itself: anyone who can read the board can already edit it. Names and colors are self-reported
// and unverified.
//
// One writer. Every collaborator runs a driver, and every driver sees the same synced board. The Stage object elects
// one connected driver as the writer and fences it with an epoch. Only the writer commits the scene, uploads assets,
// and relays cursors. Other drivers stay connected and take over when the writer leaves.

export const PROTOCOL_VERSION = 2;

/** Canvas units per meter in the 3D view. A 300 px wide room on the board is 3 m wide inside. */
export const CANVAS_UNITS_PER_METER = 100;
export const WALL_HEIGHT_METERS = 2.6;
export const EYE_HEIGHT_METERS = 1.6;

/** Cloudflare caps WebSocket messages at 1 MiB. Every frame, in either direction, stays under this. */
export const MAX_FRAME_CHARACTERS = 900_000;
export const MAX_ITEMS_PER_STAGE = 400;
export const MAX_ITEMS_PER_COMMIT = 100;
export const MAX_CUTOUTS_PER_STAGE = 60;
/** The driver downscales captures so the longest side is at most this many pixels. */
export const MAX_ASSET_SIDE_PX = 512;
export const MAX_ASSET_BASE64 = 400_000;
export const MAX_NAME_CHARS = 64;
export const POSE_HZ = 20;
export const CURSOR_HZ = 20;
/** Views fade out a walker that has sent no pose for this long. */
export const WALKER_TTL_MS = 10_000;

export type ElementId = string;
export type ConnectionId = string;
/** SHA-256 of the PNG bytes, lowercase hex. */
export type AssetHash = string;

/**
 * An element's own box as Drawdy reports it (`x`, `y`, `width`, `height`), in absolute canvas units.
 * For walls this is the unrotated box; `rotation` turns it about its center.
 * Verify against a rotated rectangle on the real board before relying on it.
 */
export type Rect = { x: number; y: number; width: number; height: number };

export type WallShape = "rect" | "circle" | "diamond";

export type AssetRef = { hash: AssetHash; width: number; height: number };

/** One thing standing on the stage, keyed by the Drawdy element it came from. */
export type StageItem =
    | {
          kind: "wall";
          id: ElementId;
          rect: Rect;
          shape: WallShape;
          /** Radians, clockwise on the board (y down), about the rect center. */
          rotation: number;
          color?: string;
      }
    | {
          kind: "cutout";
          id: ElementId;
          /** The screenshot area in canvas units. The PNG already shows the element's rotation, so cutouts carry none. */
          rect: Rect;
          asset: AssetRef;
          /**
           * Milestone 2. Server-owned: the Stage object sets it, and a writer commit that omits it keeps the stored value.
           */
          meshUrl?: string;
      }
    | {
          /** The board element that marks where walkers spawn and rest. Drivers move it; the view only reads it. */
          kind: "pawn";
          id: ElementId;
          x: number;
          y: number;
      };

export type StageSnapshot = {
    revision: number;
    /** The stage frame on the board, in canvas units. */
    frame: Rect;
    items: StageItem[];
};

export type Participant = {
    /** Drawdy presence id of the person, shared by their driver and their view. */
    presenceId: string;
    name: string;
    color: string;
};

export type Role = "driver" | "view";

/**
 * Where a walker stands and looks, in canvas units.
 * Facing direction on the board is (sin(heading), cos(heading)): heading 0 faces +y (down the screen),
 * positive heading turns toward +x. Normalized to (-PI, PI]. Pitch is positive up, clamped to [-1.4, 1.4].
 */
export type Pose = { x: number; y: number; heading: number; pitch: number };

export type Cursor = Participant & { x: number; y: number };

export type Writer = { connectionId: ConnectionId | null; epoch: number };

export type ClientMessage =
    | {
          type: "hello";
          v: typeof PROTOCOL_VERSION;
          stageId: string;
          token: string;
          role: Role;
          participant: Participant;
      }
    /**
     * Writer only, fenced by epoch. Applied atomically. `reset` replaces every item first (used after the writer is
     * elected). Cutout items may reference only assets already uploaded with `asset.put`.
     */
    | {
          type: "scene.commit";
          requestId: string;
          epoch: number;
          reset?: true;
          frame?: Rect;
          upserts: StageItem[];
          removes: ElementId[];
      }
    /** Writer only. Content-addressed, so a repeat upload of the same hash is a no-op. */
    | { type: "asset.put"; requestId: string; epoch: number; hash: AssetHash; width: number; height: number; pngBase64: string }
    /** View only. Ephemeral, broadcast to everyone else, never stored. */
    | { type: "pose"; pose: Pose }
    /** Writer only. A full replacement list of other people's cursors on the board. Ephemeral. */
    | { type: "cursors"; epoch: number; cursors: Cursor[] }
    /** Any socket. The server answers with `pong`. */
    | { type: "ping"; t: number };

export type AckError = "not_writer" | "stale_epoch" | "limit" | "missing_asset" | "bad_message";

export type ServerMessage =
    | {
          type: "welcome";
          v: typeof PROTOCOL_VERSION;
          connectionId: ConnectionId;
          writer: Writer;
          snapshot: StageSnapshot;
          walkers: Walker[];
      }
    | { type: "writer"; writer: Writer }
    | { type: "ack"; requestId: string; ok: true; revision: number }
    | { type: "ack"; requestId: string; ok: false; error: AckError; message: string }
    /** Broadcast after every successful commit. `reset` means drop every item first. */
    | { type: "scene.patch"; revision: number; reset?: true; frame?: Rect; upserts: StageItem[]; removes: ElementId[] }
    | { type: "walker"; walker: Walker }
    | { type: "walker.left"; connectionId: ConnectionId }
    | { type: "cursors"; cursors: Cursor[] }
    | { type: "pong"; t: number }
    | { type: "error"; code: ErrorCode; message: string };

export type Walker = { connectionId: ConnectionId; participant: Participant; pose: Pose };

/**
 * `uninitialized` means no driver has registered this stage's token yet. A view that gets it retries with backoff.
 * The driver opens the view only after its own `welcome`, so this is a rare race, not the normal path.
 */
export type ErrorCode = "bad_message" | "bad_token" | "uninitialized" | "version" | "too_large" | "limit" | "not_writer";

/** WebSocket close codes the Stage object uses. */
export const CLOSE = {
    badToken: 4401,
    badVersion: 4426,
    uninitialized: 4409,
    malformed: 1002,
    tooLarge: 1009,
} as const;

/** Views fetch cutout PNGs over HTTPS: GET {backendUrl}/api/stages/{stageId}/assets/{hash}?token={token}. */
export function assetUrl(backendUrl: string, stageId: string, token: string, hash: AssetHash): string {
    return `${backendUrl}/api/stages/${encodeURIComponent(stageId)}/assets/${hash}?token=${encodeURIComponent(token)}`;
}

/** The WebSocket endpoint for a stage. */
export function stageSocketUrl(backendUrl: string, stageId: string): string {
    return `${backendUrl.replace(/^http/, "ws")}/api/stages/${encodeURIComponent(stageId)}`;
}

export class ProtocolError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

/**
 * Parses an untrusted frame from a client. Throws ProtocolError: `too_large` for a frame, list, or PNG over its limit,
 * `version` for a hello from another protocol version, and `bad_message` for anything else. Drivers can run their own
 * outgoing messages through it to catch a violation before the Stage object closes the socket.
 */
export function parseClientMessage(raw: string): ClientMessage {
    return parseFrame(raw, clientMessages);
}

/** Parses an untrusted frame from the Stage object. Throws ProtocolError like `parseClientMessage`. */
export function parseServerMessage(raw: string): ServerMessage {
    return parseFrame(raw, serverMessages);
}

const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 2_048;
const MAX_CURSORS = 100;
const MAX_PITCH = 1.4;
const ASSET_HASH = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ROLES = { driver: true, view: true } satisfies Record<Role, true>;
const WALL_SHAPES = { rect: true, circle: true, diamond: true } satisfies Record<WallShape, true>;
const ACK_ERRORS = {
    not_writer: true,
    stale_epoch: true,
    limit: true,
    missing_asset: true,
    bad_message: true,
} satisfies Record<AckError, true>;
const ERROR_CODES = {
    bad_message: true,
    bad_token: true,
    uninitialized: true,
    version: true,
    too_large: true,
    limit: true,
    not_writer: true,
} satisfies Record<ErrorCode, true>;

type Fields = Readonly<Record<string, unknown>>;
type Parsers<M extends { type: string }> = { readonly [T in M["type"]]: (value: Fields) => Extract<M, { type: T }> };

const reject = (message: string, code: ErrorCode = "bad_message"): never => {
    throw new ProtocolError(code, message);
};

function parseFrame<M extends { type: string }>(raw: string, parsers: Parsers<M>): M {
    if (raw.length > MAX_FRAME_CHARACTERS) reject(`frame exceeds ${MAX_FRAME_CHARACTERS} characters`, "too_large");
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return reject("frame is not JSON");
    }
    if (!isObject(value)) return reject("frame must be a JSON object");
    const type = value.type;
    if (typeof type !== "string" || !Object.hasOwn(parsers, type)) return reject(`unknown message type ${String(type)}`);
    return parsers[type as M["type"]](value);
}

const isObject = (value: unknown): value is Fields =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** An object with exactly these keys, the optional ones allowed to be absent. */
function fields(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
    if (!isObject(value)) return reject(`${path} must be an object`);
    for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) reject(`${path}.${key} is not allowed`);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key)) reject(`${path}.${key} is required`);
    }
    return value;
}

function text(value: unknown, path: string, max: number, min = 1): string {
    if (typeof value !== "string") return reject(`${path} must be a string`);
    if (value.length < min || value.length > max) reject(`${path} must be ${min} to ${max} characters`);
    return value;
}

function within(value: unknown, path: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return reject(`${path} must be a finite number`);
    if (value < min || value > max) reject(`${path} must be between ${min} and ${max}`);
    return value;
}

function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value)) return reject(`${path} must be an integer`);
    return within(value, path, min, max);
}

function oneOf<T extends string>(value: unknown, path: string, options: Readonly<Record<T, true>>): T {
    if (typeof value !== "string" || !Object.hasOwn(options, value)) return reject(`${path} has an unknown value`);
    return value as T;
}

function list<T>(value: unknown, path: string, max: number, item: (value: unknown, path: string) => T): T[] {
    if (!Array.isArray(value)) return reject(`${path} must be an array`);
    if (value.length > max) reject(`${path} holds more than ${max} entries`, "too_large");
    return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

function distinct(ids: readonly string[], path: string): void {
    if (new Set(ids).size !== ids.length) reject(`${path} names an element twice`);
}

const id = (value: unknown, path: string): string => text(value, path, MAX_ID_CHARS);

function url(value: unknown, path: string): string {
    const href = text(value, path, MAX_TEXT_CHARS);
    if (!URL.canParse(href) || new URL(href).protocol !== "https:") reject(`${path} must be an https URL`);
    return href;
}

function rect(value: unknown, path: string): Rect {
    const f = fields(value, path, ["x", "y", "width", "height"]);
    return {
        x: within(f.x, `${path}.x`),
        y: within(f.y, `${path}.y`),
        width: within(f.width, `${path}.width`, 0),
        height: within(f.height, `${path}.height`, 0),
    };
}

function assetRef(value: unknown, path: string): AssetRef {
    const f = fields(value, path, ["hash", "width", "height"]);
    return {
        hash: assetHash(f.hash, `${path}.hash`),
        width: integer(f.width, `${path}.width`, 1, MAX_ASSET_SIDE_PX),
        height: integer(f.height, `${path}.height`, 1, MAX_ASSET_SIDE_PX),
    };
}

function assetHash(value: unknown, path: string): AssetHash {
    if (typeof value !== "string" || !ASSET_HASH.test(value)) return reject(`${path} must be a lowercase hex SHA-256`);
    return value;
}

function stageItem(value: unknown, path: string): StageItem {
    const kind = isObject(value) ? value.kind : undefined;
    switch (kind) {
        case "wall": {
            const f = fields(value, path, ["kind", "id", "rect", "shape", "rotation"], ["color"]);
            return {
                kind,
                id: id(f.id, `${path}.id`),
                rect: rect(f.rect, `${path}.rect`),
                shape: oneOf(f.shape, `${path}.shape`, WALL_SHAPES),
                rotation: within(f.rotation, `${path}.rotation`),
                ...(f.color === undefined ? {} : { color: text(f.color, `${path}.color`, MAX_NAME_CHARS) }),
            };
        }
        case "cutout": {
            const f = fields(value, path, ["kind", "id", "rect", "asset"], ["meshUrl"]);
            return {
                kind,
                id: id(f.id, `${path}.id`),
                rect: rect(f.rect, `${path}.rect`),
                asset: assetRef(f.asset, `${path}.asset`),
                ...(f.meshUrl === undefined ? {} : { meshUrl: url(f.meshUrl, `${path}.meshUrl`) }),
            };
        }
        case "pawn": {
            const f = fields(value, path, ["kind", "id", "x", "y"]);
            return { kind, id: id(f.id, `${path}.id`), x: within(f.x, `${path}.x`), y: within(f.y, `${path}.y`) };
        }
        default:
            return reject(`${path}.kind must be wall, cutout, or pawn`);
    }
}

function participant(value: unknown, path: string): Participant {
    const f = fields(value, path, ["presenceId", "name", "color"]);
    return {
        presenceId: id(f.presenceId, `${path}.presenceId`),
        name: text(f.name, `${path}.name`, MAX_NAME_CHARS, 0),
        color: text(f.color, `${path}.color`, MAX_NAME_CHARS),
    };
}

function pose(value: unknown, path: string): Pose {
    const f = fields(value, path, ["x", "y", "heading", "pitch"]);
    return {
        x: within(f.x, `${path}.x`),
        y: within(f.y, `${path}.y`),
        heading: within(f.heading, `${path}.heading`, -Math.PI, Math.PI),
        pitch: within(f.pitch, `${path}.pitch`, -MAX_PITCH, MAX_PITCH),
    };
}

function cursor(value: unknown, path: string): Cursor {
    const f = fields(value, path, ["presenceId", "name", "color", "x", "y"]);
    return {
        ...participant({ presenceId: f.presenceId, name: f.name, color: f.color }, path),
        x: within(f.x, `${path}.x`),
        y: within(f.y, `${path}.y`),
    };
}

const cursors = (value: unknown, path: string): Cursor[] => list(value, path, MAX_CURSORS, cursor);

function writer(value: unknown, path: string): Writer {
    const f = fields(value, path, ["connectionId", "epoch"]);
    return {
        connectionId: f.connectionId === null ? null : id(f.connectionId, `${path}.connectionId`),
        epoch: integer(f.epoch, `${path}.epoch`),
    };
}

function walker(value: unknown, path: string): Walker {
    const f = fields(value, path, ["connectionId", "participant", "pose"]);
    return {
        connectionId: id(f.connectionId, `${path}.connectionId`),
        participant: participant(f.participant, `${path}.participant`),
        pose: pose(f.pose, `${path}.pose`),
    };
}

function snapshot(value: unknown, path: string): StageSnapshot {
    const f = fields(value, path, ["revision", "frame", "items"]);
    const items = list(f.items, `${path}.items`, MAX_ITEMS_PER_STAGE, stageItem);
    distinct(
        items.map((item) => item.id),
        `${path}.items`,
    );
    if (items.filter((item) => item.kind === "cutout").length > MAX_CUTOUTS_PER_STAGE) {
        reject(`${path}.items holds more than ${MAX_CUTOUTS_PER_STAGE} cutouts`, "too_large");
    }
    return { revision: integer(f.revision, `${path}.revision`), frame: rect(f.frame, `${path}.frame`), items };
}

/** Upserts and removes of one commit or patch: at most MAX_ITEMS_PER_COMMIT together, each element named once. */
function changes(f: Fields, path: string): { upserts: StageItem[]; removes: ElementId[] } {
    const upserts = list(f.upserts, `${path}.upserts`, MAX_ITEMS_PER_COMMIT, stageItem);
    const removes = list(f.removes, `${path}.removes`, MAX_ITEMS_PER_COMMIT, id);
    if (upserts.length + removes.length > MAX_ITEMS_PER_COMMIT) {
        reject(`${path} changes more than ${MAX_ITEMS_PER_COMMIT} items`, "too_large");
    }
    distinct([...upserts.map((item) => item.id), ...removes], path);
    return { upserts, removes };
}

function resetAndFrame(f: Fields, path: string): { reset?: true; frame?: Rect } {
    if (f.reset !== undefined && f.reset !== true) reject(`${path}.reset must be true when present`);
    return {
        ...(f.reset === true ? { reset: true } : {}),
        ...(f.frame === undefined ? {} : { frame: rect(f.frame, `${path}.frame`) }),
    };
}

function version(f: Fields, path: string): typeof PROTOCOL_VERSION {
    if (f.v !== PROTOCOL_VERSION) reject(`${path}.v must be ${PROTOCOL_VERSION}`, "version");
    return PROTOCOL_VERSION;
}

const clientMessages: Parsers<ClientMessage> = {
    hello: (value) => {
        const v = version(value, "hello");
        const f = fields(value, "hello", ["type", "v", "stageId", "token", "role", "participant"]);
        return {
            type: "hello",
            v,
            stageId: id(f.stageId, "hello.stageId"),
            token: id(f.token, "hello.token"),
            role: oneOf(f.role, "hello.role", ROLES),
            participant: participant(f.participant, "hello.participant"),
        };
    },
    "scene.commit": (value) => {
        const path = "scene.commit";
        const f = fields(value, path, ["type", "requestId", "epoch", "upserts", "removes"], ["reset", "frame"]);
        return {
            type: "scene.commit",
            requestId: id(f.requestId, `${path}.requestId`),
            epoch: integer(f.epoch, `${path}.epoch`),
            ...resetAndFrame(f, path),
            ...changes(f, path),
        };
    },
    "asset.put": (value) => {
        const f = fields(value, "asset.put", ["type", "requestId", "epoch", "hash", "width", "height", "pngBase64"]);
        const pngBase64 = text(f.pngBase64, "asset.put.pngBase64", MAX_FRAME_CHARACTERS);
        if (pngBase64.length > MAX_ASSET_BASE64) {
            reject(`asset.put.pngBase64 exceeds ${MAX_ASSET_BASE64} characters`, "too_large");
        }
        if (!BASE64.test(pngBase64)) reject("asset.put.pngBase64 must be padded base64");
        return {
            type: "asset.put",
            requestId: id(f.requestId, "asset.put.requestId"),
            epoch: integer(f.epoch, "asset.put.epoch"),
            hash: assetHash(f.hash, "asset.put.hash"),
            width: integer(f.width, "asset.put.width", 1, MAX_ASSET_SIDE_PX),
            height: integer(f.height, "asset.put.height", 1, MAX_ASSET_SIDE_PX),
            pngBase64,
        };
    },
    pose: (value) => {
        const f = fields(value, "pose", ["type", "pose"]);
        return { type: "pose", pose: pose(f.pose, "pose.pose") };
    },
    cursors: (value) => {
        const f = fields(value, "cursors", ["type", "epoch", "cursors"]);
        return {
            type: "cursors",
            epoch: integer(f.epoch, "cursors.epoch"),
            cursors: cursors(f.cursors, "cursors.cursors"),
        };
    },
    ping: (value) => {
        const f = fields(value, "ping", ["type", "t"]);
        return { type: "ping", t: within(f.t, "ping.t") };
    },
};

const serverMessages: Parsers<ServerMessage> = {
    welcome: (value) => {
        const v = version(value, "welcome");
        const f = fields(value, "welcome", ["type", "v", "connectionId", "writer", "snapshot", "walkers"]);
        return {
            type: "welcome",
            v,
            connectionId: id(f.connectionId, "welcome.connectionId"),
            writer: writer(f.writer, "welcome.writer"),
            snapshot: snapshot(f.snapshot, "welcome.snapshot"),
            walkers: list(f.walkers, "welcome.walkers", Number.MAX_SAFE_INTEGER, walker),
        };
    },
    writer: (value) => {
        const f = fields(value, "writer", ["type", "writer"]);
        return { type: "writer", writer: writer(f.writer, "writer.writer") };
    },
    ack: (value) => {
        if (isObject(value) && value.ok === true) {
            const f = fields(value, "ack", ["type", "requestId", "ok", "revision"]);
            return {
                type: "ack",
                requestId: id(f.requestId, "ack.requestId"),
                ok: true,
                revision: integer(f.revision, "ack.revision"),
            };
        }
        const f = fields(value, "ack", ["type", "requestId", "ok", "error", "message"]);
        if (f.ok !== false) reject("ack.ok must be a boolean");
        return {
            type: "ack",
            requestId: id(f.requestId, "ack.requestId"),
            ok: false,
            error: oneOf(f.error, "ack.error", ACK_ERRORS),
            message: text(f.message, "ack.message", MAX_TEXT_CHARS, 0),
        };
    },
    "scene.patch": (value) => {
        const path = "scene.patch";
        const f = fields(value, path, ["type", "revision", "upserts", "removes"], ["reset", "frame"]);
        return {
            type: "scene.patch",
            revision: integer(f.revision, `${path}.revision`),
            ...resetAndFrame(f, path),
            ...changes(f, path),
        };
    },
    walker: (value) => {
        const f = fields(value, "walker", ["type", "walker"]);
        return { type: "walker", walker: walker(f.walker, "walker.walker") };
    },
    "walker.left": (value) => {
        const f = fields(value, "walker.left", ["type", "connectionId"]);
        return { type: "walker.left", connectionId: id(f.connectionId, "walker.left.connectionId") };
    },
    cursors: (value) => {
        const f = fields(value, "cursors", ["type", "cursors"]);
        return { type: "cursors", cursors: cursors(f.cursors, "cursors.cursors") };
    },
    pong: (value) => {
        const f = fields(value, "pong", ["type", "t"]);
        return { type: "pong", t: within(f.t, "pong.t") };
    },
    error: (value) => {
        const f = fields(value, "error", ["type", "code", "message"]);
        return {
            type: "error",
            code: oneOf(f.code, "error.code", ERROR_CODES),
            message: text(f.message, "error.message", MAX_TEXT_CHARS, 0),
        };
    },
};

/** Board point in canvas units to a 3D floor point in meters, centered on the frame. Canvas y maps to world z. */
export function canvasToWorld(x: number, y: number, frame: Rect): { x: number; z: number } {
    return {
        x: (x - (frame.x + frame.width / 2)) / CANVAS_UNITS_PER_METER,
        z: (y - (frame.y + frame.height / 2)) / CANVAS_UNITS_PER_METER,
    };
}

/** The center of a rect on the 3D floor. */
export function rectCenterToWorld(rect: Rect, frame: Rect): { x: number; z: number } {
    return canvasToWorld(rect.x + rect.width / 2, rect.y + rect.height / 2, frame);
}

/**
 * Three.js is y-up and right-handed with canvas y mapped to +z, so a clockwise board rotation is a negative turn
 * about +y. Use this for `mesh.rotation.y` of a wall.
 */
export function boardRotationToYaw(rotation: number): number {
    return -rotation;
}

/** Camera yaw about +y for a pose heading, given the camera looks down its own -z. */
export function headingToCameraYaw(heading: number): number {
    return Math.PI + heading;
}

export function worldToCanvas(x: number, z: number, frame: Rect): { x: number; y: number } {
    return {
        x: x * CANVAS_UNITS_PER_METER + frame.x + frame.width / 2,
        y: z * CANVAS_UNITS_PER_METER + frame.y + frame.height / 2,
    };
}

/** What the 3D view needs to connect, baked into its srcDoc by the driver. */
export type ViewBoot = {
    backendUrl: string;
    stageId: string;
    token: string;
    participant: Participant;
};
