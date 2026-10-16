import {
    CANVAS_UNITS_PER_METER,
    WALL_HEIGHT_METERS,
    boardRotationToYaw,
    canvasToWorld,
    rectCenterToWorld,
    type Cursor,
    type Rect,
    type StageItem,
    type WallShape,
} from "../shared/protocol";

export const WALL_THICKNESS_M = 0.12;
export const WALKER_RADIUS_M = 0.25;
export const HAND_HEIGHT_M = 2.2;
const CIRCLE_SEGMENTS = 48;

export type Point = { x: number; z: number };
export type Segment = { a: Point; b: Point };
export type WallItem = Extract<StageItem, { kind: "wall" }>;
export type CutoutItem = Extract<StageItem, { kind: "cutout" }>;

/**
 * A wall as the view draws and collides with it. A shape wide enough to hold a room is hollow: only its outline
 * stands, WALL_THICKNESS_M thick, so a drawn rectangle becomes a room you can stand in. A thinner shape is solid.
 */
export type WallPlan = {
    center: Point;
    yaw: number;
    height: number;
    shape: WallShape;
    halfWidth: number;
    halfDepth: number;
    hollow: boolean;
};

type ShapeRule = {
    /** Closed outline in the wall's own unrotated frame, centered on the origin. */
    outline(halfWidth: number, halfDepth: number): Point[];
    /** Half extents of the same shape moved inward by `by` along its normals. */
    inset(halfWidth: number, halfDepth: number, by: number): [number, number];
};

const SHAPES: Record<WallShape, ShapeRule> = {
    rect: {
        outline: (w, d) => [
            { x: -w, z: -d },
            { x: w, z: -d },
            { x: w, z: d },
            { x: -w, z: d },
        ],
        inset: (w, d, by) => [w - by, d - by],
    },
    diamond: {
        outline: (w, d) => [
            { x: 0, z: -d },
            { x: w, z: 0 },
            { x: 0, z: d },
            { x: -w, z: 0 },
        ],
        inset: (w, d, by) => {
            const scale = 1 - (by * Math.hypot(w, d)) / (w * d);
            return [w * scale, d * scale];
        },
    },
    circle: {
        outline: (w, d) =>
            Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
                const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
                return { x: w * Math.cos(angle), z: d * Math.sin(angle) };
            }),
        inset: (w, d, by) => [w - by, d - by],
    },
};

export function wallPlan(wall: WallItem, frame: Rect): WallPlan {
    const halfWidth = Math.max(wall.rect.width / 2 / CANVAS_UNITS_PER_METER, WALL_THICKNESS_M / 2);
    const halfDepth = Math.max(wall.rect.height / 2 / CANVAS_UNITS_PER_METER, WALL_THICKNESS_M / 2);
    const [holeWidth, holeDepth] = SHAPES[wall.shape].inset(halfWidth, halfDepth, WALL_THICKNESS_M);
    return {
        center: rectCenterToWorld(wall.rect, frame),
        yaw: boardRotationToYaw(wall.rotation),
        height: WALL_HEIGHT_METERS,
        shape: wall.shape,
        halfWidth,
        halfDepth,
        hollow: Math.min(holeWidth, holeDepth) >= WALL_THICKNESS_M / 2,
    };
}

/** The wall's footprint in its own frame: the outer outline and, for a hollow wall, the hole inside it. */
export function wallOutlines(plan: WallPlan): { outer: Point[]; hole: Point[] | null } {
    const rule = SHAPES[plan.shape];
    const outer = rule.outline(plan.halfWidth, plan.halfDepth);
    if (!plan.hollow) return { outer, hole: null };
    const [w, d] = rule.inset(plan.halfWidth, plan.halfDepth, WALL_THICKNESS_M);
    return { outer, hole: rule.outline(w, d) };
}

