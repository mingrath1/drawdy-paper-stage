import { describe, expect, it } from "vitest";
import { CLOSE } from "../shared/protocol";
import { closeOutcome, decodeServerFrame, retryDelayMs } from "../view/link";

describe("closing", () => {
    it("stops on a bad token or an old view", () => {
        expect(closeOutcome(CLOSE.badToken).retry).toBe(false);
        expect(closeOutcome(CLOSE.badVersion).retry).toBe(false);
    });

    it("retries an uninitialized stage and any other close", () => {
        expect(closeOutcome(CLOSE.uninitialized)).toEqual({ retry: true, note: "Waiting for the board" });
        expect(closeOutcome(1006).retry).toBe(true);
        expect(closeOutcome(CLOSE.tooLarge).retry).toBe(true);
    });

    it("backs off and caps the wait", () => {
        const delays = [0, 1, 2, 3, 10].map(retryDelayMs);
        expect(delays.slice(0, 4)).toEqual([400, 800, 1600, 3200]);
        expect(delays[4]).toBe(8000);
    });
});

describe("decoding", () => {
    it("passes a server message through", () => {
        expect(decodeServerFrame('{"type":"walker.left","connectionId":"c1"}')).toEqual({
            type: "walker.left",
            connectionId: "c1",
        });
    });

    it("drops what is not a server message", () => {
        expect(decodeServerFrame("not json")).toBeNull();
        expect(decodeServerFrame('{"type":"hello"}')).toBeNull();
        expect(decodeServerFrame("[1,2]")).toBeNull();
        expect(decodeServerFrame("null")).toBeNull();
        expect(decodeServerFrame(new ArrayBuffer(4))).toBeNull();
    });
});
