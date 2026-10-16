import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_FRAME_CHARACTERS,
    MAX_ITEMS_PER_COMMIT,
    MAX_ITEMS_PER_STAGE,
    type ClientMessage,
    type ServerMessage,
    type StageItem,
} from "../shared/protocol";
import type { CutoutAsset } from "../src/cutouts";
import {
    ACK_TIMEOUT_MS,
    Outbox,
    planSync,
    Relay,
    SEND_GAP_MS,
    WriterSession,
    type DesiredStage,
    type RelayHandlers,
    type WriterMessage,
} from "../src/relay";

// The parser is the backend owner's half of the protocol; these tests drive the relay with well-formed frames.
vi.mock("../shared/protocol", async (original) => ({
    ...(await original<typeof import("../shared/protocol")>()),
    parseServerMessage: (raw: string) => JSON.parse(raw) as ServerMessage,
}));

const frame = { x: 0, y: 0, width: 900, height: 560 };

function wall(id: string, x = 10): StageItem {
    return { kind: "wall", id, rect: { x, y: 10, width: 100, height: 14 }, shape: "rect", rotation: 0 };
}

function cutout(id: string, hash: string): { item: StageItem; asset: CutoutAsset } {
    return {
        item: {
            kind: "cutout",
            id,
            rect: { x: 50, y: 50, width: 40, height: 40 },
            asset: { hash, width: 40, height: 40 },
        },
        asset: { asset: { hash, width: 40, height: 40 }, pngBase64: `png-${hash}` },
    };
}

function desired(items: StageItem[], assets: CutoutAsset[] = [], frameRect = frame): DesiredStage {
    return {
        frame: frameRect,
        items: new Map(items.map((item) => [item.id, item])),
        assets: new Map(assets.map((asset) => [asset.asset.hash, asset])),
    };
}

const counter = () => {
    let n = 0;
    return () => `r${++n}`;
};
const commits = (messages: WriterMessage[]) => messages.filter((m) => m.type === "scene.commit");

