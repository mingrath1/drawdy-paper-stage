import type { DrawdyPreviewElementSchema } from "@drawdy/driver-protocol";
import { WALKER_TTL_MS, type ConnectionId, type Participant, type Walker } from "../shared/protocol";
import type { Host } from "./host";

const TICK_MS = 50;
/** Share of the remaining distance a marker covers each tick, which smooths the gaps between 20 Hz poses. */
const EASE = 0.4;
/** Closer than this, in canvas units, a marker sits on its target. */
const SETTLE = 0.5;
/** Opacity of each fade step before a marker is deleted. */
const FADE = [0.8, 0.6, 0.4, 0.2];
const RETRY_MS = 250;
const MAX_RETRY_MS = 8_000;
const DOT = 18;
const LABEL_WIDTH = 160;
const LABEL_SIZE = 14;
const LABEL_CHARS = 24;

type Point = { x: number; y: number };

type Retry = { tries: number; dueAt: number };

type Marker = {
    participant: Participant;
    target: Point;
    shown: Point;
    seenAt: number;
    left: boolean;
    /** Index into FADE while fading out, -1 otherwise. */
    fade: number;
    /** The fade step Drawdy shows. */
    drawnFade: number;
    /** Null until Drawdy created the preview. */
    previewId: string | null;
};

/**
 * Everyone walking the stage, drawn on this person's board as a dot and a name at the walker's spot. The markers are
 * preview elements: they never sync, enter undo, or persist, and the pointer passes through them, so every driver can
 * show every walker without touching the shared scene.
 */
export class WalkerMarkers {
    private readonly markers = new Map<ConnectionId, Marker>();
    /** Previews whose delete has not succeeded yet, by previewId. */
    private readonly doomed = new Map<string, Retry>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private timerDue = 0;
    private ticking = false;
    private stopped = false;

    constructor(
        private readonly host: Host,
        private readonly ink: string,
        private readonly now: () => number = Date.now,
        /** This person's own walker is labelled "You" on their own board; everyone else still sees their name. */
        private readonly selfPresenceId?: string,
    ) {}

    show(walker: Walker): void {
        if (this.stopped) return;
        const target = { x: walker.pose.x, y: walker.pose.y };
        const seen = { participant: walker.participant, target, seenAt: this.now(), left: false, fade: -1 };
        const marker = this.markers.get(walker.connectionId);
        if (marker) Object.assign(marker, seen);
        else this.markers.set(walker.connectionId, { ...seen, shown: target, drawnFade: -1, previewId: null });
        this.schedule(0);
    }

    leave(connectionId: ConnectionId): void {
        const marker = this.markers.get(connectionId);
        if (!marker) return;
        marker.left = true;
        this.schedule(0);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const previewIds = [...this.doomed.keys(), ...[...this.markers.values()].flatMap((m) => m.previewId ?? [])];
        this.markers.clear();
        this.doomed.clear();
        if (previewIds.length > 0) await this.host.call("command:scene:delete-drawdy-preview-elements", { previewIds });
    }

    private schedule(delay: number): void {
        if (this.stopped || this.ticking) return;
        const due = this.now() + delay;
        if (this.timer) {
            if (this.timerDue <= due) return;
            clearTimeout(this.timer);
        }
        this.timerDue = due;
        this.timer = setTimeout(() => void this.tick(), delay);
    }

    private async tick(): Promise<void> {
        this.timer = null;
        this.ticking = true;
        try {
            await this.step();
        } finally {
            this.ticking = false;
            const delay = this.nextDelay();
            if (delay !== null) this.schedule(delay);
        }
    }

    private async step(): Promise<void> {
        const now = this.now();
        const updates: DrawdyPreviewElementSchema[] = [];
        for (const [id, marker] of this.markers) {
            if (marker.left || now - marker.seenAt > WALKER_TTL_MS) marker.fade++;
            if (!marker.previewId) {
                if (marker.fade >= 0) this.markers.delete(id);
                else await this.create(id, marker);
                continue;
            }
            if (marker.fade >= FADE.length) {
                this.markers.delete(id);
                this.doom(marker.previewId);
                continue;
            }
            const moved = ease(marker);
            if (moved || marker.fade !== marker.drawnFade) {
                updates.push(...this.elementsOf(id, marker));
                marker.drawnFade = marker.fade;
            }
        }
        if (updates.length > 0)
            await this.host.call("command:scene:update-drawdy-preview-elements", { elements: updates });
        await this.deleteDue();
    }

