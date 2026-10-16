import { describe, expect, it } from "vitest";
import { Object3D, Vector3 } from "../view/vendor/three.module.js";
import { canvasToWorld, type Rect } from "../shared/protocol";
import {
    WALKER_RADIUS_M,
    WALL_THICKNESS_M,
    cutoutPlan,
    floorBounds,
    handPlan,
    moveWalker,
    openHeading,
    refloor,
    settleWalker,
    wallEdges,
    wallPlan,
    wallToWorld,
    type Point,
    type WallItem,
} from "../view/layout";

const frame: Rect = { x: 1000, y: 2000, width: 1200, height: 800 };
const bounds = floorBounds(frame);

function wall(rect: Rect, shape: WallItem["shape"] = "rect", rotation = 0): WallItem {
    return { kind: "wall", id: "w", rect, shape, rotation };
}

/** A rect centered on the frame center, in canvas units. */
function centered(width: number, height: number): Rect {
    return { x: 1600 - width / 2, y: 2400 - height / 2, width, height };
}

function walk(from: Point, delta: Point, walls: WallItem[]): Point {
    return moveWalker(
        from,
        delta,
        walls.flatMap((w) => wallEdges(wallPlan(w, frame))),
        bounds,
    );
}

describe("walls", () => {
    it("keeps a walker inside a drawn room", () => {
        const room = wall(centered(400, 300));
        expect(wallPlan(room, frame).hollow).toBe(true);
        const end = walk({ x: 0, z: 0 }, { x: 5, z: 0 }, [room]);
        expect(end.x).toBeCloseTo(2 - WALL_THICKNESS_M - WALKER_RADIUS_M, 5);
        expect(end.z).toBeCloseTo(0, 5);
    });

    it("blocks a walker outside a room at its outer face", () => {
        const room = wall(centered(400, 300));
        const end = walk({ x: -4, z: 0 }, { x: 3, z: 0 }, [room]);
        expect(end.x).toBeCloseTo(-2 - WALKER_RADIUS_M, 5);
    });

    it("stands a thin rectangle up as a solid wall", () => {
        const segment = wall(centered(400, 10));
        expect(wallPlan(segment, frame).hollow).toBe(false);
        const end = walk({ x: 0, z: -1 }, { x: 0, z: 2 }, [segment]);
        expect(end.z).toBeCloseTo(-WALL_THICKNESS_M / 2 - WALKER_RADIUS_M, 5);
    });

    it("does not let one long step pass through a thin wall", () => {
        const end = walk({ x: 0, z: -0.5 }, { x: 0, z: 3 }, [wall(centered(400, 10))]);
        expect(end.z).toBeLessThan(0);
    });

    it("slides along a wall instead of stopping dead", () => {
        const end = walk({ x: 0, z: -0.5 }, { x: 1, z: 1 }, [wall(centered(400, 10))]);
        expect(end.x).toBeCloseTo(1, 5);
        expect(end.z).toBeLessThan(0);
    });

    it("turns a wall with its board rotation", () => {
        const flat = wall(centered(400, 10));
        const turned = wall(centered(400, 10), "rect", Math.PI / 2);
        expect(walk({ x: -1, z: 1 }, { x: 2, z: 0 }, [flat]).x).toBeCloseTo(1, 5);
        expect(walk({ x: -1, z: 1 }, { x: 2, z: 0 }, [turned]).x).toBeCloseTo(
            -WALL_THICKNESS_M / 2 - WALKER_RADIUS_M,
            5,
        );
    });

    it("places a clockwise board rotation where the board shows it, in collision and in three.js", () => {
        const rotation = 0.3;
        const plan = wallPlan(wall(centered(400, 10), "rect", rotation), frame);
        const tipOnBoard = canvasToWorld(1600 + 200 * Math.cos(rotation), 2400 + 200 * Math.sin(rotation), frame);

        const tip = wallToWorld(plan, { x: plan.halfWidth, z: 0 });
        expect(tip.x).toBeCloseTo(tipOnBoard.x, 6);
        expect(tip.z).toBeCloseTo(tipOnBoard.z, 6);

        const mesh = new Object3D();
        mesh.position.set(plan.center.x, 0, plan.center.z);
        mesh.rotation.y = plan.yaw;
        mesh.updateMatrixWorld();
        const rendered = mesh.localToWorld(new Vector3(plan.halfWidth, 0, 0));
        expect(rendered.x).toBeCloseTo(tipOnBoard.x, 6);
        expect(rendered.z).toBeCloseTo(tipOnBoard.z, 6);
    });

    it("walls in a round room and a diamond room", () => {
        const circle = walk({ x: 0, z: 0 }, { x: 5, z: 0 }, [wall(centered(400, 400), "circle")]);
        expect(circle.x).toBeCloseTo(2 - WALL_THICKNESS_M - WALKER_RADIUS_M, 1);
        const diamond = walk({ x: 0, z: 0 }, { x: 5, z: 0 }, [wall(centered(400, 400), "diamond")]);
        expect(diamond.x).toBeLessThan(2 - WALL_THICKNESS_M);
        expect(diamond.x).toBeGreaterThan(1);
    });

    it("keeps a walker on the stage floor", () => {
        const end = walk({ x: 0, z: 0 }, { x: -20, z: 20 }, []);
        expect(end.x).toBeCloseTo(-6 + WALKER_RADIUS_M, 5);
        expect(end.z).toBeCloseTo(4 - WALKER_RADIUS_M, 5);
    });

    it("does not squeeze a running walker between a wall and the floor's edge through a gap narrower than itself", () => {
        const nearEdge = wall({ x: 2200 - 40 - 12, y: 2400, width: 12, height: 200 });
        let p = { x: 6 - WALKER_RADIUS_M, z: -1 };
        for (let frame = 0; frame < 20; frame++) p = walk(p, { x: 0.05, z: 0.23 }, [nearEdge]);
        expect(p.z).toBeLessThan(0);
    });

    it("stands a walker in the middle of a floor narrower than itself", () => {
        const narrow: Rect = { x: 0, y: 0, width: 30, height: 800 };
        const end = moveWalker({ x: 0.1, z: 0 }, { x: 1, z: 0 }, [], floorBounds(narrow));
        expect(end.x).toBeCloseTo(0, 6);
    });
});

