import type { CollaborationUserPresence } from "@drawdy/driver-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorsOf, throttle } from "../src/presence";

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
});
