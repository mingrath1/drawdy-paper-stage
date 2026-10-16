import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    WALKER_TTL_MS,
    canvasToWorld,
    worldToCanvas,
    type Rect,
    type StageItem,
    type StageSnapshot,
    type Walker,
} from "../shared/protocol";
import { AssetCache } from "../view/assets";
import { Bodies } from "../view/bodies";
import { HAND_TTL_MS, Hands } from "../view/hands";
import { Hud } from "../view/hud";
import { StageModel } from "../view/stage";
import { WalkControls } from "../view/walk";
import { DirectionalLight, Mesh, Texture, Vector3, type Object3D } from "../view/vendor/three.module.js";

/** Just enough of a canvas for the view's drawings to run in Node. Nothing is drawn. */
function fakeCanvas() {
    const context = new Proxy(
        {},
        {
            get: (_, key) =>
                key === "getImageData"
                    ? () => ({ data: new Uint8ClampedArray(4) })
                    : key === "measureText"
                      ? () => ({ width: 40 })
                      : key === "createRadialGradient"
                        ? () => ({ addColorStop() {} })
                        : () => {},
            set: () => true,
        },
    );
    return { width: 0, height: 0, getContext: () => context };
}

/** A canvas element that records its listeners so a test can fire pointer events at it. */
function fakeSurface() {
    const listeners = new Map<string, (event: object) => void>();
    const element = {
        addEventListener: (type: string, listener: (event: object) => void) => listeners.set(type, listener),
        setPointerCapture() {},
    };
    return { element: element as unknown as HTMLElement, fire: (type: string, event: object) => listeners.get(type)?.(event) };
}

/** Listeners the view added to its window, by event type. */
let windowListeners: Map<string, ((event: object) => void)[]>;

beforeEach(() => {
    windowListeners = new Map();
    vi.stubGlobal("document", { createElement: fakeCanvas });
    vi.stubGlobal("Path2D", class { arc() {} roundRect() {} });
    vi.stubGlobal("addEventListener", (type: string, listener: (event: object) => void) =>
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]),
    );
    vi.stubGlobal("focus", () => {});
});
afterEach(() => vi.unstubAllGlobals());

const frame: Rect = { x: 0, y: 0, width: 1200, height: 800 };

function cutout(id: string, hash: string, x = 100, y = 100): StageItem {
    return { kind: "cutout", id, rect: { x, y, width: 100, height: 100 }, asset: { hash, width: 100, height: 100 } };
}

function snapshot(items: StageItem[], at: Rect = frame): StageSnapshot {
    return { revision: 1, frame: at, items };
}

/** A stage whose pictures arrive when the test says, recording what was fetched and freed. */
function stageHarness() {
    const pictures = new Map<string, Texture>();
    const waiting = new Map<string, () => void>();
    const fetched: string[] = [];
    const freed: string[] = [];
    const textures = new AssetCache<Texture>(
        (hash) => {
            fetched.push(hash);
            return new Promise((resolve) =>
                waiting.set(hash, () => {
                    const picture = new Texture();
                    picture.name = hash;
                    pictures.set(hash, picture);
                    resolve(picture);
                }),
            );
        },
        (picture) => freed.push(picture.name),
    );
    const stage = new StageModel(textures, new DirectionalLight(), 1);
    const arrive = async (...hashes: string[]) => {
        for (const hash of hashes) waiting.get(hash)!();
        await Promise.resolve();
        await Promise.resolve();
    };
    return { stage, fetched, freed, arrive };
}

type Painted = { map?: Texture | null; colorWrite: boolean };

/** Visible meshes that carry a cutout picture, as the renderer and the shadow pass would find them. */
function pictureMeshes(root: Object3D): Mesh[] {
    const found: Mesh[] = [];
    const visit = (object: Object3D) => {
        if (!object.visible) return;
        if (object instanceof Mesh && (object.material as Painted).map?.name) found.push(object);
        object.children.forEach(visit);
    };
    root.updateMatrixWorld(true);
    visit(root);
    return found;
}

