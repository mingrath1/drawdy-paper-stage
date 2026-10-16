import { describe, expect, it } from "vitest";
import {
    findFreeSpot,
    findStageFrame,
    newStageMeta,
    parseStageMeta,
    STAGE_SIZE,
    starterStage,
} from "../src/stage-frame";
import { projectStage, reduceScene, type BoardElement } from "../src/stage-model";

const meta = { v: 1 as const, stageId: "s1", token: "t1" };

describe("parseStageMeta", () => {
    it("reads a valid stage marker", () => {
        expect(parseStageMeta({ paperStage: meta, other: 1 })).toEqual(meta);
    });

    it.each([null, {}, { paperStage: { ...meta, v: 2 } }, { paperStage: { ...meta, token: "" } }, { paperStage: "x" }])(
        "rejects %o",
        (input) => {
            expect(parseStageMeta(input)).toBeNull();
        },
    );
});

describe("findStageFrame", () => {
    it("finds the frame that carries the marker", () => {
        const elements: BoardElement[] = [
            { id: "f1", type: "frame", x: 0, y: 0, width: 10, height: 10, meta: {} },
            { id: "f2", type: "frame", x: 5, y: 6, width: 7, height: 8, meta: { paperStage: meta } },
        ];
        expect(findStageFrame(elements)).toEqual({ id: "f2", meta, rect: { x: 5, y: 6, width: 7, height: 8 } });
    });
});

describe("newStageMeta", () => {
    it("makes a fresh random stage id and token each time", () => {
        const a = newStageMeta();
        const b = newStageMeta();
        expect(a.stageId).toMatch(/^[0-9a-f]{24}$/);
        expect(a.token).toMatch(/^[0-9a-f]{48}$/);
        expect(a.stageId).not.toBe(b.stageId);
        expect(a.token).not.toBe(b.token);
    });
});

describe("findFreeSpot", () => {
    const viewport = { x: 0, y: 0, width: 1200, height: 800 };

    it("centers the stage in an empty viewport", () => {
        expect(findFreeSpot(viewport, [])).toEqual({ x: 150, y: 120 });
    });

    it("moves to the nearest empty spot when the middle is taken", () => {
        const occupied = [{ x: 500, y: 300, width: 200, height: 200 }];
        const spot = findFreeSpot(viewport, occupied);
        const placed = { ...spot, ...STAGE_SIZE };
        expect(
            placed.x + placed.width < 500 || placed.x > 700 || placed.y + placed.height < 300 || placed.y > 500,
        ).toBe(true);
    });
});

describe("starterStage", () => {
    let n = 0;
    const schemas = starterStage(
        { x: 1000, y: 2000 },
        meta,
        { ink: "#1e1e1e", wall: "#e8dcc4", pawn: "#e8590c" },
        () => `id${n++}`,
    );
    const [frame, ...children] = schemas;

    it("puts the frame first, then children that all belong to it", () => {
        expect(frame).toMatchObject({
            type: "frame",
            name: "Paper Stage",
            position: [1000, 2000],
            meta: { paperStage: meta },
        });
        expect(children.every((child) => child.frameId === frame.drawdyElementId)).toBe(true);
        expect(new Set(schemas.map((schema) => schema.drawdyElementId)).size).toBe(schemas.length);
    });

    it("projects to six walls and one pawn, with a doorway in the middle wall", () => {
        const elements: BoardElement[] = schemas.map((schema) =>
            schema.type === "frame"
                ? {
                      id: schema.drawdyElementId,
                      type: "frame",
                      x: schema.position[0],
                      y: schema.position[1],
                      width: schema.width,
                      height: schema.height,
                      meta: schema.meta,
                  }
                : ({ ...schema, id: schema.drawdyElementId, type: "path", rotation: 0 } as BoardElement),
        );
        const state = reduceScene(
            { frameId: frame.drawdyElementId, elements: new Map() },
            { type: "loaded", elements },
        );
        const items = projectStage(state)!.items;
        expect(items.filter((item) => item.kind === "wall")).toHaveLength(6);
        expect(items.filter((item) => item.kind === "pawn")).toHaveLength(1);

        const middle = items.flatMap((item) =>
            item.kind === "wall" && item.rect.width < 20 && item.rect.x > 1300 && item.rect.x < 1500 ? [item.rect] : [],
        );
        expect(middle).toHaveLength(2);
        const [upper, lower] = middle.sort((a, b) => a.y - b.y);
        expect(lower.y - (upper.y + upper.height)).toBeGreaterThanOrEqual(100);
    });
});
