import { WALKER_TTL_MS, canvasToWorld, type ConnectionId, type Rect, type Walker } from "../shared/protocol";
import {
    Group,
    Mesh,
    PlaneGeometry,
    type MeshLambertMaterial,
    type Sprite,
    type Texture,
} from "./vendor/three.module.js";
import { nameLabel, paperDoll, paperMaterial } from "./drawings";
import { angleBetween } from "./pose";

const BODY_HEIGHT_M = 1.7;
const dollGeometry = new PlaneGeometry(BODY_HEIGHT_M / 2, BODY_HEIGHT_M).translate(0, BODY_HEIGHT_M / 2, 0);
const dolls = new Map<string, Texture>();

type Body = {
    walker: Walker;
    group: Group;
    doll: Mesh<PlaneGeometry, MeshLambertMaterial>;
    label: Sprite;
    heardAt: number;
    /** 1 while the walker is fresh, easing to 0 once it has been quiet for WALKER_TTL_MS, when the body goes. */
    shown: number;
};

/** Other people walking the stage, as paper dolls in their own color with their name overhead. */
export class Bodies {
    readonly root = new Group();
    private readonly bodies = new Map<ConnectionId, Body>();

    /** Replaces every body, as a welcome does. A stage with no frame yet shows none. */
    reset(walkers: Walker[], frame: Rect | null, now: number): void {
        for (const id of [...this.bodies.keys()]) this.remove(id);
        if (frame) for (const walker of walkers) this.set(walker, frame, now);
    }

    set(walker: Walker, frame: Rect, now: number): void {
        const body = this.bodies.get(walker.connectionId);
        const { name, color } = walker.participant;
        if (body && body.walker.participant.name === name && body.walker.participant.color === color) {
            body.walker = walker;
            body.heardAt = now;
            return;
        }
        if (body) this.remove(walker.connectionId);
        this.bodies.set(walker.connectionId, this.create(walker, frame, now));
    }

    remove(id: ConnectionId): void {
        const body = this.bodies.get(id);
        if (!body) return;
        this.root.remove(body.group);
        body.doll.material.dispose();
        body.label.material.map?.dispose();
        body.label.material.dispose();
        this.bodies.delete(id);
    }

    presenceIds(): string[] {
        return [...this.bodies.values()].map((body) => body.walker.participant.presenceId);
    }

    update(dt: number, now: number, frame: Rect): void {
        const follow = 1 - Math.exp(-10 * dt);
        for (const [id, body] of this.bodies) {
            const fresh = now - body.heardAt < WALKER_TTL_MS;
            body.shown += ((fresh ? 1 : 0) - body.shown) * follow;
            if (!fresh && body.shown < 0.01) {
                this.remove(id);
                continue;
            }
            body.group.scale.setScalar(Math.max(body.shown, 0.001));
            const { x, z } = canvasToWorld(body.walker.pose.x, body.walker.pose.y, frame);
            body.group.position.x += (x - body.group.position.x) * follow;
            body.group.position.z += (z - body.group.position.z) * follow;
            body.doll.rotation.y += angleBetween(body.doll.rotation.y, body.walker.pose.heading) * follow;
        }
    }

    private create(walker: Walker, frame: Rect, now: number): Body {
        const { color, name } = walker.participant;
        let texture = dolls.get(color);
        if (!texture) {
            texture = paperDoll(color);
            dolls.set(color, texture);
        }
        const material = paperMaterial();
        material.map = material.emissiveMap = texture;
        const doll = new Mesh(dollGeometry, material);
        doll.castShadow = true;
        doll.rotation.y = walker.pose.heading;
        const label = nameLabel(name, color);
        label.position.y = BODY_HEIGHT_M + 0.3;
        const group = new Group();
        group.add(doll, label);
        const { x, z } = canvasToWorld(walker.pose.x, walker.pose.y, frame);
        group.position.set(x, 0, z);
        this.root.add(group);
        return { walker, group, doll, label, heardAt: now, shown: 1 };
    }
}