/** The pictures on meshes the renderer would draw. */
function drawnPictures(root: Object3D): string[] {
    return pictureMeshes(root)
        .filter((mesh) => (mesh.material as Painted).colorWrite)
        .map((mesh) => (mesh.material as Painted).map!.name)
        .sort();
}

const eye = { x: 0, z: 0 };

describe("cutout pictures", () => {
    it("fetches a shared picture once and frees it only when its last cutout goes", async () => {
        const { stage, fetched, freed, arrive } = stageHarness();
        stage.load(snapshot([cutout("a", "tree"), cutout("b", "tree", 300)]));
        await arrive("tree");
        stage.update(1, eye);
        expect(fetched).toEqual(["tree"]);
        expect(drawnPictures(stage.root)).toEqual(["tree", "tree"]);
        stage.apply({ upserts: [], removes: ["a"] });
        expect(freed).toEqual([]);
        stage.apply({ upserts: [], removes: ["b"] });
        expect(freed).toEqual(["tree"]);
    });

    it("frees every picture a reset no longer shows", async () => {
        const { stage, freed, arrive } = stageHarness();
        stage.load(snapshot([cutout("a", "tree"), cutout("b", "star")]));
        await arrive("tree", "star");
        stage.load(snapshot([cutout("c", "cart"), cutout("b", "star")]));
        expect(freed).toEqual(["tree"]);
        stage.apply({ reset: true, upserts: [], removes: [] });
        expect(freed.sort()).toEqual(["star", "tree"]);
    });

    it("hides the old picture when a cutout's drawing changes, then shows the new one when it arrives", async () => {
        const { stage, freed, arrive } = stageHarness();
        stage.load(snapshot([cutout("a", "tree")]));
        await arrive("tree");
        stage.update(1, eye);
        expect(drawnPictures(stage.root)).toEqual(["tree"]);
        stage.apply({ upserts: [cutout("a", "tree-2")], removes: [] });
        stage.update(0.016, eye);
        expect(drawnPictures(stage.root)).toEqual([]);
        expect(freed).toEqual(["tree"]);
        await arrive("tree-2");
        stage.update(0.016, eye);
        expect(drawnPictures(stage.root)).toEqual(["tree-2"]);
    });

    it("frees a picture that arrives after its cutout was deleted", async () => {
        const { stage, freed, arrive } = stageHarness();
        stage.load(snapshot([cutout("a", "tree")]));
        stage.apply({ upserts: [], removes: ["a"] });
        await arrive("tree");
        expect(freed).toEqual(["tree"]);
    });
});

describe("cutouts facing the viewer", () => {
    /** A cutout standing on the frame center, which is the world origin. */
    const centered = cutout("a", "tree", 550, 350);

    it("turns each picture's front to the eye every frame while its foot stays put", async () => {
        const { stage, arrive } = stageHarness();
        stage.load(snapshot([centered]));
        await arrive("tree");
        for (const eye of [{ x: 3, z: 0 }, { x: 0, z: -2 }, { x: -1, z: 1.5 }]) {
            stage.update(1, eye);
            const [face] = pictureMeshes(stage.root).filter((mesh) => (mesh.material as Painted).colorWrite);
            const foot = face.localToWorld(new Vector3(0, 0, 0));
            expect(foot.x).toBeCloseTo(0, 6);
            expect(foot.z).toBeCloseTo(0, 6);
            const front = face.getWorldDirection(new Vector3());
            const toEye = new Vector3(eye.x - foot.x, 0, eye.z - foot.z).normalize();
            expect(front.dot(toEye)).toBeCloseTo(1, 6);
        }
    });

    it("casts the drawing's shadow the same way wherever the viewer stands", async () => {
        const { stage, arrive } = stageHarness();
        stage.load(snapshot([centered]));
        await arrive("tree");
        const casters = (eye: { x: number; z: number }) => {
            stage.update(1, eye);
            return pictureMeshes(stage.root)
                .filter((mesh) => mesh.castShadow)
                .map((mesh) => mesh.matrixWorld.clone());
        };
        const fromEast = casters({ x: 3, z: 0 });
        const fromNorth = casters({ x: 0, z: -3 });
        expect(fromEast).toHaveLength(1);
        expect(fromNorth[0].equals(fromEast[0])).toBe(true);
    });
});

