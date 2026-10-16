import type { SubscribeableKey, SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import {
    MAX_CUTOUTS_PER_STAGE,
    MAX_ITEMS_PER_STAGE,
    type ElementId,
    type Rect,
    type StageItem,
    type WallShape,
} from "../shared/protocol";
import { captureArea, contentHash } from "./cutouts";

export type BoardElement = SubscribedDrawdyElement;
export type StageRole = "wall" | "cutout" | "pawn";

/** Every property the driver reads from the board, for both queries and subscriptions. */
export const ELEMENT_PROPERTIES: SubscribeableKey[] = [
    "type",
    "componentType",
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "frameId",
    "meta",
    "text",
    "points",
    "strokeColor",
    "fillColor",
    "textColor",
    "strokeWidth",
    "opacity",
    "fillStyle",
    "strokeDash",
    "roughness",
    "cornerRadius",
];

export const ROLE_META_KEY = "paperStageRole";

const ROLE_BY_META = new Map<unknown, StageRole>([["pawn", "pawn"]]);

// Drawdy reads every shape, line and arrow back as "path". Triangles, stars, lines and arrows carry no componentType,
// and Drawdy turns pencil strokes into such shapes, so a bare "path" stands up as a drawing.
const ROLE_BY_KIND = new Map<string, StageRole>([
    ["path/rect", "wall"],
    ["path/circle", "wall"],
    ["path/diamond", "wall"],
    ["path/sticky-note", "cutout"],
    ["path", "cutout"],
    ["freedraw", "cutout"],
    ["text", "cutout"],
    ["image", "cutout"],
]);

const WALL_SHAPE: Partial<Record<string, WallShape>> = { rect: "rect", circle: "circle", diamond: "diamond" };

export function classify(element: BoardElement): StageRole | null {
    const metaRole = ROLE_BY_META.get(element.meta?.[ROLE_META_KEY]);
    if (metaRole) return metaRole;
    const kind = element.componentType ? `${element.type}/${element.componentType}` : String(element.type);
    return ROLE_BY_KIND.get(kind) ?? null;
}

export function rectOf(element: BoardElement): Rect | null {
    const { x, y, width, height } = element;
    if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
    return { x, y, width, height };
}

export function belongsToStage(element: BoardElement, frameId: ElementId, frame: Rect): boolean {
    if (element.frameId === frameId) return true;
    const rect = rectOf(element);
    if (!rect) return false;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return cx >= frame.x && cx <= frame.x + frame.width && cy >= frame.y && cy <= frame.y + frame.height;
}

export type SceneState = { frameId: ElementId; elements: ReadonlyMap<ElementId, BoardElement> };

export type SceneEvent =
    | { type: "loaded"; elements: readonly BoardElement[] }
    | { type: "changed"; upserted: readonly BoardElement[]; removed: readonly ElementId[] };

export function reduceScene(state: SceneState, event: SceneEvent): SceneState {
    if (event.type === "loaded") {
        return { ...state, elements: new Map(event.elements.map((element) => [element.id, element])) };
    }
    const elements = new Map(state.elements);
    for (const id of event.removed) elements.delete(id);
    // Drawdy sends every requested property on each event, so a fresh copy replaces the old one.
    for (const element of event.upserted) elements.set(element.id, element);
    return { ...state, elements };
}

/** A stage item before its cutout is captured. A cutout's rect is the screenshot area. */
export type BoardItem =
    | Extract<StageItem, { kind: "wall" }>
    | Extract<StageItem, { kind: "pawn" }>
    | { kind: "cutout"; id: ElementId; rect: Rect; contentHash: string };

export type StageProjection = {
    frame: Rect;
    items: BoardItem[];
    /** Elements left off the stage by the protocol caps. */
    dropped: { cutouts: number; items: number };
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const roundRect = (rect: Rect): Rect => ({
    x: round2(rect.x),
    y: round2(rect.y),
    width: round2(rect.width),
    height: round2(rect.height),
});

const OKLCH = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/i;

/**
 * A board color as `#rrggbb`, or null when it is not paint. Drawdy stores theme colors as `oklch(...)`, which three.js
 * cannot parse, so the driver converts them before they reach the view.
 */
export function hexColor(color: string | undefined): string | null {
    if (!color) return null;
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((ch) => ch + ch).join("")}`.toLowerCase();
    const match = OKLCH.exec(color);
    if (!match) return null;
    const lightness = Number(match[1]) / (match[2] ? 100 : 1);
    const chroma = Number(match[3]);
    const hue = (Number(match[4]) * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    const channel = (x: number) => {
        const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
            .toString(16)
            .padStart(2, "0");
    };
    return `#${linear.map(channel).join("")}`;
}

function toBoardItem(element: BoardElement, role: StageRole, rect: Rect): BoardItem {
    const rotation = element.rotation ?? 0;
    switch (role) {
        case "wall": {
            const color = hexColor(element.fillColor) ?? hexColor(element.strokeColor);
            return {
                kind: "wall",
                id: element.id,
                rect: roundRect(rect),
                shape: WALL_SHAPE[element.componentType ?? ""] ?? "rect",
                rotation,
                ...(color ? { color } : {}),
            };
        }
        case "pawn":
            return {
                kind: "pawn",
                id: element.id,
                x: round2(rect.x + rect.width / 2),
                y: round2(rect.y + rect.height / 2),
            };
        case "cutout":
            return {
                kind: "cutout",
                id: element.id,
                rect: roundRect(captureArea(rect, rotation)),
                contentHash: contentHash(element),
            };
    }
}

/** What stands on the stage right now, or null when the stage frame is gone. */
export function projectStage(state: SceneState): StageProjection | null {
    const frameElement = state.elements.get(state.frameId);
    const frame = frameElement && rectOf(frameElement);
    if (!frame) return null;

    let pawn: BoardItem | null = null;
    const walls: BoardItem[] = [];
    const cutouts: BoardItem[] = [];
    for (const element of state.elements.values()) {
        const role = classify(element);
        const rect = rectOf(element);
        if (!role || !rect || !belongsToStage(element, state.frameId, frame)) continue;
        const item = toBoardItem(element, role, rect);
        if (item.kind === "pawn") pawn ??= item;
        else (item.kind === "wall" ? walls : cutouts).push(item);
    }

    const keptCutouts = cutouts.slice(0, MAX_CUTOUTS_PER_STAGE);
    const candidates = [...(pawn ? [pawn] : []), ...walls, ...keptCutouts];
    const items = candidates.slice(0, MAX_ITEMS_PER_STAGE);
    return {
        frame: roundRect(frame),
        items,
        dropped: { cutouts: cutouts.length - keptCutouts.length, items: candidates.length - items.length },
    };
}
