import { canvasToWorld, type ElementId, type Rect, type StageItem, type StageSnapshot } from "../shared/protocol";
import {
    BufferGeometry,
    Color,
    ConeGeometry,
    DirectionalLight,
    EdgesGeometry,
    ExtrudeGeometry,
    Float32BufferAttribute,
    Group,
    LineBasicMaterial,
    LineLoop,
    LineSegments,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    Path,
    PlaneGeometry,
    RingGeometry,
    Shape,
    Vector2,
    type Object3D,
    type Texture,
} from "./vendor/three.module.js";
import type { AssetCache } from "./assets";
import { INK, PAPER, floorPaper, paperMaterial } from "./drawings";
import {
    cutoutPlan,
    floorBounds,
    wallEdges,
    wallOutlines,
    wallPlan,
    type Bounds,
    type CutoutItem,
    type Point,
    type Segment,
    type WallItem,
} from "./layout";
import { angleBetween } from "./pose";

type PawnItem = Extract<StageItem, { kind: "pawn" }>;
type Placement = { x: number; z: number; yaw: number };

type Node = {
    item: StageItem;
    object: Object3D;
    target: Placement;
    /** 0 while hidden, rising to 1 as a wall grows out of the floor or a cutout stands up. */
    rise: number;
};

/** How each kind of stage item is built, updated in place, and placed. One entry per `StageItem` kind. */
type Kind<I extends StageItem> = {
    create(item: I, frame: Rect, stage: StageModel): Object3D;
    /** Applies a new version of the item. Placement is handled for every kind by the caller. */
    update(object: Object3D, item: I, previous: I, frame: Rect, stage: StageModel): void;
    place(item: I, frame: Rect): Placement;
    /** Runs every frame. */
    tick?(object: Object3D, item: I, stage: StageModel): void;
    dispose(object: Object3D, item: I, stage: StageModel): void;
    /** Whether the object may start rising; a cutout waits for its picture. */
    ready(object: Object3D): boolean;
};

const RISE_SECONDS = 0.7;

const cutoutGeometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
const wallMaterials = new Map<string, MeshLambertMaterial>();
const inkMaterials = new Map<string, LineBasicMaterial>();

function wallMaterial(color: string | undefined): MeshLambertMaterial {
    const key = color ?? "";
    let material = wallMaterials.get(key);
    if (!material) {
        const tint = new Color(PAPER);
        if (color) tint.lerp(new Color(color), 0.12);
        material = new MeshLambertMaterial({ color: tint });
        wallMaterials.set(key, material);
    }
    return material;
}

function inkMaterial(color: string | undefined): LineBasicMaterial {
    const key = color ?? INK;
    let material = inkMaterials.get(key);
    if (!material) {
        material = new LineBasicMaterial({ color: new Color(key) });
        inkMaterials.set(key, material);
    }
    return material;
}

function wallGeometry(wall: WallItem, frame: Rect): ExtrudeGeometry {
    const plan = wallPlan(wall, frame);
    const { outer, hole } = wallOutlines(plan);
    const toShape = (p: Point) => new Vector2(p.x, -p.z);
    const shape = new Shape(outer.map(toShape));
    if (hole) shape.holes.push(new Path(hole.map(toShape)));
    return new ExtrudeGeometry(shape, { depth: plan.height, bevelEnabled: false, curveSegments: 1 }).rotateX(
        -Math.PI / 2,
    );
}

function fillWall(group: Object3D, wall: WallItem, frame: Rect): void {
    const geometry = wallGeometry(wall, frame);
    const body = new Mesh(geometry, wallMaterial(wall.color));
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body, new LineSegments(new EdgesGeometry(geometry, 25), inkMaterial(wall.color)));
}

function emptyGroup(group: Object3D): void {
    for (const child of [...group.children]) {
        (child as Mesh).geometry.dispose();
        group.remove(child);
    }
}

const WALL: Kind<WallItem> = {
    create(wall, frame) {
        const group = new Group();
        fillWall(group, wall, frame);
        return group;
    },
    update(group, wall, previous, frame) {
        const same =
            wall.shape === previous.shape &&
            wall.rect.width === previous.rect.width &&
            wall.rect.height === previous.rect.height &&
            wall.color === previous.color;
        if (same) return;
        emptyGroup(group);
        fillWall(group, wall, frame);
    },
    place(wall, frame) {
        const plan = wallPlan(wall, frame);
        return { x: plan.center.x, z: plan.center.z, yaw: plan.yaw };
    },
    dispose: emptyGroup,
    ready: () => true,
};