/** Matches three.js `rotation.y = yaw` followed by `position = center`. */
export function wallToWorld(plan: WallPlan, local: Point): Point {
    const cos = Math.cos(plan.yaw);
    const sin = Math.sin(plan.yaw);
    return {
        x: plan.center.x + local.x * cos + local.z * sin,
        z: plan.center.z - local.x * sin + local.z * cos,
    };
}

/** Every edge of the wall's footprint in world space. A walker never crosses one. */
export function wallEdges(plan: WallPlan): Segment[] {
    const { outer, hole } = wallOutlines(plan);
    return [outer, ...(hole ? [hole] : [])].flatMap((loop) => {
        const world = loop.map((p) => wallToWorld(plan, p));
        return world.map((a, i) => ({ a, b: world[(i + 1) % world.length] }));
    });
}

export type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** The stage floor in world meters. canvasToWorld centers the frame on the origin. */
export function floorBounds(frame: Rect): Bounds {
    const halfX = frame.width / 2 / CANVAS_UNITS_PER_METER;
    const halfZ = frame.height / 2 / CANVAS_UNITS_PER_METER;
    return { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ };
}

/**
 * Moves a walker of `radius` by `delta`, sliding along any edge it would come closer to than its radius and
 * staying on the floor. Steps stay shorter than a quarter of the radius, and every pass keeps the walker on the floor,
 * so a fast move can neither pass through a thin wall nor squeeze between a wall and the floor's edge.
 */
export function moveWalker(
    from: Point,
    delta: Point,
    edges: Segment[],
    bounds: Bounds,
    radius = WALKER_RADIUS_M,
): Point {
    const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / (radius / 4)));
    let p = { ...from };
    for (let step = 0; step < steps; step++) {
        p = { x: p.x + delta.x / steps, z: p.z + delta.z / steps };
        for (let pass = 0; pass < 3; pass++) {
            for (const edge of edges) p = pushOut(p, edge, radius);
            p = onFloor(p, bounds, radius);
        }
    }
    return p;
}

/** Keeps a walker's whole body on the floor, or centers it on a floor narrower than it is. */
function onFloor(p: Point, { minX, maxX, minZ, maxZ }: Bounds, radius: number): Point {
    const within = (value: number, min: number, max: number) => (min > max ? (min + max) / 2 : clamp(value, min, max));
    return { x: within(p.x, minX + radius, maxX - radius), z: within(p.z, minZ + radius, maxZ - radius) };
}

function pushOut(p: Point, { a, b }: Segment, radius: number): Point {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + abz * abz;
    const t = lengthSq === 0 ? 0 : clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / lengthSq, 0, 1);
    const qx = a.x + abx * t;
    const qz = a.z + abz * t;
    const dx = p.x - qx;
    const dz = p.z - qz;
    const distance = Math.hypot(dx, dz);
    if (distance >= radius || distance === 0) return p;
    return { x: qx + (dx / distance) * radius, z: qz + (dz / distance) * radius };
}

export type CutoutPlan = { center: Point; width: number; height: number };

/** A cutout stands at the center of its board rect, as wide as the rect, as tall as its picture's proportions. */
export function cutoutPlan(cutout: CutoutItem, frame: Rect): CutoutPlan {
    const width = cutout.rect.width / CANVAS_UNITS_PER_METER;
    return {
        center: rectCenterToWorld(cutout.rect, frame),
        width,
        height: (width * cutout.asset.height) / Math.max(1, cutout.asset.width),
    };
}

export type HandPlan = { position: Point; hoverHeight: number; inFrame: boolean };

export function handPlan(cursor: Cursor, frame: Rect): HandPlan {
    const inFrame =
        cursor.x >= frame.x &&
        cursor.x <= frame.x + frame.width &&
        cursor.y >= frame.y &&
        cursor.y <= frame.y + frame.height;
    return { position: canvasToWorld(cursor.x, cursor.y, frame), hoverHeight: HAND_HEIGHT_M, inFrame };
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
