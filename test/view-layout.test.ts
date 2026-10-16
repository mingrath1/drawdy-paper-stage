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
});

describe("cutouts", () => {
    it("stands at its rect center, as wide as the rect, as tall as the picture's proportions", () => {
        const plan = cutoutPlan(
            {
                kind: "cutout",
                id: "c",
                rect: { x: 1100, y: 2100, width: 150, height: 290 },
                asset: { hash: "h", width: 300, height: 600 },
            },
            frame,
        );
        expect(plan.center).toEqual({ x: -4.25, z: -1.55 });
        expect(plan.width).toBe(1.5);
        expect(plan.height).toBe(3);
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
