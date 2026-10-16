// Wire protocol between the Drawdy driver, the Stage Durable Object, and the 3D view.
// Pure TypeScript with no imports: the driver (esbuild), the view (build-view.mjs), and the backend (wrangler) all bundle it.

export const PROTOCOL_VERSION = 1;

/** Canvas units per meter in the 3D view. A 300 px wide room on the board is 3 m wide inside. */
export const CANVAS_UNITS_PER_METER = 100;
export const WALL_HEIGHT_METERS = 2.6;

export const MAX_CUTOUT_PNG_BASE64 = 350_000;
export const MAX_CUTOUTS_PER_STAGE = 60;
export const MAX_ITEMS_PER_STAGE = 400;
export const MAX_FRAME_CHARACTERS = 2_000_000;
export const POSE_HZ = 20;

export type ElementId = string;
export type ConnectionId = string;

export type Rect = { x: number; y: number; width: number; height: number };

export type WallShape = "rect" | "circle" | "diamond";

/** One thing standing on the stage, keyed by the Drawdy element it came from. */
export type StageItem =
    | {
          kind: "wall";
          id: ElementId;
          rect: Rect;
          shape: WallShape;
          /** Radians, about the rect center, as Drawdy reports it. */
          rotation: number;
          color?: string;
      }
    | {
          kind: "cutout";
          id: ElementId;
          rect: Rect;
          rotation: number;
          /** PNG with white already transparent or not; the view applies the alpha key. */
          pngBase64: string;
          /** Content hash the driver uses to skip recapture. */
          hash: string;
          /** Set by the inflate agent when a mesh replaces the paper cutout. */
          meshUrl?: string;
      }
    | {
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

export type Pose = {
    /** Canvas units, same space as the board. */
    x: number;
    y: number;
    /** Radians. 0 faces +y on the board (down the screen). */
    heading: number;
    /** Radians, look up and down, clamped by the view. */
    pitch: number;
};

export type Cursor = Participant & { x: number; y: number };

export type ClientMessage =
    | {
          type: "hello";
          v: typeof PROTOCOL_VERSION;
          stageId: string;
          token: string;
          role: Role;
          participant: Participant;
      }
    /** Driver only. Replaces the whole scene, used on first open and after reconnect. */
    | { type: "scene.reset"; requestId: string; frame: Rect; items: StageItem[] }
    /** Driver only. */
    | { type: "scene.upsert"; requestId: string; items: StageItem[] }
    /** Driver only. */
    | { type: "scene.remove"; requestId: string; ids: ElementId[] }
    /** View only. Ephemeral, broadcast to everyone else, never stored. */
    | { type: "pose"; pose: Pose }
    /** Driver only. Ephemeral collaborator cursors in canvas units, never stored. */
    | { type: "cursors"; cursors: Cursor[] }
    /** Reserved for milestone 2. */
    | { type: "inflate.request"; requestId: string; ids: ElementId[] };

export type ServerMessage =
    | {
          type: "welcome";
          v: typeof PROTOCOL_VERSION;
          connectionId: ConnectionId;
          snapshot: StageSnapshot;
          walkers: Walker[];
      }
    | { type: "ack"; requestId: string; ok: true; revision: number }
    | { type: "ack"; requestId: string; ok: false; error: string }
    | { type: "scene.patch"; revision: number; upserts: StageItem[]; removes: ElementId[]; reset?: { frame: Rect } }
    | { type: "walker"; walker: Walker }
    | { type: "walker.left"; connectionId: ConnectionId }
    | { type: "cursors"; from: ConnectionId; cursors: Cursor[] }
    | { type: "inflate.status"; id: ElementId; phase: "queued" | "name" | "generate" | "check" | "done" | "failed"; detail?: string }
    | { type: "error"; code: ErrorCode; message: string };

export type Walker = { connectionId: ConnectionId; participant: Participant; pose: Pose };

export type ErrorCode = "bad_message" | "bad_token" | "not_driver" | "not_view" | "too_large" | "limit" | "version";

/** WebSocket close codes the Stage object uses. */
export const CLOSE = {
    badToken: 4401,
    badVersion: 4426,
    malformed: 1002,
    tooLarge: 1009,
} as const;

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

/** Board point in canvas units to a 3D floor point in meters. The view uses x for x and canvas y for z. */
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
