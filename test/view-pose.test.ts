import { describe, expect, it } from "vitest";
import { POSE_HZ, type Pose } from "../shared/protocol";
import { IDLE_POSE_CLOCK, POSE_KEEPALIVE_MS, normalizeHeading, stepPoseClock, type PoseClock } from "../view/pose";

/** Runs the clock at 60 fps over `poseAt(t)` and returns the times it sent. */
function run(fromMs: number, toMs: number, poseAt: (t: number) => Pose, clock: PoseClock = IDLE_POSE_CLOCK) {
    const sentAt: number[] = [];
    for (let t = fromMs; t <= toMs; t += 1000 / 60) {
        const step = stepPoseClock(clock, t, poseAt(t));
        clock = step.clock;
        if (step.send) sentAt.push(t);
    }
    return { sentAt, clock };
}

const walking = (t: number): Pose => ({ x: t / 10, y: 0, heading: 0, pitch: 0 });
const still: Pose = { x: 100, y: 0, heading: 0, pitch: 0 };

describe("pose clock", () => {
    it("sends the first pose at once", () => {
        expect(stepPoseClock(IDLE_POSE_CLOCK, 0, still).send).toEqual(still);
    });

    it("sends about POSE_HZ poses a second while walking", () => {
        const { sentAt } = run(0, 1000, walking);
        expect(sentAt.length).toBeGreaterThanOrEqual(POSE_HZ - 1);
        expect(sentAt.length).toBeLessThanOrEqual(POSE_HZ + 1);
    });

    it("sends the resting pose once after stopping, then only the keepalive", () => {
        const stopAt = 500;
        const poseAt = (t: number) => walking(Math.min(t, stopAt));
        const { sentAt, clock } = run(0, 2000, poseAt);
        const afterStop = sentAt.filter((t) => t > stopAt);
        expect(afterStop.length).toBe(1);
        expect(clock.sent).toEqual(walking(stopAt));
        expect(run(2000, 2000 + POSE_KEEPALIVE_MS + 100, poseAt, clock).sentAt.length).toBe(1);
    });

    it("sends a turn in place", () => {
        const { clock } = run(0, 100, () => still);
        expect(stepPoseClock(clock, 200, { ...still, heading: 0.5 }).send).not.toBeNull();
    });
});

describe("heading", () => {
    it("wraps to (-PI, PI]", () => {
        expect(normalizeHeading(-Math.PI)).toBeCloseTo(Math.PI, 10);
        expect(normalizeHeading(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
        expect(normalizeHeading(-0.5 - 4 * Math.PI)).toBeCloseTo(-0.5, 10);
        expect(normalizeHeading(1)).toBe(1);
    });
});