describe("settling a walker after the stage changes", () => {
    const home = { x: -5, z: 3 };
    const settle = (at: Point, walls: WallItem[], within = bounds) =>
        settleWalker(
            at,
            home,
            walls.flatMap((w) => wallEdges(wallPlan(w, frame))),
            within,
        );

    it("leaves a walker where it stands when it is clear", () => {
        expect(settle({ x: 1, z: 1 }, [wall(centered(400, 10))])).toEqual({ x: 1, z: 1 });
    });

    it("leaves a walker resting in a tight corner it walked into", () => {
        const leaning = wall(
            { x: 1975, y: 2400 + 75 * Math.sqrt(3) - 6, width: 300, height: 12 },
            "rect",
            -Math.PI / 3,
        );
        let p = { x: 6 - WALKER_RADIUS_M, z: 3 };
        for (let frame = 0; frame < 120; frame++) p = walk(p, { x: 0.02, z: -0.04 }, [leaning]);
        const end = settle(p, [leaning]);
        expect(Math.hypot(end.x - p.x, end.z - p.z)).toBeLessThan(0.01);
    });

    it("moves a walker out of a wall drawn over it, to the side it was nearer", () => {
        const end = settle({ x: 1, z: -0.02 }, [wall(centered(400, 12))]);
        const touching = -WALL_THICKNESS_M / 2 - WALKER_RADIUS_M;
        expect(end.x).toBeCloseTo(1, 5);
        expect(end.z).toBeLessThanOrEqual(touching);
        expect(end.z).toBeGreaterThan(touching - WALKER_RADIUS_M / 4);
    });

    it("moves a walker standing in the middle of a thin solid wall to a spot clear of it", () => {
        const slab = wall(centered(400, 34));
        expect(wallPlan(slab, frame).hollow).toBe(false);
        const end = settle({ x: 1, z: 0 }, [slab]);
        expect(Math.abs(end.z)).toBeGreaterThanOrEqual(0.17 + WALKER_RADIUS_M - 1e-9);
        expect(Math.hypot(end.x - 1, end.z)).toBeLessThan(1);
    });

    it("moves a walker standing where two solid walls cross", () => {
        const end = settle({ x: 0, z: 0 }, [wall(centered(400, 34)), wall(centered(34, 400))]);
        expect(Math.abs(end.x)).toBeGreaterThanOrEqual(0.17 + WALKER_RADIUS_M - 1e-9);
        expect(Math.abs(end.z)).toBeGreaterThanOrEqual(0.17 + WALKER_RADIUS_M - 1e-9);
    });

    it("leaves a walker standing inside a drawn room", () => {
        expect(settle({ x: 0.5, z: 0.5 }, [wall(centered(400, 300))])).toEqual({ x: 0.5, z: 0.5 });
    });

    it("brings a walker back onto a floor that shrank", () => {
        const shrunk = floorBounds({ ...frame, x: 1300, width: 600 });
        expect(settle({ x: 5, z: 0 }, [], shrunk)).toEqual({ x: 3 - WALKER_RADIUS_M, z: 0 });
    });

    it("sends a walker home when no spot nearby is clear", () => {
        const slats = Array.from({ length: 13 }, (_, k) =>
            wall({ x: 1300, y: 2400 + (k - 6) * 40 - 6, width: 700, height: 12 }),
        );
        expect(settle({ x: 0, z: 0.05 }, slats)).toEqual(home);
    });
});