function cutoutScale(mesh: Object3D, cutout: CutoutItem, frame: Rect): void {
    const plan = cutoutPlan(cutout, frame);
    mesh.scale.set(plan.width, plan.height, 1);
}

/** Shows `picture`, or hides the cutout while it has none. */
function showPicture(mesh: Mesh, picture: Texture | null): void {
    const material = mesh.material as MeshLambertMaterial;
    if (material.map === picture) return;
    material.map = material.emissiveMap = picture;
    material.needsUpdate = true;
    mesh.visible = picture !== null;
}

const CUTOUT: Kind<CutoutItem> = {
    create(cutout, frame, stage) {
        const mesh = new Mesh(cutoutGeometry, paperMaterial());
        mesh.castShadow = true;
        mesh.visible = false;
        cutoutScale(mesh, cutout, frame);
        stage.textures.acquire(cutout.asset.hash);
        return mesh;
    },
    update(mesh, cutout, previous, frame, stage) {
        cutoutScale(mesh, cutout, frame);
        if (cutout.asset.hash === previous.asset.hash) return;
        stage.textures.acquire(cutout.asset.hash);
        stage.textures.release(previous.asset.hash);
        showPicture(mesh as Mesh, null);
    },
    place(cutout, frame) {
        const { center } = cutoutPlan(cutout, frame);
        return { x: center.x, z: center.z, yaw: 0 };
    },
    tick(mesh, cutout, stage) {
        showPicture(mesh as Mesh, stage.textures.get(cutout.asset.hash));
    },
    dispose(mesh, cutout, stage) {
        stage.textures.release(cutout.asset.hash);
        ((mesh as Mesh).material as MeshLambertMaterial).dispose();
    },
    ready: (mesh) => mesh.visible,
};

const pawnRing = new RingGeometry(0.28, 0.4, 40).rotateX(-Math.PI / 2).translate(0, 0.012, 0);
const pawnCone = new ConeGeometry(0.12, 0.3, 4).rotateX(Math.PI).translate(0, 0.45, 0);
const pawnMaterial = new MeshBasicMaterial({ color: "#f97316", transparent: true, opacity: 0.85, depthWrite: false });

const PAWN: Kind<PawnItem> = {
    create() {
        const group = new Group();
        group.add(new Mesh(pawnRing, pawnMaterial), new Mesh(pawnCone, pawnMaterial));
        return group;
    },
    update() {},
    place(pawn, frame) {
        const { x, z } = canvasToWorld(pawn.x, pawn.y, frame);
        return { x, z, yaw: 0 };
    },
    dispose() {},
    ready: () => true,
};

const KINDS: { [K in StageItem["kind"]]: Kind<Extract<StageItem, { kind: K }>> } = {
    wall: WALL,
    cutout: CUTOUT,
    pawn: PAWN,
};

function kindOf(item: StageItem): Kind<StageItem> {
    return KINDS[item.kind] as Kind<StageItem>;
}

export type ScenePatch = { reset?: true; frame?: Rect; upserts: StageItem[]; removes: ElementId[] };

/** The stage as the view shows it: the floor sized to the frame, and one object per stage item. */
export class StageModel {
    readonly root = new Group();
    frame: Rect | null = null;
    private readonly nodes = new Map<ElementId, Node>();
    private edges: Segment[] = [];
    private edgesStale = true;
    private readonly floor: Mesh;
    private readonly border: LineLoop;