    private async create(id: ConnectionId, marker: Marker): Promise<void> {
        const created = await this.host.call("command:scene:create-drawdy-preview-elements", {
            elements: this.elementsOf(id, marker),
        });
        // A failed marker is dropped; the walker's next pose, at most 4 s away, draws it again.
        if (!created.ok) this.markers.delete(id);
        else if (this.markers.get(id) === marker) marker.previewId = created.value.previewId;
        else this.doom(created.value.previewId);
    }

    private doom(previewId: string): void {
        this.doomed.set(previewId, { tries: 0, dueAt: this.now() });
    }

    /** Deletes the doomed previews that are due, and backs off the ones Drawdy failed to delete. */
    private async deleteDue(): Promise<void> {
        const due = [...this.doomed].flatMap(([previewId, retry]) => (retry.dueAt <= this.now() ? [previewId] : []));
        if (due.length === 0) return;
        const deleted = await this.host.call("command:scene:delete-drawdy-preview-elements", { previewIds: due });
        for (const previewId of due) {
            const retry = this.doomed.get(previewId);
            if (!retry) continue;
            if (deleted.ok) this.doomed.delete(previewId);
            else retry.dueAt = this.now() + Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** retry.tries++);
        }
    }

    /**
     * Ticks while a marker moves, fades, or waits to be drawn; otherwise sleeps until the first one goes silent or a
     * failed delete is due again.
     */
    private nextDelay(): number | null {
        const now = this.now();
        const waits = [...this.doomed.values()].map((retry) => Math.max(TICK_MS, retry.dueAt - now));
        for (const marker of this.markers.values()) {
            const busy =
                !marker.previewId ||
                marker.left ||
                marker.fade >= 0 ||
                marker.fade !== marker.drawnFade ||
                !same(marker.shown, marker.target);
            waits.push(busy ? TICK_MS : Math.max(TICK_MS, marker.seenAt + WALKER_TTL_MS + 1 - now));
        }
        return waits.length > 0 ? Math.min(...waits) : null;
    }

    private elementsOf(id: ConnectionId, marker: Marker): DrawdyPreviewElementSchema[] {
        const { x, y } = marker.shown;
        const opacity = marker.fade >= 0 ? { opacity: FADE[marker.fade] } : {};
        return [
            {
                type: "shape",
                componentType: "circle",
                drawdyElementId: `paper-stage-walker-${id}-dot`,
                x: x - DOT / 2,
                y: y - DOT / 2,
                width: DOT,
                height: DOT,
                strokeColor: this.ink,
                fillColor: marker.participant.color,
                fillStyle: "solid",
                strokeWidth: 2,
                roughness: 0,
                ...opacity,
            },
            {
                type: "text",
                drawdyElementId: `paper-stage-walker-${id}-name`,
                x: x - LABEL_WIDTH / 2,
                y: y + DOT / 2 + 4,
                width: LABEL_WIDTH,
                text:
                    marker.participant.presenceId === this.selfPresenceId
                        ? "You"
                        : marker.participant.name.slice(0, LABEL_CHARS),
                fontSize: LABEL_SIZE,
                color: this.ink,
                textAlign: "center",
                ...opacity,
            },
        ];
    }
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Moves a marker one tick toward its target. Returns whether it moved. */
function ease(marker: Marker): boolean {
    const { shown, target } = marker;
    if (same(shown, target)) return false;
    const dx = target.x - shown.x;
    const dy = target.y - shown.y;
    marker.shown = Math.hypot(dx, dy) < SETTLE ? target : { x: shown.x + dx * EASE, y: shown.y + dy * EASE };
    return true;
}
