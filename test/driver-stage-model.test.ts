import { describe, expect, it } from "vitest";
import { MAX_CUTOUTS_PER_STAGE } from "../shared/protocol";
import {
    belongsToStage,
    classify,
    hexColor,
    projectStage,
    reduceScene,
    type BoardElement,
    type SceneState,
} from "../src/stage-model";

const FRAME_ID = "frame";
const frame: BoardElement = { id: FRAME_ID, type: "frame", x: 0, y: 0, width: 900, height: 560, meta: {} };

function el(id: string, props: Partial<BoardElement>): BoardElement {
    return { id, x: 100, y: 100, width: 40, height: 20, rotation: 0, ...props } as BoardElement;
}

function stage(...elements: BoardElement[]): SceneState {
    return reduceScene({ frameId: FRAME_ID, elements: new Map() }, { type: "loaded", elements: [frame, ...elements] });
}

describe("classify", () => {
    it.each([
        [{ type: "path", componentType: "rect" }, "wall"],
        [{ type: "path", componentType: "circle" }, "wall"],
        [{ type: "path", componentType: "diamond" }, "wall"],
        [{ type: "path", componentType: "sticky-note" }, "cutout"],
        [{ type: "freedraw" }, "cutout"],
        [{ type: "text" }, "cutout"],
        [{ type: "image" }, "cutout"],
        [{ type: "path", componentType: "circle", meta: { paperStageRole: "pawn" } }, "pawn"],
        [{ type: "path" }, "cutout"],
        [{ type: "frame" }, null],
        [{ type: "component" }, null],
        [{ type: "path", componentType: "rect", meta: { paperStageRole: "something-else" } }, "wall"],
    ] as const)("%o is %s", (props, role) => {
        expect(classify(el("e", props as Partial<BoardElement>))).toBe(role);
    });
});

describe("belongsToStage", () => {
    const rect = { x: 0, y: 0, width: 900, height: 560 };
    it("counts an element whose frameId is the stage, wherever it sits", () => {
        expect(belongsToStage(el("e", { frameId: FRAME_ID, x: 5000 }), FRAME_ID, rect)).toBe(true);
    });
    it("counts an element whose center lies inside the frame", () => {
        expect(belongsToStage(el("e", { x: 880, y: 540, width: 30, height: 30 }), FRAME_ID, rect)).toBe(true);
    });
    it("leaves out an element whose center lies outside the frame", () => {
        expect(belongsToStage(el("e", { x: 890, y: 100, width: 40, height: 20 }), FRAME_ID, rect)).toBe(false);
    });
    it("leaves out an element without geometry", () => {
        expect(belongsToStage({ id: "e", type: "freedraw" }, FRAME_ID, rect)).toBe(false);
    });
});

describe("reduceScene", () => {
    it("adds, updates, and removes elements", () => {
        let state = stage();
        state = reduceScene(state, { type: "changed", upserted: [el("a", { type: "text" })], removed: [] });
        state = reduceScene(state, { type: "changed", upserted: [el("a", { type: "text", x: 300 })], removed: [] });
        expect(state.elements.get("a")?.x).toBe(300);
        state = reduceScene(state, { type: "changed", upserted: [], removed: ["a"] });
        expect(state.elements.has("a")).toBe(false);
    });

    it("keeps the new copy when a replace removes and re-adds the same id", () => {
        const state = reduceScene(stage(el("a", { type: "text", text: "old" })), {
            type: "changed",
            upserted: [el("a", { type: "text", text: "new" })],
            removed: ["a"],
        });
        expect(state.elements.get("a")?.text).toBe("new");
    });

    it("replaces a frameId with nothing when a later copy has none", () => {
        let state = stage(el("a", { type: "text", frameId: FRAME_ID }));
        state = reduceScene(state, { type: "changed", upserted: [el("a", { type: "text", x: 5000 })], removed: [] });
        expect(projectStage(state)?.items).toEqual([]);
    });

    it("does not mutate the previous state", () => {
        const before = stage(el("a", { type: "text" }));
        reduceScene(before, { type: "changed", upserted: [], removed: ["a"] });
        expect(before.elements.has("a")).toBe(true);
    });
});