    constructor(
        readonly textures: AssetCache<Texture>,
        private readonly sun: DirectionalLight,
        anisotropy: number,
    ) {
        const paper = floorPaper();
        paper.anisotropy = anisotropy;
        this.floor = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshLambertMaterial({ map: paper }));
        this.floor.receiveShadow = true;
        this.border = new LineLoop(
            new BufferGeometry().setAttribute(
                "position",
                new Float32BufferAttribute([-0.5, 0.01, -0.5, 0.5, 0.01, -0.5, 0.5, 0.01, 0.5, -0.5, 0.01, 0.5], 3),
            ),
            new LineBasicMaterial({ color: "#8a94a6" }),
        );
        this.root.add(this.floor, this.border);
    }

    /** A welcome replaces everything and shows it where it stands, without gliding. */
    load(snapshot: StageSnapshot): void {
        this.apply({ reset: true, frame: snapshot.frame, upserts: snapshot.items, removes: [] });
        for (const node of this.nodes.values()) this.snap(node);
    }

    apply(patch: ScenePatch): void {
        if (patch.frame) this.setFrame(patch.frame);
        const frame = this.frame;
        if (!frame) return;
        const kept = new Set(patch.upserts.map((item) => item.id));
        const removes = patch.reset ? [...this.nodes.keys()].filter((id) => !kept.has(id)) : patch.removes;
        for (const id of removes) this.remove(id);
        for (const item of patch.upserts) this.upsert(item, frame);
        if (patch.reset) this.textures.retryFailed();
    }

    get walls(): number {
        return [...this.nodes.values()].filter((node) => node.item.kind === "wall").length;
    }

    get cutouts(): number {
        return [...this.nodes.values()].filter((node) => node.item.kind === "cutout").length;
    }

    get pawn(): Point | null {
        for (const node of this.nodes.values())
            if (node.item.kind === "pawn") return { x: node.target.x, z: node.target.z };
        return null;
    }

    get bounds(): Bounds {
        return this.frame ? floorBounds(this.frame) : { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    }

    /** Wall edges at their final positions, so a wall gliding into place blocks where it will stand. */
    get collisionEdges(): Segment[] {
        if (this.edgesStale && this.frame) {
            const frame = this.frame;
            this.edges = [...this.nodes.values()].flatMap((node) =>
                node.item.kind === "wall" ? wallEdges(wallPlan(node.item, frame)) : [],
            );
            this.edgesStale = false;
        }
        return this.edges;
    }

    update(dt: number): void {
        const follow = 1 - Math.exp(-12 * dt);
        for (const node of this.nodes.values()) {
            const { object, target } = node;
            const kind = kindOf(node.item);
            object.position.x += (target.x - object.position.x) * follow;
            object.position.z += (target.z - object.position.z) * follow;
            object.rotation.y += angleBetween(object.rotation.y, target.yaw) * follow;
            kind.tick?.(object, node.item, this);
            if (node.rise < 1 && kind.ready(object)) {
                node.rise = Math.min(1, node.rise + dt / RISE_SECONDS);
                this.showRise(node);
            }
        }
    }

    private showRise(node: Node): void {
        const eased = 1 - (1 - node.rise) ** 3;
        if (node.item.kind === "wall") node.object.scale.y = Math.max(eased, 0.001);
        if (node.item.kind === "cutout") node.object.rotation.x = -(1 - eased) * (Math.PI / 2);
    }

    private upsert(item: StageItem, frame: Rect): void {
        const kind = kindOf(item);
        const node = this.nodes.get(item.id);
        if (node && node.item.kind === item.kind) {
            kind.update(node.object, item, node.item, frame, this);
            node.item = item;
            node.target = kind.place(item, frame);
        } else {
            if (node) this.remove(item.id);
            const object = kind.create(item, frame, this);
            const created: Node = { item, object, target: kind.place(item, frame), rise: 0 };
            this.snap(created);
            this.showRise(created);
            this.nodes.set(item.id, created);
            this.root.add(object);
        }
        if (item.kind === "wall") this.edgesStale = true;
    }

    private remove(id: ElementId): void {
        const node = this.nodes.get(id);
        if (!node) return;
        kindOf(node.item).dispose(node.object, node.item, this);
        this.root.remove(node.object);
        this.nodes.delete(id);
        if (node.item.kind === "wall") this.edgesStale = true;
    }

    private snap({ object, target }: Node): void {
        object.position.set(target.x, 0, target.z);
        object.rotation.y = target.yaw;
    }

    private setFrame(frame: Rect): void {
        this.frame = frame;
        this.edgesStale = true;
        const { minX, maxX, minZ, maxZ } = floorBounds(frame);
        const width = maxX - minX;
        const depth = maxZ - minZ;
        this.floor.scale.set(width, 1, depth);
        this.border.scale.set(width, 1, depth);
        (this.floor.material as MeshLambertMaterial).map!.repeat.set(width, depth);
        const reach = Math.hypot(width, depth) / 2 + 2;
        const camera = this.sun.shadow.camera;
        camera.left = camera.bottom = -reach;
        camera.right = camera.top = reach;
        camera.far = 60;
        camera.updateProjectionMatrix();
        for (const node of this.nodes.values()) node.target = kindOf(node.item).place(node.item, frame);
    }
}