describe("planSync", () => {
    it("uploads assets before a reset commit that carries the frame and every item", () => {
        const a = cutout("a", "h1");
        const messages = planSync({
            epoch: 3,
            reset: true,
            desired: desired([wall("w"), a.item], [a.asset]),
            committed: { frame: null, items: new Map() },
            uploaded: new Set(),
            nextRequestId: counter(),
        });
        expect(messages.map((m) => m.type)).toEqual(["asset.put", "scene.commit"]);
        expect(messages[0]).toMatchObject({ epoch: 3, hash: "h1", pngBase64: "png-h1" });
        expect(messages[1]).toMatchObject({ epoch: 3, reset: true, frame, removes: [] });
        expect((messages[1] as Extract<WriterMessage, { type: "scene.commit" }>).upserts.map((i) => i.id)).toEqual([
            "w",
            "a",
        ]);
    });

    it("sends a reset even for an empty stage", () => {
        const messages = planSync({
            epoch: 1,
            reset: true,
            desired: desired([]),
            committed: { frame: null, items: new Map() },
            uploaded: new Set(),
            nextRequestId: counter(),
        });
        expect(messages).toEqual([
            { type: "scene.commit", requestId: "r1", epoch: 1, reset: true, frame, upserts: [], removes: [] },
        ]);
    });

    it("splits a large reset into commits within the item and frame caps, with reset and frame only on the first", () => {
        const items = Array.from({ length: 250 }, (_, i) => wall(`w${i}`, i));
        const messages = commits(
            planSync({
                epoch: 1,
                reset: true,
                desired: desired(items),
                committed: { frame: null, items: new Map() },
                uploaded: new Set(),
                nextRequestId: counter(),
            }),
        );
        expect(messages.map((m) => m.upserts.length)).toEqual([MAX_ITEMS_PER_COMMIT, MAX_ITEMS_PER_COMMIT, 50]);
        expect(messages.map((m) => [m.reset, m.frame !== undefined])).toEqual([
            [true, true],
            [undefined, false],
            [undefined, false],
        ]);
        for (const message of messages) expect(JSON.stringify(message).length).toBeLessThan(MAX_FRAME_CHARACTERS);
    });

    it("sends only what changed since the last commit", () => {
        const before = desired([wall("keep"), wall("move"), wall("gone")]);
        const after = desired([wall("keep"), wall("move", 300), wall("new")]);
        const messages = planSync({
            epoch: 1,
            reset: false,
            desired: after,
            committed: before,
            uploaded: new Set(),
            nextRequestId: counter(),
        });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ upserts: [wall("move", 300), wall("new")], removes: ["gone"] });
        expect(messages[0]).not.toHaveProperty("frame");
        expect(messages[0]).not.toHaveProperty("reset");
    });

    it("removes before it adds, so no commit of a swap on a full stage passes the item cap", () => {
        const before = Array.from({ length: MAX_ITEMS_PER_STAGE }, (_, i) => wall(`old${i}`, i));
        const after = [
            ...before.slice(150),
            ...Array.from({ length: 150 }, (_, i) => wall(`new${i}`, i)),
        ];
        const stored = new Map(before.map((item) => [item.id, item]));
        for (const message of commits(
            planSync({
                epoch: 1,
                reset: false,
                desired: desired(after),
                committed: desired(before),
                uploaded: new Set(),
                nextRequestId: counter(),
            }),
        )) {
            for (const id of message.removes) stored.delete(id);
            for (const item of message.upserts) stored.set(item.id, item);
            expect(stored.size).toBeLessThanOrEqual(MAX_ITEMS_PER_STAGE);
        }
        expect([...stored.keys()].sort()).toEqual(after.map((item) => item.id).sort());
    });

    it("sends nothing when nothing changed", () => {
        const state = desired([wall("w")]);
        expect(
            planSync({
                epoch: 1,
                reset: false,
                desired: state,
                committed: state,
                uploaded: new Set(),
                nextRequestId: counter(),
            }),
        ).toEqual([]);
    });

    it("sends the frame alone when only the frame moved", () => {
        const before = desired([wall("w")]);
        const after = desired([wall("w")], [], { ...frame, x: 50 });
        const messages = planSync({
            epoch: 1,
            reset: false,
            desired: after,
            committed: before,
            uploaded: new Set(),
            nextRequestId: counter(),
        });
        expect(messages).toEqual([
            { type: "scene.commit", requestId: "r1", epoch: 1, frame: after.frame, upserts: [], removes: [] },
        ]);
    });

    it("uploads a shared asset once and skips assets the server already has", () => {
        const a = cutout("a", "same");
        const b = cutout("b", "same");
        const c = cutout("c", "stored");
        const messages = planSync({
            epoch: 1,
            reset: true,
            desired: desired([a.item, b.item, c.item], [a.asset, c.asset]),
            committed: { frame: null, items: new Map() },
            uploaded: new Set(["stored"]),
            nextRequestId: counter(),
        });
        expect(messages.filter((m) => m.type === "asset.put").map((m) => m.type === "asset.put" && m.hash)).toEqual([
            "same",
        ]);
    });
});

describe("WriterSession", () => {
    const writer = (connectionId: string | null, epoch: number) => ({ connectionId, epoch });

    it("writes nothing until the server names this connection", () => {
        const session = new WriterSession();
        expect(session.onWriter(writer("other", 1), "me", new Set())).toBe(false);
        expect(session.plan(1, desired([wall("w")]))).toEqual([]);
    });

    it("resets on election, then sends diffs", () => {
        const session = new WriterSession();
        expect(session.onWriter(writer("me", 2), "me", new Set())).toBe(true);
        expect(session.plan(2, desired([wall("w")]))[0]).toMatchObject({ reset: true, epoch: 2 });
        const next = session.plan(2, desired([wall("w"), wall("v")]));
        expect(next).toHaveLength(1);
        expect(next[0]).toMatchObject({ upserts: [wall("v")], removes: [] });
        expect(next[0]).not.toHaveProperty("reset");
    });

    it("ignores a repeated writer message for the same epoch", () => {
        const session = new WriterSession();
        session.onWriter(writer("me", 2), "me", new Set());
        session.plan(2, desired([wall("w")]));
        expect(session.onWriter(writer("me", 2), "me", new Set())).toBe(false);
        expect(session.plan(2, desired([wall("w")]))).toEqual([]);
    });

    it("drops a plan for an epoch it no longer holds, and resets when elected again", () => {
        const session = new WriterSession();
        session.onWriter(writer("me", 2), "me", new Set());
        session.plan(2, desired([wall("w")]));
        session.onWriter(writer("other", 3), "me", new Set());
        expect(session.plan(2, desired([wall("w"), wall("v")]))).toEqual([]);
        expect(session.onWriter(writer("me", 4), "me", new Set())).toBe(true);
        expect(session.plan(4, desired([wall("w"), wall("v")]))[0]).toMatchObject({ reset: true, epoch: 4 });
    });

    it("re-uploads every asset after the server reports one missing", () => {
        const a = cutout("a", "h1");
        const session = new WriterSession();
        session.onWriter(writer("me", 1), "me", new Set());
        expect(session.plan(1, desired([a.item], [a.asset])).map((m) => m.type)).toEqual(["asset.put", "scene.commit"]);
        expect(session.onRejected("missing_asset")).toBe(true);
        const retry = session.plan(1, desired([a.item], [a.asset]));
        expect(retry.map((m) => m.type)).toEqual(["asset.put", "scene.commit"]);
        expect(retry[1]).toMatchObject({ reset: true });
    });

    it("stops writing after a stale epoch", () => {
        const session = new WriterSession();
        session.onWriter(writer("me", 1), "me", new Set());
        expect(session.onRejected("stale_epoch")).toBe(false);
        expect(session.epoch).toBeNull();
    });
});

