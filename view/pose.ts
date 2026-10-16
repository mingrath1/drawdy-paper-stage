import { POSE_HZ, type Pose } from "../shared/protocol";

export const PITCH_LIMIT = 1.4;
/** Walkers fade after WALKER_TTL_MS without a pose, so a walker standing still repeats its pose this often. */
export const POSE_KEEPALIVE_MS = 4_000;
const POSE_INTERVAL_MS = 1000 / POSE_HZ;
/** Half a canvas unit, or about a tenth of a degree, is too small for anyone to see. */
const POSITION_EPSILON = 0.5;
const ANGLE_EPSILON = 0.002;

/** `sentAt` is the send slot, kept on a fixed cadence so 60 fps frames do not alias the rate down to 15 Hz. */
export type PoseClock = { sent: Pose | null; sentAt: number };

export const IDLE_POSE_CLOCK: PoseClock = { sent: null, sentAt: -Infinity };

/**
 * Decides whether this frame's pose goes on the wire. A moving walker sends at most POSE_HZ times a second. When it
 * stops, the next due tick sends the resting pose once, and after that only the keepalive repeats it.
 */
export function stepPoseClock(clock: PoseClock, now: number, pose: Pose): { clock: PoseClock; send: Pose | null } {
    const elapsed = now - clock.sentAt;
    const due =
        clock.sent === null ||
        (elapsed >= POSE_INTERVAL_MS && (moved(clock.sent, pose) || elapsed >= POSE_KEEPALIVE_MS));
    if (!due) return { clock, send: null };
    const slot = elapsed < 2 * POSE_INTERVAL_MS ? clock.sentAt + POSE_INTERVAL_MS : now;
    return { clock: { sent: pose, sentAt: slot }, send: pose };
}

function moved(a: Pose, b: Pose): boolean {
    return (
        Math.abs(a.x - b.x) > POSITION_EPSILON ||
        Math.abs(a.y - b.y) > POSITION_EPSILON ||
        Math.abs(angleBetween(a.heading, b.heading)) > ANGLE_EPSILON ||
        Math.abs(a.pitch - b.pitch) > ANGLE_EPSILON
    );
}

/** Wraps to (-PI, PI], the range Pose documents. */
export function normalizeHeading(heading: number): number {
    const wrapped = heading - 2 * Math.PI * Math.floor((heading + Math.PI) / (2 * Math.PI));
    return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** The signed shortest turn from `from` to `to`. */
export function angleBetween(from: number, to: number): number {
    return normalizeHeading(to - from);
}
