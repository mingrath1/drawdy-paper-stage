import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE, type ServerMessage, type ViewBoot } from "../shared/protocol";
import { StageLink, closeOutcome, decodeServerFrame, retryDelayMs } from "../view/link";

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

class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static made: FakeSocket[] = [];
    readyState = FakeSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;

    constructor(readonly url: string) {
        FakeSocket.made.push(this);
    }

    send(data: string) {
        this.sent.push(data);
    }

    close() {
        this.readyState = 3;
    }

    accept() {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }

    receive(message: object) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

describe("the stage link", () => {
    const boot: ViewBoot = {
        backendUrl: "https://stage.example",
        stageId: "s1",
        token: "t",
        participant: { presenceId: "p1", name: "Ann", color: "#a855f7" },
    };
    const news = { type: "walker.left", connectionId: "c9" };

    beforeEach(() => {
        vi.useFakeTimers();
        FakeSocket.made = [];
        vi.stubGlobal("WebSocket", FakeSocket);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("ignores a replaced socket that speaks up after the link moved on", async () => {
        const heard: ServerMessage[] = [];
        new StageLink(boot, (message) => heard.push(message), () => {});
        const [first] = FakeSocket.made;
        first.accept();
        first.receive(news);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(FakeSocket.made).toHaveLength(2);
        const second = FakeSocket.made[1];
        first.receive(news);
        first.onopen?.();
        expect(heard).toHaveLength(1);
        expect(second.sent).toEqual([]);
    });

    it("gives up on a handshake that never opens and tries again", async () => {
        new StageLink(boot, () => {}, () => {});
        await vi.advanceTimersByTimeAsync(31_000);
        expect(FakeSocket.made.length).toBeGreaterThanOrEqual(2);
    });
});