class FakeSocket {
    static OPEN = 1;
    static all: FakeSocket[] = [];
    readyState = 0;
    sent: ClientMessage[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.all.push(this);
    }
    send(data: string) {
        this.sent.push(JSON.parse(data) as ClientMessage);
    }
    close() {
        this.readyState = 3;
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    receive(message: ServerMessage) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
    drop(code = 1006) {
        this.readyState = 3;
        this.onclose?.({ code });
    }
}

describe("Relay", () => {
    const participant = { presenceId: "p1", name: "Ming", color: "#7c3aed" };
    const snapshot = { revision: 0, frame, items: [] };
    let handlers: { [K in keyof RelayHandlers]: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("WebSocket", FakeSocket);
        FakeSocket.all = [];
        handlers = {
            welcomed: vi.fn(),
            syncNeeded: vi.fn(),
            walker: vi.fn(),
            walkerLeft: vi.fn(),
            rejected: vi.fn(),
            refused: vi.fn(),
        };
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function connect() {
        const relay = new Relay("https://stage.example", "s1", "t1", participant, handlers as unknown as RelayHandlers);
        relay.start();
        const socket = FakeSocket.all.at(-1)!;
        socket.open();
        return { relay, socket };
    }

    function elect(socket: FakeSocket, epoch = 1) {
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch },
            snapshot,
            walkers: [],
        });
    }

    const sentCommits = (socket: FakeSocket) =>
        socket.sent.filter((m) => m.type === "scene.commit") as Extract<ClientMessage, { type: "scene.commit" }>[];

    it("says hello as a driver to the stage's socket URL", () => {
        const { socket } = connect();
        expect(socket.url).toBe("wss://stage.example/api/stages/s1");
        expect(socket.sent[0]).toEqual({
            type: "hello",
            v: 2,
            stageId: "s1",
            token: "t1",
            role: "driver",
            participant,
        });
    });

