import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rect, StageItem, StageSnapshot } from "../shared/protocol";
import { AssetCache } from "../view/assets";
import { StageModel } from "../view/stage";
import { DirectionalLight, Mesh, Texture, type Object3D } from "../view/vendor/three.module.js";

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

beforeEach(() => {
    vi.stubGlobal("document", { createElement: fakeCanvas });
    vi.stubGlobal("Path2D", class { arc() {} roundRect() {} });
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

/** The pictures on meshes the renderer would draw. */
function drawnPictures(root: Object3D): string[] {
    const names: string[] = [];
    const visit = (object: Object3D) => {
        if (!object.visible) return;
        if (object instanceof Mesh) {
            const material = object.material as { map?: Texture | null; colorWrite: boolean };
            if (material.colorWrite && material.map?.name) names.push(material.map.name);
        }
        object.children.forEach(visit);
    };
    visit(root);
    return names.sort();
}

describe("cutout pictures", () => {
    it("fetches a shared picture once and frees it only when its last cutout goes", async () => {
        const { stage, fetched, freed, arrive } = stageHarness();
        stage.load(snapshot([cutout("a", "tree"), cutout("b", "tree", 300)]));
        await arrive("tree");
        stage.update(1);
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
        stage.update(1);
        expect(drawnPictures(stage.root)).toEqual(["tree"]);
        stage.apply({ upserts: [cutout("a", "tree-2")], removes: [] });
        stage.update(0.016);
        expect(drawnPictures(stage.root)).toEqual([]);
        expect(freed).toEqual(["tree"]);
        await arrive("tree-2");
        stage.update(0.016);
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