describe("where the walker stands", () => {
    const pawn: StageItem = { kind: "pawn", id: "pawn", x: 300, y: 600 };

    it("waits out a new stage's empty frame and spawns at the pawn once the writer commits", () => {
        const { stage } = stageHarness();
        const walk = new WalkControls(fakeSurface().element);
        stage.load({ revision: 0, frame: { x: 0, y: 0, width: 0, height: 0 }, items: [] });
        walk.settle(stage, null);
        expect(stage.frame).toBeNull();
        const before = stage.frame;
        stage.apply({ reset: true, frame, upserts: [pawn], removes: [] });
        walk.settle(stage, before);
        expect(walk.position).toEqual(canvasToWorld(300, 600, frame));
    });

    it("keeps where it walked across a reconnect, and steps clear of a wall drawn onto it", () => {
        const { stage } = stageHarness();
        const walk = new WalkControls(fakeSurface().element);
        stage.load(snapshot([pawn]));
        walk.settle(stage, null);
        walk.position = { x: 2, z: 1 };
        stage.load(snapshot([pawn]));
        walk.settle(stage, frame);
        expect(walk.position).toEqual({ x: 2, z: 1 });
        const across: StageItem = {
            kind: "wall",
            id: "w",
            shape: "rect",
            rotation: 0,
            rect: { x: 700, y: 494, width: 200, height: 12 },
        };
        stage.apply({ upserts: [across], removes: [] });
        walk.settle(stage, frame);
        expect(Math.abs(walk.position.z - 1)).toBeGreaterThanOrEqual(0.31);
    });

    it("keeps its spot on the board when the frame is resized under it", () => {
        const { stage } = stageHarness();
        const walk = new WalkControls(fakeSurface().element);
        stage.load(snapshot([pawn]));
        walk.settle(stage, null);
        const spot = worldToCanvas(walk.position.x, walk.position.z, frame);
        const grown: Rect = { x: -400, y: 0, width: 1600, height: 800 };
        stage.apply({ frame: grown, upserts: [], removes: [] });
        walk.settle(stage, frame);
        const after = worldToCanvas(walk.position.x, walk.position.z, grown);
        expect(after.x).toBeCloseTo(spot.x, 6);
        expect(after.y).toBeCloseTo(spot.y, 6);
    });
});

describe("hands", () => {
    const ann = { presenceId: "ann", name: "Ann", color: "#a855f7", x: 600, y: 400 };
    const me = { presenceId: "me", name: "Me", color: "#f97316", x: 500, y: 400 };
    const visibleHands = (hands: Hands) => hands.root.children.filter((hand) => hand.visible).length;
    const runFor = (hands: Hands, from: number, ms: number) => {
        for (let t = from; t <= from + ms; t += 100) hands.update(0.1, t, frame);
    };

    it("never shows this viewer's own hand", () => {
        const hands = new Hands("me");
        hands.set([ann, me], frame, 0);
        runFor(hands, 0, 1000);
        expect(visibleHands(hands)).toBe(1);
        expect(hands.presenceIds(1000)).toEqual(["ann"]);
    });

    it("fades out and deletes a hand that has not been heard from for a while", () => {
        const hands = new Hands("me");
        hands.set([ann], frame, 0);
        runFor(hands, 0, HAND_TTL_MS - 100);
        expect(visibleHands(hands)).toBe(1);
        runFor(hands, HAND_TTL_MS, 2000);
        expect(hands.root.children).toHaveLength(0);
        expect(hands.presenceIds(HAND_TTL_MS + 2000)).toEqual([]);
    });

    it("keeps a hand that is heard from again", () => {
        const hands = new Hands("me");
        hands.set([ann], frame, 0);
        runFor(hands, 0, HAND_TTL_MS - 100);
        hands.set([{ ...ann, x: 700 }], frame, HAND_TTL_MS - 100);
        runFor(hands, HAND_TTL_MS, 2000);
        expect(visibleHands(hands)).toBe(1);
    });

    it("fades out every hand when cleared, as on a welcome, a disconnect, or a new writer", () => {
        const hands = new Hands("me");
        hands.set([ann], frame, 0);
        runFor(hands, 0, 1000);
        hands.clear();
        runFor(hands, 1100, 2000);
        expect(hands.root.children).toHaveLength(0);
        hands.set([ann], frame, 3200);
        runFor(hands, 3200, 1000);
        expect(visibleHands(hands)).toBe(1);
    });
});