describe("the heading a walker spawns with", () => {
    const box = (minX: number, maxX: number, minZ: number, maxZ: number) => {
        const corners = [
            { x: minX, z: minZ },
            { x: maxX, z: minZ },
            { x: maxX, z: maxZ },
            { x: minX, z: maxZ },
        ];
        return corners.map((a, i) => ({ a, b: corners[(i + 1) % 4] }));
    };
    const floor = { minX: -5, maxX: 5, minZ: -3, maxZ: 3 };

    it("looks into a room, not at the wall beside a doorway", () => {
        const partition = [...box(-0.06, 0.06, -3, -0.6), ...box(-0.06, 0.06, 0.6, 3)];
        const heading = openHeading({ x: 0, z: 0 }, partition, floor);
        expect(Math.abs(Math.sin(heading))).toBeGreaterThan(0.9);
    });

    it("looks across the floor from beside its edge", () => {
        expect(Math.cos(openHeading({ x: 0, z: 2.9 }, [], floor))).toBeLessThan(-0.5);
        expect(Math.cos(openHeading({ x: 0, z: -2.9 }, [], floor))).toBeGreaterThan(0.5);
    });
});

describe("a frame that changes under a walker", () => {
    it("keeps the walker on the same board spot when the frame is resized", () => {
        const grown: Rect = { x: 800, y: 2000, width: 1400, height: 900 };
        const at = refloor({ x: 1, z: -1 }, frame, grown);
        expect(at.x).toBeCloseTo(canvasToWorld(1700, 2300, grown).x, 9);
        expect(at.z).toBeCloseTo(canvasToWorld(1700, 2300, grown).z, 9);
    });

    it("carries the walker along when the frame moves with everything in it", () => {
        expect(refloor({ x: 1, z: -1 }, frame, { ...frame, x: 4000, y: -300 })).toEqual({ x: 1, z: -1 });
    });
});

describe("cutouts", () => {
    const cutout = (width: number, asset: { width: number; height: number }) =>
        cutoutPlan(
            { kind: "cutout", id: "c", rect: { x: 1100, y: 2100, width, height: 290 }, asset: { hash: "h", ...asset } },
            frame,
        );

    it("stands at its rect center, as wide as the rect, as tall as the picture's proportions", () => {
        const plan = cutout(100, { width: 300, height: 150 });
        expect(plan.center).toEqual({ x: -4.5, z: -1.55 });
        expect(plan.width).toBe(1);
        expect(plan.height).toBe(0.5);
    });

    it("shrinks a default sticky to person height, keeping its foot and proportions", () => {
        const plan = cutout(200, { width: 400, height: 386 });
        expect(plan.center).toEqual({ x: -4, z: -1.55 });
        expect(plan.height).toBeCloseTo(1.2, 9);
        expect(plan.width / plan.height).toBeCloseTo(400 / 386, 9);
    });
});

describe("hands", () => {
    const person = { presenceId: "p", name: "Ann", color: "#a855f7" };

    it("hovers over the cursor's spot on the stage", () => {
        const plan = handPlan({ ...person, x: 1700, y: 2300 }, frame);
        expect(plan).toEqual({ position: { x: 1, z: -1 }, hoverHeight: 2.2, inFrame: true });
    });

    it("reports a cursor outside the frame", () => {
        expect(handPlan({ ...person, x: 999, y: 2300 }, frame).inFrame).toBe(false);
        expect(handPlan({ ...person, x: 1700, y: 2801 }, frame).inFrame).toBe(false);
    });
});