describe("projectStage", () => {
    it("is null once the stage frame is gone", () => {
        const state = reduceScene(stage(), { type: "changed", upserted: [], removed: [FRAME_ID] });
        expect(projectStage(state)).toBeNull();
    });

    it("turns members into walls, cutouts, and one pawn, and ignores the rest", () => {
        const state = stage(
            el("wall", { type: "path", componentType: "rect", fillColor: "#e8dcc4", rotation: 0.5 }),
            el("pawn", {
                type: "path",
                componentType: "circle",
                meta: { paperStageRole: "pawn" },
                x: 200,
                y: 200,
                width: 36,
                height: 36,
            }),
            el("pawn2", { type: "path", componentType: "circle", meta: { paperStageRole: "pawn" } }),
            el("doodle", {
                type: "freedraw",
                points: [
                    [100, 100],
                    [140, 120],
                ],
            }),
            el("triangle", { type: "path" }),
            el("outside", { type: "path", componentType: "rect", x: 2000 }),
        );
        const projection = projectStage(state)!;
        expect(projection.frame).toEqual({ x: 0, y: 0, width: 900, height: 560 });
        expect(projection.items.map((item) => [item.kind, item.id])).toEqual([
            ["pawn", "pawn"],
            ["wall", "wall"],
            ["cutout", "doodle"],
            ["cutout", "triangle"],
        ]);
        expect(projection.items[0]).toEqual({ kind: "pawn", id: "pawn", x: 218, y: 218 });
        expect(projection.items[1]).toMatchObject({
            shape: "rect",
            rotation: 0.5,
            color: "#e8dcc4",
            rect: { x: 100, y: 100, width: 40, height: 20 },
        });
    });

    it("gives a cutout the padded screenshot area as its rect", () => {
        const projection = projectStage(
            stage(el("doodle", { type: "freedraw", x: 100, y: 100, width: 40, height: 20 })),
        )!;
        expect(projection.items[0]).toMatchObject({ kind: "cutout", rect: { x: 96, y: 96, width: 48, height: 28 } });
    });

    it("follows the frame when it moves", () => {
        let state = stage(el("doodle", { type: "freedraw", x: 100, y: 100 }));
        state = reduceScene(state, { type: "changed", upserted: [{ ...frame, x: 1000 }], removed: [] });
        expect(projectStage(state)!.items).toEqual([]);
    });

    it(`keeps the first ${MAX_CUTOUTS_PER_STAGE} cutouts and counts the rest`, () => {
        const doodles = Array.from({ length: 70 }, (_, i) => el(`d${i}`, { type: "freedraw", x: 10 + i * 10, y: 50 }));
        const projection = projectStage(stage(...doodles))!;
        expect(projection.items).toHaveLength(MAX_CUTOUTS_PER_STAGE);
        expect(projection.items.at(-1)?.id).toBe("d59");
        expect(projection.dropped).toEqual({ cutouts: 10, items: 0 });
    });
});

// Expected values are what Chrome's canvas paints for the same CSS color.
describe("hexColor", () => {
    it.each([
        ["#E8DCC4", "#e8dcc4"],
        ["#abc", "#aabbcc"],
        ["oklch(1 0 0)", "#ffffff"],
        ["oklch(0 0 0)", "#000000"],
        ["oklch(62.8% 0.2577 29.23)", "#ff0000"],
        ["oklch(0.93 0.005 260 / 0.5)", "#e6e8eb"],
        ["oklch(0.5 0.1 140)", "#427138"],
        ["transparent", null],
        [undefined, null],
    ])("%s is %s", (input, hex) => {
        expect(hexColor(input)).toBe(hex);
    });
});
