import type { CollaborationUserPresence } from "@drawdy/driver-protocol";
import {
    MAX_NAME_CHARS,
    WALKER_TTL_MS,
    type ConnectionId,
    type Cursor,
    type Participant,
    type Pose,
    type Walker,
} from "../shared/protocol";

export function participantOf(user: CollaborationUserPresence): Participant {
    return { presenceId: user.id, name: user.name.slice(0, MAX_NAME_CHARS), color: user.color };
}

/**
 * Everyone's cursor on the board, the writer's own included: only the writer relays cursors, so leaving it out would
 * hide the writer's hand from every other walker. Each view hides its own participant.
 */
export function cursorsOf(users: readonly CollaborationUserPresence[]): Cursor[] {
    return users.flatMap((user) =>
        user.cursorPosition ? [{ ...participantOf(user), x: user.cursorPosition.x, y: user.cursorPosition.y }] : [],
    );
}

/** Calls `fn` at most once per `ms` with the latest value, trailing. */
export function throttle<T>(ms: number, fn: (value: T) => void): (value: T) => void {
    let latest: T;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const fire = () => {
        timer = null;
        last = Date.now();
        fn(latest);
    };
    return (value) => {
        latest = value;
        if (timer) return;
        const wait = last + ms - Date.now();
        if (wait <= 0) fire();
        else timer = setTimeout(fire, wait);
    };
}

export const REST_MS = 1_000;

type SeenWalker = { presenceId: string; seenAt: number };

/**
 * Watches walker poses and reports when this person stops walking. The pawn is one shared board element, so a rest
 * counts only while nobody else is walking the stage; otherwise two walkers would drag it back and forth.
 */
export class RestWatch {
    private readonly walkers = new Map<ConnectionId, SeenWalker>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly selfId: string,
        private readonly onRest: (pose: Pose) => void,
        private readonly now: () => number = Date.now,
    ) {}

    walker(walker: Walker): void {
        this.walkers.set(walker.connectionId, { presenceId: walker.participant.presenceId, seenAt: this.now() });
        if (walker.participant.presenceId !== this.selfId) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.walkingAlone()) this.onRest(walker.pose);
        }, REST_MS);
    }

    left(connectionId: ConnectionId): void {
        this.walkers.delete(connectionId);
    }

    stop(): void {
        if (this.timer) clearTimeout(this.timer);
    }

    walkingAlone(): boolean {
        const now = this.now();
        for (const [id, walker] of this.walkers) if (now - walker.seenAt > WALKER_TTL_MS) this.walkers.delete(id);
        return [...this.walkers.values()].every((walker) => walker.presenceId === this.selfId);
    }
}