describe("bodies", () => {
    const mali: Walker = {
        connectionId: "c1",
        participant: { presenceId: "mali", name: "Mali", color: "#0ea5e9" },
        pose: { x: 600, y: 400, heading: 0, pitch: 0 },
    };

    it("removes and frees a quiet walker's body once it has faded, and brings it back with the next pose", () => {
        const bodies = new Bodies();
        bodies.set(mali, frame, 0);
        const freed: string[] = [];
        bodies.root.traverse((object) => {
            const material = (object as Mesh).material as Mesh["material"] | undefined;
            if (material && !Array.isArray(material)) material.addEventListener("dispose", () => freed.push(object.type));
        });
        for (let t = 0; t <= WALKER_TTL_MS + 2000; t += 100) bodies.update(0.1, t, frame);
        expect(bodies.root.children).toHaveLength(0);
        expect(freed.sort()).toEqual(["Mesh", "Sprite"]);
        bodies.set(mali, frame, WALKER_TTL_MS + 2100);
        bodies.update(0.1, WALKER_TTL_MS + 2200, frame);
        expect(bodies.root.children.filter((body) => body.visible)).toHaveLength(1);
    });
});

describe("looking around", () => {
    const press = { pointerId: 1, clientX: 100, clientY: 100 };

    it("stops turning once the button is up, even when it was released outside the view", () => {
        const surface = fakeSurface();
        const walk = new WalkControls(surface.element);
        surface.fire("pointerdown", press);
        surface.fire("pointermove", { ...press, clientX: 150, buttons: 1 });
        const turned = walk.heading;
        expect(turned).not.toBe(Math.PI);
        surface.fire("pointermove", { ...press, clientX: 300, buttons: 0 });
        surface.fire("pointermove", { ...press, clientX: 400, buttons: 0 });
        expect(walk.heading).toBe(turned);
    });

    it("forgets a drag when the pointer leaves the view or loses capture", () => {
        for (const ending of ["pointerleave", "lostpointercapture"]) {
            const surface = fakeSurface();
            const walk = new WalkControls(surface.element);
            surface.fire("pointerdown", press);
            surface.fire(ending, press);
            surface.fire("pointermove", { ...press, clientX: 300, buttons: 1 });
            expect(walk.heading, ending).toBe(Math.PI);
        }
    });
});

describe("the HUD", () => {
    it("toggles the frame rate once per press of F, however long the key is held", () => {
        vi.useFakeTimers();
        const elements = new Map<string, { hidden: boolean; dataset: object; textContent: string }>();
        vi.stubGlobal("document", {
            getElementById: (id: string) => {
                if (!elements.has(id)) elements.set(id, { hidden: true, dataset: {}, textContent: "" });
                return elements.get(id);
            },
        });
        new Hud();
        const key = (repeat: boolean) =>
            windowListeners.get("keydown")!.forEach((listener) => listener({ code: "KeyF", repeat }));
        key(false);
        expect(elements.get("fps")!.hidden).toBe(false);
        key(true);
        expect(elements.get("fps")!.hidden).toBe(false);
        key(true);
        expect(elements.get("fps")!.hidden).toBe(false);
        key(false);
        expect(elements.get("fps")!.hidden).toBe(true);
        vi.useRealTimers();
    });
});
