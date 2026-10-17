import type { CollaborationUserPresence } from "@drawdy/driver-protocol";
import { MAX_NAME_CHARS, type Cursor, type Participant } from "../shared/protocol";

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
