import { EYE_HEIGHT_METERS, headingToCameraYaw, worldToCanvas, type Pose, type Rect } from "../shared/protocol";
import type { PerspectiveCamera } from "./vendor/three.module.js";
import { clamp, moveWalker, refloor, settleWalker, type Bounds, type Point, type Segment } from "./layout";
import { PITCH_LIMIT, normalizeHeading } from "./pose";

const WALK_SPEED = 2.6;
const RUN_SPEED = 4.6;
const TURN_SPEED = 2.0;
const DRAG_TURN_PER_PX = 0.005;

/** Keys by `code`, so the same physical keys walk on every keyboard layout. [forward, right] */
const MOVES: Record<string, [number, number]> = {
    KeyW: [1, 0],
    ArrowUp: [1, 0],
    KeyS: [-1, 0],
    ArrowDown: [-1, 0],
    KeyA: [0, -1],
    ArrowLeft: [0, -1],
    KeyD: [0, 1],
    ArrowRight: [0, 1],
};
/** Positive turns left: heading grows toward +x, which is the walker's left when facing +z. */
const TURNS: Record<string, number> = { KeyQ: 1, KeyE: -1 };

/** What the walker stands on. `frame` is null until the stage has a real one. */
export type Ground = { frame: Rect | null; pawn: Point | null; collisionEdges: Segment[]; bounds: Bounds };

/**
 * First person walking for a sandboxed iframe: keys after one click, and click-and-drag to look, because pointer lock
 * is blocked. Facing is (sin heading, cos heading) on the floor, the convention `Pose` documents.
 */
export class WalkControls {
    position: Point = { x: 0, z: 0 };
    /** Whether the walker has stood at the pawn yet. Until then it waits at the floor's center. */
    spawned = false;
    heading = Math.PI;
    pitch = 0;
    walked = false;
    private readonly held = new Set<string>();
    private drag: { pointer: number; x: number; y: number } | null = null;

    constructor(surface: HTMLElement) {
        addEventListener("keydown", (event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            if (event.code in MOVES || event.code in TURNS || event.code.startsWith("Shift")) {
                this.held.add(event.code);
                event.preventDefault();
            }
        });
        addEventListener("keyup", (event) => this.held.delete(event.code));
        addEventListener("blur", () => {
            this.held.clear();
            this.drag = null;
        });
        surface.addEventListener("pointerdown", (event) => {
            focus();
            surface.setPointerCapture(event.pointerId);
            this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
        });
        surface.addEventListener("pointermove", (event) => {
            if (this.drag?.pointer !== event.pointerId) return;
            if (event.buttons === 0) {
                this.drag = null;
                return;
            }
            this.look(event.clientX - this.drag.x, event.clientY - this.drag.y);
            this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
        });
        /** Pointer capture stops at the iframe's edge, so a button released outside the view sends no pointerup. */
        const release = (event: PointerEvent) => {
            if (this.drag?.pointer === event.pointerId) this.drag = null;
        };
        for (const ending of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"] as const)
            surface.addEventListener(ending, release);
    }

    /**
     * Keeps the walker standing somewhere sensible after the stage changed under it. `before` is the frame the stage
     * had before the change. The walker spawns at the pawn once the stage has a real frame and a pawn.
     */
    settle(ground: Ground, before: Rect | null): void {
        const { frame, pawn } = ground;
        if (!frame) return;
        if (!this.spawned && pawn) {
            this.position = pawn;
            this.spawned = true;
        } else if (before) {
            this.position = refloor(this.position, before, frame);
        }
        this.position = settleWalker(this.position, pawn ?? { x: 0, z: 0 }, ground.collisionEdges, ground.bounds);
    }

    /** Dragging right looks right and dragging up looks up. */
    look(dx: number, dy: number): void {
        this.heading = normalizeHeading(this.heading - dx * DRAG_TURN_PER_PX);
        this.pitch = clamp(this.pitch - dy * DRAG_TURN_PER_PX, -PITCH_LIMIT, PITCH_LIMIT);
    }

    update(dt: number, edges: Segment[], bounds: Bounds): void {
        let forward = 0;
        let right = 0;
        let turn = 0;
        for (const code of this.held) {
            const move = MOVES[code];
            if (move) {
                forward += move[0];
                right += move[1];
            }
            turn += TURNS[code] ?? 0;
        }
        this.heading = normalizeHeading(this.heading + turn * TURN_SPEED * dt);
        const length = Math.hypot(forward, right);
        if (length === 0) return;
        this.walked = true;
        const running = this.held.has("ShiftLeft") || this.held.has("ShiftRight");
        const step = ((running ? RUN_SPEED : WALK_SPEED) * dt) / length;
        const sin = Math.sin(this.heading);
        const cos = Math.cos(this.heading);
        const delta = {
            x: (forward * sin - right * cos) * step,
            z: (forward * cos + right * sin) * step,
        };
        this.position = moveWalker(this.position, delta, edges, bounds);
    }

    apply(camera: PerspectiveCamera): void {
        camera.position.set(this.position.x, EYE_HEIGHT_METERS, this.position.z);
        camera.rotation.set(this.pitch, headingToCameraYaw(this.heading), 0, "YXZ");
    }

    pose(frame: Rect): Pose {
        const { x, y } = worldToCanvas(this.position.x, this.position.z, frame);
        return { x, y, heading: this.heading, pitch: this.pitch };
    }
}
