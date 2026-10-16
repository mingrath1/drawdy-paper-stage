import type { DrawdyElementSchema, SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import type { ElementId, Rect } from "../shared/protocol";
import { rectOf, ROLE_META_KEY } from "./stage-model";

export const STAGE_META_KEY = "paperStage";
export const STAGE_NAME = "Paper Stage";
export const STAGE_SIZE = { width: 900, height: 560 };
const GAP = 80;

/** Stored in the stage frame's meta. The token is shared with everyone who can read the board, on purpose. */
export type StageMeta = { v: 1; stageId: string; token: string };

export type StageFrame = { id: ElementId; meta: StageMeta; rect: Rect };

export function parseStageMeta(meta: unknown): StageMeta | null {
    if (typeof meta !== "object" || meta === null) return null;
    const stage = (meta as Record<string, unknown>)[STAGE_META_KEY];
    if (typeof stage !== "object" || stage === null) return null;
    const { v, stageId, token } = stage as Record<string, unknown>;
    if (v !== 1 || typeof stageId !== "string" || typeof token !== "string" || !stageId || !token) return null;
    return { v, stageId, token };
}

export function findStageFrame(elements: readonly SubscribedDrawdyElement[]): StageFrame | null {
    for (const element of elements) {
        if (element.type !== "frame") continue;
        const meta = parseStageMeta(element.meta);
        const rect = rectOf(element);
        if (meta && rect) return { id: element.id, meta, rect };
    }
    return null;
}

function randomHex(bytes: number): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newStageMeta(): StageMeta {
    return { v: 1, stageId: randomHex(12), token: randomHex(24) };
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The empty spot for a new stage closest to the middle of the viewport, searched ring by ring. */
export function findFreeSpot(viewport: Rect, occupied: readonly Rect[]): { x: number; y: number } {
    const { width, height } = STAGE_SIZE;
    const cx = viewport.x + (viewport.width - width) / 2;
    const cy = viewport.y + (viewport.height - height) / 2;
    const stepX = width + GAP;
    const stepY = height + GAP;
    const isFree = (x: number, y: number) => {
        const padded = { x: x - GAP / 2, y: y - GAP / 2, width: width + GAP, height: height + GAP };
        return !occupied.some((rect) => overlaps(padded, rect));
    };
    for (let ring = 0; ring <= 4; ring++) {
        const spots: { x: number; y: number }[] = [];
        for (let dy = -ring; dy <= ring; dy++) {
            for (let dx = -ring; dx <= ring; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) === ring)
                    spots.push({ x: cx + dx * stepX, y: cy + dy * stepY });
            }
        }
        spots.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        const spot = spots.find(({ x, y }) => isFree(x, y));
        if (spot) return spot;
    }
    const right = Math.max(...occupied.map((rect) => rect.x + rect.width));
    return { x: right + GAP, y: cy };
}

export type StarterColors = { ink: string; wall: string; pawn: string };

/** The stage frame with a two-room floor plan of wall segments, a doorway in the middle wall, and a pawn. */
export function starterStage(
    origin: { x: number; y: number },
    meta: StageMeta,
    colors: StarterColors,
    generateId: () => string,
): DrawdyElementSchema[] {
    const frameId = generateId();
    const { x: ox, y: oy } = origin;
    const t = 14;
    const left = 60;
    const top = 60;
    const right = STAGE_SIZE.width - 60;
    const bottom = STAGE_SIZE.height - 60;
    const mid = STAGE_SIZE.width / 2;
    const doorTop = 220;
    const doorBottom = 340;
    const segments: Rect[] = [
        { x: left, y: top, width: right - left, height: t },
        { x: left, y: bottom - t, width: right - left, height: t },
        { x: left, y: top, width: t, height: bottom - top },
        { x: right - t, y: top, width: t, height: bottom - top },
        { x: mid - t / 2, y: top, width: t, height: doorTop - top },
        { x: mid - t / 2, y: doorBottom, width: t, height: bottom - doorBottom },
    ];
    const pawnSize = 36;
    return [
        {
            type: "frame",
            drawdyElementId: frameId,
            name: STAGE_NAME,
            position: [ox, oy],
            width: STAGE_SIZE.width,
            height: STAGE_SIZE.height,
            rotation: 0,
            meta: { [STAGE_META_KEY]: meta },
        },
        ...segments.map((rect): DrawdyElementSchema => ({
            type: "shape",
            componentType: "rect",
            drawdyElementId: generateId(),
            frameId,
            x: ox + rect.x,
            y: oy + rect.y,
            width: rect.width,
            height: rect.height,
            strokeColor: colors.ink,
            fillColor: colors.wall,
            fillStyle: "solid",
            cornerRadius: 2,
        })),
        {
            type: "shape",
            componentType: "circle",
            drawdyElementId: generateId(),
            frameId,
            x: ox + (left + mid) / 2 - pawnSize / 2,
            y: oy + (top + bottom) / 2 - pawnSize / 2,
            width: pawnSize,
            height: pawnSize,
            strokeColor: colors.ink,
            fillColor: colors.pawn,
            fillStyle: "solid",
            meta: { [ROLE_META_KEY]: "pawn" },
        },
    ];
}
