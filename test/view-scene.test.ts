import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasToWorld, worldToCanvas, type Rect, type StageItem, type StageSnapshot } from "../shared/protocol";
import { AssetCache } from "../view/assets";
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

beforeEach(() => {
    vi.stubGlobal("document", { createElement: fakeCanvas });
    vi.stubGlobal("Path2D", class { arc() {} roundRect() {} });
    vi.stubGlobal("addEventListener", () => {});
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
