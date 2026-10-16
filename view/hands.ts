import type { Cursor, Rect } from "../shared/protocol";
import {
    AdditiveBlending,
    Group,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Sprite,
    SpriteMaterial,
    type Texture,
} from "./vendor/three.module.js";
import { glowSpot, glowingHand, nameLabel } from "./drawings";
import { handPlan } from "./layout";

const HAND_SPRITE_WIDTH_M = 1.0;
const HAND_SPRITE_HEIGHT_M = 1.25;
const spotGeometry = new PlaneGeometry(1.4, 1.4).rotateX(-Math.PI / 2).translate(0, 0.02, 0);
const handTextures = new Map<string, Texture>();
let spotTexture: Texture | null = null;

type Hand = {
    cursor: Cursor;
    group: Group;
    hand: Sprite;
    disposables: { dispose(): void }[];
    /** 1 while the cursor is over the stage, easing to 0 when it leaves or is gone. */
    shown: number;
    gone: boolean;
    phase: number;
};

/** Collaborators' board cursors, as giant glowing hands reaching into the stage from above. */
export class Hands {
    readonly root = new Group();
    private readonly hands = new Map<string, Hand>();

    constructor(private readonly selfPresenceId: string) {}

    /** Takes the writer's full list of cursors. A person missing from it fades out. */
    set(cursors: Cursor[], frame: Rect): void {
        const listed = new Set<string>();
        for (const cursor of cursors) {
            if (cursor.presenceId === this.selfPresenceId) continue;
            listed.add(cursor.presenceId);
            const hand = this.hands.get(cursor.presenceId);
            if (hand && hand.cursor.color === cursor.color && hand.cursor.name === cursor.name) {
                hand.cursor = cursor;
                hand.gone = false;
            } else {
                if (hand) this.remove(cursor.presenceId);
                this.hands.set(cursor.presenceId, this.create(cursor, frame));
            }
        }
        for (const [id, hand] of this.hands) if (!listed.has(id)) hand.gone = true;
    }

    presenceIds(): string[] {
        return [...this.hands.values()].filter((hand) => !hand.gone).map((hand) => hand.cursor.presenceId);
    }

    update(dt: number, seconds: number, frame: Rect): void {
        const follow = 1 - Math.exp(-10 * dt);
        for (const [id, hand] of this.hands) {
            const plan = handPlan(hand.cursor, frame);
            const showing = plan.inFrame && !hand.gone;
            hand.shown += ((showing ? 1 : 0) - hand.shown) * follow;
            if (!showing && hand.shown < 0.01) {
                if (hand.gone) {
                    this.remove(id);
                    continue;
                }
                hand.shown = 0;
            }
            hand.group.visible = hand.shown > 0;
            hand.group.scale.setScalar(Math.max(hand.shown, 0.001));
            hand.group.position.x += (plan.position.x - hand.group.position.x) * follow;
            hand.group.position.z += (plan.position.z - hand.group.position.z) * follow;
            hand.hand.position.y = plan.hoverHeight + Math.sin(seconds * 2.2 + hand.phase) * 0.06;
        }
    }

    private create(cursor: Cursor, frame: Rect): Hand {
        let texture = handTextures.get(cursor.color);
        if (!texture) {
            texture = glowingHand(cursor.color);
            handTextures.set(cursor.color, texture);
        }
        spotTexture ??= glowSpot();
        const handMaterial = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const hand = new Sprite(handMaterial);
        hand.scale.set(HAND_SPRITE_WIDTH_M, HAND_SPRITE_HEIGHT_M, 1);
        const spotMaterial = new MeshBasicMaterial({
            map: spotTexture,
            color: cursor.color,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
        });
        const label = nameLabel(cursor.name, cursor.color, 0.24);
        const plan = handPlan(cursor, frame);
        label.position.y = plan.hoverHeight + HAND_SPRITE_HEIGHT_M / 2 + 0.2;
        const group = new Group();
        group.add(hand, new Mesh(spotGeometry, spotMaterial), label);
        group.position.set(plan.position.x, 0, plan.position.z);
        this.root.add(group);
        return {
            cursor,
            group,
            hand,
            disposables: [handMaterial, spotMaterial, label.material, label.material.map!],
            shown: 0,
            gone: false,
            phase: Math.random() * Math.PI * 2,
        };
    }

    private remove(id: string): void {
        const hand = this.hands.get(id);
        if (!hand) return;
        this.root.remove(hand.group);
        for (const resource of hand.disposables) resource.dispose();
        this.hands.delete(id);
    }
}
