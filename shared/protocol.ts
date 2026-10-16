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
          /** Milestone 2. Set when a mesh replaces the paper cutout. */
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

export type ErrorCode = "bad_message" | "bad_token" | "version" | "too_large" | "limit" | "not_writer";

/** WebSocket close codes the Stage object uses. */
export const CLOSE = {
    badToken: 4401,
    badVersion: 4426,
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
    constructor(readonly code: ErrorCode, message: string) {
        super(message);
    }
}

/** Parses an untrusted frame from a client. Throws ProtocolError. */
export function parseClientMessage(_raw: string): ClientMessage {
    throw new Error("not implemented");
}

/** Parses an untrusted frame from the Stage object. Throws ProtocolError. */
export function parseServerMessage(_raw: string): ServerMessage {
    throw new Error("not implemented");
}

/** Board point in canvas units to a 3D floor point in meters, centered on the frame. Canvas y maps to world z. */
export function canvasToWorld(x: number, y: number, frame: Rect): { x: number; z: number } {
    return {
        x: (x - (frame.x + frame.width / 2)) / CANVAS_UNITS_PER_METER,
        z: (y - (frame.y + frame.height / 2)) / CANVAS_UNITS_PER_METER,
    };
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
