import type { CollaborationUserPresence } from "@drawdy/driver-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALKER_TTL_MS, type Walker } from "../shared/protocol";
import { cursorsOf, REST_MS, RestWatch, throttle } from "../src/presence";

const user = (id: string, cursor: { x: number; y: number } | null, isSelf = false): CollaborationUserPresence => ({
    id,
    name: `name-${id}`,
    color: "#123456",
    isHost: false,
    isSelf,
    cursorPosition: cursor,
});

describe("cursorsOf", () => {
    it("lists everyone with a cursor on the canvas, the writer included", () => {
        expect(cursorsOf([user("me", { x: 1, y: 2 }, true), user("you", { x: 3, y: 4 }), user("away", null)])).toEqual([
            { presenceId: "me", name: "name-me", color: "#123456", x: 1, y: 2 },
            { presenceId: "you", name: "name-you", color: "#123456", x: 3, y: 4 },
        ]);
    });
});

describe("timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("throttle sends the first value at once and the latest one per interval", () => {
        const sent: number[] = [];
        const push = throttle(50, (value: number) => sent.push(value));
        push(1);
        push(2);
        push(3);
        expect(sent).toEqual([1]);
        vi.advanceTimersByTime(50);
        expect(sent).toEqual([1, 3]);
    });

    const walker = (connectionId: string, presenceId: string, x = 0): Walker => ({
        connectionId,
        participant: { presenceId, name: presenceId, color: "#000000" },
        pose: { x, y: 0, heading: 0, pitch: 0 },
    });

    it("reports my resting pose one second after my poses stop", () => {
        const rested = vi.fn();
        const watch = new RestWatch("me", rested);
        watch.walker(walker("v1", "me", 10));
        vi.advanceTimersByTime(REST_MS - 100);
        watch.walker(walker("v1", "me", 20));
        vi.advanceTimersByTime(REST_MS - 1);
        expect(rested).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(rested).toHaveBeenCalledOnce();
        expect(rested).toHaveBeenCalledWith(expect.objectContaining({ x: 20 }));
    });

    it("leaves the pawn alone while someone else walks the stage", () => {
        const rested = vi.fn();
        const watch = new RestWatch("me", rested);
        watch.walker(walker("v2", "friend"));
        watch.walker(walker("v1", "me"));
        vi.advanceTimersByTime(REST_MS);
        expect(rested).not.toHaveBeenCalled();
    });

    it("moves the pawn again once the other walker left or went quiet", () => {
        const rested = vi.fn();
        const watch = new RestWatch("me", rested);
        watch.walker(walker("v2", "friend"));
        watch.left("v2");
        watch.walker(walker("v1", "me"));
        vi.advanceTimersByTime(REST_MS);
        expect(rested).toHaveBeenCalledOnce();

        watch.walker(walker("v3", "other"));
        vi.advanceTimersByTime(WALKER_TTL_MS + 1);
        watch.walker(walker("v1", "me"));
        vi.advanceTimersByTime(REST_MS);
        expect(rested).toHaveBeenCalledTimes(2);
    });

    it("ignores other people's rests", () => {
        const rested = vi.fn();
        new RestWatch("me", rested).walker(walker("v2", "friend"));
        vi.advanceTimersByTime(REST_MS * 3);
        expect(rested).not.toHaveBeenCalled();
    });
});