    it("stays silent while another driver writes", () => {
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "me",
            writer: { connectionId: "other", epoch: 1 },
            snapshot,
            walkers: [],
        });
        expect(handlers.welcomed).toHaveBeenCalledOnce();
        expect(relay.writerEpoch).toBeNull();
        relay.commit(1, desired([wall("w")]));
        relay.sendCursors([{ ...participant, x: 1, y: 2 }]);
        expect(socket.sent.map((m) => m.type)).toEqual(["hello"]);
    });

    it("commits as writer, and after a reconnect resets the stage under the new epoch", () => {
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 1 },
            snapshot,
            walkers: [],
        });
        expect(handlers.syncNeeded).toHaveBeenCalledOnce();
        relay.commit(1, desired([wall("w")]));
        relay.commit(1, desired([wall("w"), wall("v")]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        expect(socket.sent.slice(1)).toMatchObject([
            { type: "scene.commit", epoch: 1, reset: true, upserts: [wall("w")] },
            { type: "scene.commit", epoch: 1, upserts: [wall("v")], removes: [] },
        ]);

        socket.drop();
        expect(relay.writerEpoch).toBeNull();
        vi.advanceTimersByTime(1_000);
        const next = FakeSocket.all.at(-1)!;
        expect(next).not.toBe(socket);
        next.open();
        next.receive({
            type: "welcome",
            v: 2,
            connectionId: "c2",
            writer: { connectionId: "c2", epoch: 2 },
            snapshot: { ...snapshot, revision: 1 },
            walkers: [],
        });
        expect(handlers.welcomed).toHaveBeenCalledOnce();
        relay.commit(2, desired([wall("w"), wall("v")]));
        expect(next.sent.slice(1)).toMatchObject([
            { type: "scene.commit", epoch: 2, reset: true, upserts: [wall("w"), wall("v")] },
        ]);
    });

    it("skips uploading assets already in the welcome snapshot", () => {
        const a = cutout("a", "h1");
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 1 },
            snapshot: { revision: 3, frame, items: [a.item] },
            walkers: [],
        });
        relay.commit(1, desired([a.item], [a.asset]));
        expect(socket.sent.slice(1).map((m) => m.type)).toEqual(["scene.commit"]);
    });

    it("hands writer duty over when the server elects someone else", () => {
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 1 },
            snapshot,
            walkers: [],
        });
        socket.receive({ type: "writer", writer: { connectionId: "c9", epoch: 2 } });
        relay.commit(1, desired([wall("w")]));
        expect(socket.sent.map((m) => m.type)).toEqual(["hello"]);
    });

    it("relays cursors only as writer, fenced by epoch", () => {
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 5 },
            snapshot,
            walkers: [],
        });
        relay.sendCursors([{ ...participant, x: 1, y: 2 }]);
        expect(socket.sent.at(-1)).toEqual({ type: "cursors", epoch: 5, cursors: [{ ...participant, x: 1, y: 2 }] });
    });

    it("stops for good on a bad token", () => {
        const { socket } = connect();
        socket.drop(4401);
        vi.advanceTimersByTime(60_000);
        expect(handlers.refused).toHaveBeenCalledWith("bad_token");
        expect(FakeSocket.all).toHaveLength(1);
    });

    it("backs off between failed connections", () => {
        connect().socket.drop();
        vi.advanceTimersByTime(300);
        expect(FakeSocket.all).toHaveLength(1);
        vi.advanceTimersByTime(400);
        expect(FakeSocket.all).toHaveLength(2);
        FakeSocket.all[1].drop();
        vi.advanceTimersByTime(700);
        expect(FakeSocket.all).toHaveLength(2);
        vi.advanceTimersByTime(600);
        expect(FakeSocket.all).toHaveLength(3);
    });

    it("passes walkers on and reports rejected commits", () => {
        const { relay, socket } = connect();
        const walker = { connectionId: "v1", participant, pose: { x: 1, y: 2, heading: 0, pitch: 0 } };
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 1 },
            snapshot,
            walkers: [walker],
        });
        socket.receive({ type: "walker.left", connectionId: "v1" });
        relay.commit(1, desired([wall("w")]));
        const sent = socket.sent.at(-1) as Extract<ClientMessage, { type: "scene.commit" }>;
        socket.receive({ type: "ack", requestId: sent.requestId, ok: false, error: "bad_message", message: "bad item" });
        expect(handlers.walker).toHaveBeenCalledWith(walker);
        expect(handlers.walkerLeft).toHaveBeenCalledWith("v1");
        expect(handlers.rejected).toHaveBeenCalledWith("bad_message", "bad item");
    });

    it("ignores a late ack for a request it no longer waits on, so it keeps writing after re-election", () => {
        const { relay, socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c1", epoch: 1 },
            snapshot,
            walkers: [],
        });
        relay.commit(1, desired([wall("w")]));
        const first = socket.sent.at(-1) as Extract<ClientMessage, { type: "scene.commit" }>;
        vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1_000);
        socket.receive({ type: "writer", writer: { connectionId: "c1", epoch: 2 } });
        socket.receive({
            type: "ack",
            requestId: first.requestId,
            ok: false,
            error: "stale_epoch",
            message: "epoch 1 is over",
        });
        expect(handlers.rejected).not.toHaveBeenCalled();
        expect(relay.writerEpoch).toBe(2);
        relay.commit(2, desired([wall("w")]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        expect(socket.sent.at(-1)).toMatchObject({ type: "scene.commit", epoch: 2, reset: true, upserts: [wall("w")] });
    });

    it("pings every 10 seconds", () => {
        const { socket } = connect();
        socket.receive({
            type: "welcome",
            v: 2,
            connectionId: "c1",
            writer: { connectionId: "c9", epoch: 1 },
            snapshot,
            walkers: [],
        });
        vi.advanceTimersByTime(10_000);
        expect(socket.sent.at(-1)).toMatchObject({ type: "ping" });
    });

    it("never resends an unanswered commit; after the ack timeout it resyncs the newest scene", () => {
        const { relay, socket } = connect();
        elect(socket);
        relay.commit(1, desired([wall("w")]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        relay.commit(1, desired([wall("w", 50)]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        const unanswered = sentCommits(socket).map((m) => m.requestId);
        expect(unanswered).toHaveLength(2);
        vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1_000);
        const later = sentCommits(socket).slice(2);
        expect(later.map((m) => m.requestId)).not.toContain(unanswered[0]);
        expect(later.map((m) => m.requestId)).not.toContain(unanswered[1]);
        expect(later).toMatchObject([{ type: "scene.commit", epoch: 1, reset: true, upserts: [wall("w", 50)] }]);
    });

    it("drops the commits still waiting when one is rejected, and resets on the next sync", () => {
        const { relay, socket } = connect();
        elect(socket);
        relay.commit(1, desired([wall("w")]));
        relay.commit(1, desired([wall("w"), wall("v")]));
        const [first] = sentCommits(socket);
        socket.receive({ type: "ack", requestId: first.requestId, ok: false, error: "bad_message", message: "bad" });
        vi.advanceTimersByTime(ACK_TIMEOUT_MS * 2);
        expect(sentCommits(socket)).toHaveLength(1);
        relay.commit(1, desired([wall("w"), wall("v")]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        expect(sentCommits(socket).slice(1)).toMatchObject([
            { type: "scene.commit", reset: true, upserts: [wall("w"), wall("v")] },
        ]);
    });

    it("keeps only the newest board while a batch drains, then sends one diff with its uploads first", () => {
        const { relay, socket } = connect();
        elect(socket);
        const shots = Array.from({ length: 10 }, (_, i) => cutout(`c${i}`, `h${i}`));
        const late = cutout("late", "h-late");
        const board = (x: number, extra: typeof shots = []) =>
            desired(
                [wall("w", x), ...[...shots, ...extra].map((shot) => shot.item)],
                [...shots, ...extra].map((shot) => shot.asset),
            );
        relay.commit(1, board(10));
        for (let x = 11; x <= 19; x++) {
            vi.advanceTimersByTime(SEND_GAP_MS);
            relay.commit(1, board(x, x >= 15 ? [late] : []));
        }
        vi.advanceTimersByTime(SEND_GAP_MS * 20);
        const writes = socket.sent.filter((m) => m.type === "asset.put" || m.type === "scene.commit");
        expect(writes.map((m) => m.type)).toEqual([
            ...shots.map(() => "asset.put"),
            "scene.commit",
            "asset.put",
            "scene.commit",
        ]);
        expect(writes.at(-2)).toMatchObject({ hash: "h-late" });
        expect(writes.at(-1)).toMatchObject({ upserts: [wall("w", 19), late.item], removes: [] });
    });

    it("takes a limit ack as a stage cap: reports it, never replays the commit, and resets on the next sync", () => {
        const { relay, socket } = connect();
        elect(socket);
        relay.commit(1, desired([wall("w")]));
        const [first] = sentCommits(socket);
        socket.receive({
            type: "ack",
            requestId: first.requestId,
            ok: false,
            error: "limit",
            message: "a stage holds at most 400 items",
        });
        expect(handlers.rejected).toHaveBeenCalledWith("limit", "a stage holds at most 400 items");
        vi.advanceTimersByTime(20_000);
        expect(sentCommits(socket)).toHaveLength(1);
        relay.commit(1, desired([wall("w")]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        expect(sentCommits(socket).slice(1)).toMatchObject([{ reset: true, upserts: [wall("w")] }]);
    });

    it("pauses for a second when the server says it is dropping this socket's messages", () => {
        const { relay, socket } = connect();
        elect(socket);
        const shots = ["h1", "h2", "h3"].map((hash, i) => cutout(`c${i}`, hash));
        relay.commit(
            1,
            desired(
                shots.map((shot) => shot.item),
                shots.map((shot) => shot.asset),
            ),
        );
        const writes = () => socket.sent.filter((m) => m.type === "asset.put" || m.type === "scene.commit").length;
        expect(writes()).toBe(1);
        socket.receive({ type: "error", code: "limit", message: "more than 60 messages per second; dropping" });
        vi.advanceTimersByTime(1_000 - 1);
        expect(writes()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(writes()).toBe(2);
    });

    it("resyncs the newest scene when a later ack shows the server dropped a commit", () => {
        const { relay, socket } = connect();
        elect(socket);
        relay.commit(1, desired([wall("w")]));
        relay.commit(1, desired([wall("w", 50)]));
        vi.advanceTimersByTime(SEND_GAP_MS);
        const [dropped, landed] = sentCommits(socket);
        socket.receive({ type: "ack", requestId: landed.requestId, ok: true, revision: 1 });
        vi.advanceTimersByTime(SEND_GAP_MS);
        expect(socket.sent.at(-1)).toMatchObject({ type: "scene.commit", reset: true, upserts: [wall("w", 50)] });
        expect(sentCommits(socket).filter((m) => m.requestId === dropped.requestId)).toHaveLength(1);
    });
});

describe("Outbox", () => {
    let now = 0;
    const clock = () => now;
    const put = (requestId: string): WriterMessage => ({
        type: "asset.put",
        requestId,
        epoch: 1,
        hash: requestId,
        width: 1,
        height: 1,
        pngBase64: "",
    });
    const commit = (requestId: string): WriterMessage => ({
        type: "scene.commit",
        requestId,
        epoch: 1,
        upserts: [],
        removes: [],
    });
    const drain = (outbox: Outbox) => {
        const sent: string[] = [];
        for (let next = outbox.take(); next && "message" in next; next = outbox.take())
            sent.push(next.message.requestId);
        return sent;
    };

    beforeEach(() => {
        now = 0;
    });

    it("sends at most one message per gap, in order", () => {
        const outbox = new Outbox(clock);
        outbox.push([put("a"), put("b"), commit("c")]);
        expect(drain(outbox)).toEqual(["a"]);
        expect(outbox.take()).toEqual({ waitMs: SEND_GAP_MS });
        now += SEND_GAP_MS;
        expect(drain(outbox)).toEqual(["b"]);
        now += SEND_GAP_MS;
        expect(drain(outbox)).toEqual(["c"]);
        expect(outbox.take()).toBeNull();
    });

    it("gives up on unanswered messages after the ack timeout: uploads go back in order, commits are lost", () => {
        const outbox = new Outbox(clock);
        outbox.push([put("a"), commit("c"), put("b")]);
        for (let i = 0; i < 3; i++, now += SEND_GAP_MS) drain(outbox);
        now += ACK_TIMEOUT_MS - 3 * SEND_GAP_MS - 1;
        expect(outbox.expire()).toBeNull();
        now += 1;
        expect(outbox.expire()).toEqual({ lost: true });
        expect(drain(outbox)).toEqual(["a"]);
        now += SEND_GAP_MS;
        expect(drain(outbox)).toEqual(["b"]);
        now += SEND_GAP_MS;
        expect(outbox.take()).toBeNull();
    });

    it("re-queues a dropped upload but asks for a resync after a dropped commit", () => {
        const outbox = new Outbox(clock);
        outbox.push([put("p"), commit("c1"), commit("c2")]);
        for (let i = 0; i < 3; i++, now += SEND_GAP_MS) drain(outbox);
        expect(outbox.settle("c1")?.lost).toBe(false);
        expect(drain(outbox)).toEqual(["p"]);

        const second = new Outbox(clock);
        second.push([commit("c1"), commit("c2")]);
        for (let i = 0; i < 2; i++, now += SEND_GAP_MS) drain(second);
        expect(second.settle("c2")?.lost).toBe(true);
    });

});
