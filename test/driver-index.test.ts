import type {
    CollaborationUserPresence,
    DomElementSchema,
    DriverCommandIssuer,
    DriverCommandRequest,
    DriverManifest,
    DriverSubscriptionEvent,
    ModuleStyling,
    SubscribedDrawdyElement,
} from "@drawdy/driver-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, Rect, ServerMessage } from "../shared/protocol";
import { captureArea, exportBounds, turnedBox } from "../src/cutouts";
import { rectOf } from "../src/stage-model";

// The parser is the backend owner's half of the protocol; these tests drive the driver with well-formed frames.
vi.mock("../shared/protocol", async (original) => ({
    ...(await original<typeof import("../shared/protocol")>()),
    parseServerMessage: (raw: string) => JSON.parse(raw) as ServerMessage,
}));

class FakeSocket {
    static OPEN = 1;
    static all: FakeSocket[] = [];
    readyState = 0;
    closedWith: number | undefined;
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
    close(code?: number) {
        this.readyState = 3;
        this.closedWith = code;
    }
    open() {
        this.readyState = 1;
        this.onopen?.();
    }
    receive(message: ServerMessage) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

// Drawdy's export, as the probes measured it: the whole box of everything the area touches, padded by 20 units, at
// scale 1. The PNG this fake hands back records the area it was taken at, so a test can tell which capture landed.
const EXPORT_PAD = 20;
type FakeBitmap = { width: number; height: number; area: Rect; close(): void };

class FakeCanvas {
    private drawn: Rect | null = null;
    getContext() {
        return { drawImage: (bitmap: FakeBitmap) => (this.drawn = bitmap.area) };
    }
    convertToBlob() {
        return Promise.resolve(new Blob([JSON.stringify(this.drawn)]));
    }
}

async function decodeFakePng(blob: Blob): Promise<FakeBitmap> {
    const shot = JSON.parse(await blob.text()) as { area: Rect; width: number; height: number };
    return { ...shot, close() {} };
}

const pictureOf = (message: Extract<ClientMessage, { type: "asset.put" }>) =>
    JSON.parse(atob(message.pngBase64)) as Rect;

const FRAME_ID = "frame";
const frame: SubscribedDrawdyElement = {
    id: FRAME_ID,
    type: "frame",
    x: 0,
    y: 0,
    width: 900,
    height: 560,
    rotation: 0,
    meta: { paperStage: { v: 1, stageId: "s1", token: "t1" } },
};

function doodle(id: string, x: number, y: number): SubscribedDrawdyElement {
    return {
        id,
        type: "freedraw",
        x,
        y,
        width: 40,
        height: 20,
        rotation: 0,
        frameId: FRAME_ID,
        points: [
            [x, y],
            [x + 40, y + 20],
        ],
        strokeColor: "#1e1e1e",
    };
}

type Answer = { value?: unknown; error?: { type: string; message: string } };

class FakeDrawdy {
    readonly elements = new Map<string, SubscribedDrawdyElement>();
    readonly requests: DriverCommandRequest[] = [];
    users: CollaborationUserPresence[] = [
        { id: "me", name: "Ming", color: "#7c3aed", isHost: true, isSelf: true, cursorPosition: null },
    ];
    window = { width: 1000, height: 800 };
    failCaptures = 0;
    /** Runs while Drawdy works on a capture, before it answers. */
    duringCapture: () => void = () => {};

    constructor(elements: SubscribedDrawdyElement[]) {
        for (const element of elements) this.elements.set(element.id, element);
    }

    readonly issue = (async (request: DriverCommandRequest) => {
        this.requests.push(request);
        return { ...request, res: this.answer(request) };
    }) as unknown as DriverCommandIssuer;

    sent<T extends DriverCommandRequest["type"]>(type: T) {
        return this.requests.filter((request) => request.type === type) as Extract<DriverCommandRequest, { type: T }>[];
    }

    private answer(request: DriverCommandRequest): Answer {
        switch (request.type) {
            case "command:scene:get-drawdy-elements":
                return { value: { drawdyElements: [...this.elements.values()] } };
            case "command:collaboration:get-all-users-in-board":
                return { value: { users: this.users } };
            case "command:dom:window-size":
                return { value: this.window };
            case "command:scene:create-drawdy-preview-elements":
                return { value: { previewed: request.req.elements.length, previewId: `pv${this.requests.length}` } };
            case "command:scene:capture-screenshot": {
                this.duringCapture();
                if (this.failCaptures > 0) {
                    this.failCaptures--;
                    return { error: { type: "runtime", message: "export failed" } };
                }
                const { area } = request.req;
                const boxes = [...this.elements.values()].flatMap((element) => {
                    const rect = rectOf(element);
                    return rect ? [turnedBox(rect, element.rotation ?? 0)] : [];
                });
                const bounds = exportBounds(area, boxes)!;
                const shot = { area, width: bounds.width + EXPORT_PAD * 2, height: bounds.height + EXPORT_PAD * 2 };
                return { value: { png: new Blob([JSON.stringify(shot)]) } };
            }
            default:
                return { value: {} };
        }
    }
}

const styling = { foreground: "#111111", surface: "#ffffff", border: "#dddddd" } as ModuleStyling;

async function startDriver(fake: FakeDrawdy) {
    vi.resetModules();
    const driver = await import("../src/index");
    let ids = 0;
    await driver.activate({
        issueCommand: fake.issue,
        manifest: { driverId: "mingrath.paper-stage" } as DriverManifest,
        styling,
        generateId: () => `g${++ids}`,
    });
    const emit = (event: unknown) => driver.onEvent(event as DriverSubscriptionEvent);
    await emit({ type: "subscription:dom:element-clicked", body: { domElementId: "paper-stage-button" } });
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    // Like the stage server, a driver whose socket is still open keeps the writer's seat.
    const connectionIdOf = (s: FakeSocket) => `c${FakeSocket.all.indexOf(s) + 1}`;
    const seated = FakeSocket.all.find((other) => other !== socket && other.readyState === FakeSocket.OPEN);
    socket.receive({
        type: "welcome",
        v: 2,
        connectionId: connectionIdOf(socket),
        writer: { connectionId: connectionIdOf(seated ?? socket), epoch: FakeSocket.all.length },
        snapshot: { revision: 0, frame: rectOf(frame)!, items: [] },
        walkers: [],
    });
    const moveElement = (element: SubscribedDrawdyElement) => {
        fake.elements.set(element.id, element);
        void emit({ type: "subscription:scene:elements-updated", body: { drawdyElements: [element], properties: [] } });
    };
    return { socket, emit, moveElement };
}

const writes = (socket: FakeSocket) =>
    socket.sent.filter((m) => m.type === "asset.put" || m.type === "scene.commit") as Extract<
        ClientMessage,
        { type: "asset.put" | "scene.commit" }
    >[];
const puts = (socket: FakeSocket) =>
    socket.sent.filter((m) => m.type === "asset.put") as Extract<ClientMessage, { type: "asset.put" }>[];

function findIframe(schema: DomElementSchema): { srcDoc: string } | null {
    if (schema.type === "iframe") return schema.child as { srcDoc: string };
    for (const child of "children" in schema ? (schema.children ?? []) : []) {
        const found = findIframe(child);
        if (found) return found;
    }
    return null;
}

describe("the driver against a fake Drawdy", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal("WebSocket", FakeSocket);
        vi.stubGlobal("createImageBitmap", decodeFakePng);
        vi.stubGlobal("OffscreenCanvas", FakeCanvas);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        FakeSocket.all = [];
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("stands up a doodle as a cutout captured where it sits", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100)]);
        const { socket } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        const area = captureArea(rectOf(doodle("d", 100, 100))!, 0);
        expect(puts(socket).map(pictureOf)).toEqual([area]);
        expect(writes(socket).at(-1)).toMatchObject({
            type: "scene.commit",
            reset: true,
            upserts: [{ id: "d", rect: area }],
        });
    });

    it("throws away a capture of a cutout that moved while Drawdy exported it, and captures it again", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100)]);
        const { socket, moveElement } = await startDriver(fake);
        fake.duringCapture = () => {
            fake.duringCapture = () => {};
            moveElement(doodle("d", 400, 300));
        };
        await vi.advanceTimersByTimeAsync(1_000);
        const moved = captureArea(rectOf(doodle("d", 400, 300))!, 0);
        expect(puts(socket).map(pictureOf)).toEqual([moved]);
        expect(writes(socket).at(-1)).toMatchObject({ type: "scene.commit", upserts: [{ id: "d", rect: moved }] });
    });

    it("captures a cutout again when a drawing overlapping its picture moves or changes", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100), doodle("n", 125, 110)]);
        const { moveElement } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        const area = captureArea(rectOf(doodle("d", 100, 100))!, 0);
        const capturesOfD = () =>
            fake
                .sent("command:scene:capture-screenshot")
                .filter((r) => JSON.stringify(r.req.area) === JSON.stringify(area));
        expect(capturesOfD()).toHaveLength(1);
        moveElement(doodle("n", 130, 112));
        await vi.advanceTimersByTimeAsync(500);
        expect(capturesOfD()).toHaveLength(2);
        moveElement({ ...doodle("n", 130, 112), strokeColor: "#e03131" });
        await vi.advanceTimersByTimeAsync(500);
        expect(capturesOfD()).toHaveLength(3);
    });

    it("throws away a capture taken while an overlapping drawing moved, and captures it again", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100), doodle("n", 125, 110)]);
        const area = captureArea(rectOf(doodle("d", 100, 100))!, 0);
        const { moveElement } = await startDriver(fake);
        fake.duringCapture = () => {
            fake.duringCapture = () => {};
            moveElement(doodle("n", 130, 112));
        };
        await vi.advanceTimersByTimeAsync(1_000);
        const capturesOfD = fake
            .sent("command:scene:capture-screenshot")
            .filter((r) => JSON.stringify(r.req.area) === JSON.stringify(area));
        expect(capturesOfD).toHaveLength(2);
    });

    it("keeps a cutout on the stage with its last picture while a new one is pending or fails", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100), doodle("n", 300, 300)]);
        const { socket, moveElement } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        const before = writes(socket).length;
        let step = 0;
        fake.duringCapture = () => {
            if (++step <= 3) moveElement(doodle("n", 125 + step, 110));
        };
        moveElement(doodle("n", 125, 110));
        await vi.advanceTimersByTimeAsync(1_000);
        fake.failCaptures = 1;
        moveElement(doodle("n", 300, 300));
        await vi.advanceTimersByTimeAsync(500);
        const commits = writes(socket)
            .slice(before)
            .filter((m) => m.type === "scene.commit");
        expect(commits.length).toBeGreaterThan(1);
        expect(commits.flatMap((m) => m.removes)).toEqual([]);
    });

    it("keeps a cutout's picture while it is dragged around inside a room", async () => {
        const room = { ...doodle("room", 50, 50), type: "path", componentType: "rect", width: 400, height: 300 };
        const fake = new FakeDrawdy([frame, room as SubscribedDrawdyElement, doodle("d", 100, 100)]);
        const { socket, moveElement } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        for (let step = 1; step <= 5; step++) {
            moveElement(doodle("d", 100 + step * 20, 100 + step * 10));
            await vi.advanceTimersByTimeAsync(200);
        }
        expect(fake.sent("command:scene:capture-screenshot")).toHaveLength(1);
        expect(writes(socket).at(-1)).toMatchObject({ type: "scene.commit", upserts: [{ id: "d" }] });
    });

    it("retries a failed capture on its own, without waiting for the drawing to change", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100)]);
        fake.failCaptures = 1;
        const { socket } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        expect(fake.sent("command:scene:capture-screenshot")).toHaveLength(1);
        expect(puts(socket)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.sent("command:scene:capture-screenshot")).toHaveLength(2);
        expect(puts(socket)).toHaveLength(1);
        expect(writes(socket).at(-1)).toMatchObject({ type: "scene.commit", upserts: [{ id: "d" }] });
    });

    it("still commits a board change at once while a failed capture waits to retry", async () => {
        const wall = { ...doodle("w", 300, 300), type: "path", componentType: "rect", points: undefined };
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100), wall as SubscribedDrawdyElement]);
        fake.failCaptures = 1;
        const { socket, moveElement } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(300);
        moveElement({ ...wall, x: 320 } as SubscribedDrawdyElement);
        await vi.advanceTimersByTimeAsync(150);
        expect(writes(socket).at(-1)).toMatchObject({ type: "scene.commit", upserts: [{ id: "w", rect: { x: 320 } }] });
    });

    it("relays the cursors from the board's user list as soon as it becomes the writer", async () => {
        const fake = new FakeDrawdy([frame]);
        fake.users = [
            ...fake.users,
            {
                id: "friend",
                name: "Ploy",
                color: "#0ca678",
                isHost: false,
                isSelf: false,
                cursorPosition: { x: 5, y: 6 },
            },
        ];
        const { socket } = await startDriver(fake);
        expect(socket.sent.filter((m) => m.type === "cursors")).toEqual([
            {
                type: "cursors",
                epoch: 1,
                cursors: [{ presenceId: "friend", name: "Ploy", color: "#0ca678", x: 5, y: 6 }],
            },
        ]);
    });

    it("shows walkers on the board as local previews and never moves the shared pawn", async () => {
        const pawn = {
            id: "pawn",
            type: "path",
            componentType: "circle",
            x: 200,
            y: 200,
            width: 36,
            height: 36,
            frameId: FRAME_ID,
            meta: { paperStageRole: "pawn" },
        } as SubscribedDrawdyElement;
        const fake = new FakeDrawdy([frame, pawn]);
        const { socket } = await startDriver(fake);
        const me = { presenceId: "me", name: "Ming", color: "#7c3aed" };
        for (let x = 300; x <= 400; x += 20) {
            socket.receive({
                type: "walker",
                walker: { connectionId: "v1", participant: me, pose: { x, y: 250, heading: 0, pitch: 0 } },
            });
            await vi.advanceTimersByTimeAsync(50);
        }
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fake.sent("command:scene:update-drawdy-elements")).toEqual([]);
        const [created] = fake.sent("command:scene:create-drawdy-preview-elements");
        expect(created.req.elements).toContainEqual(expect.objectContaining({ type: "text", text: "Ming" }));
        socket.receive({ type: "walker.left", connectionId: "v1" });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.sent("command:scene:delete-drawdy-preview-elements")).toHaveLength(1);
    });

    it("hands the stage to a driver reloaded into the same worker, and the old one goes quiet", async () => {
        const fake = new FakeDrawdy([frame, doodle("d", 100, 100)]);
        const old = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(500);
        const heardFromOld = old.socket.sent.length;

        const reloaded = await startDriver(fake);
        expect(old.socket).toMatchObject({ readyState: 3, closedWith: 1000 });
        reloaded.moveElement(doodle("d", 300, 200));
        await vi.advanceTimersByTimeAsync(60_000);

        expect(old.socket.sent).toHaveLength(heardFromOld);
        expect(FakeSocket.all).toHaveLength(2);
        expect(writes(reloaded.socket).at(-1)).toMatchObject({
            type: "scene.commit",
            upserts: [{ id: "d", rect: captureArea(rectOf(doodle("d", 300, 200))!, 0) }],
        });
    });

    it("refits the open view to a resized window once resizing settles, keeping the same page", async () => {
        const fake = new FakeDrawdy([frame]);
        const { emit } = await startDriver(fake);
        await vi.advanceTimersByTimeAsync(0);
        const views = () =>
            fake.sent("command:dom:upsert-floating-element").filter((r) => r.req.domId === "paper-stage-view");
        expect(views()).toHaveLength(1);
        for (const width of [1100, 1200, 1300]) {
            await emit({ type: "subscription:dom:screen-resized", body: { width, height: 900 } });
            await vi.advanceTimersByTimeAsync(50);
        }
        expect(views()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(500);
        const [opened, refit] = views();
        expect(views()).toHaveLength(2);
        expect(refit.req.position).toEqual({ x: 130, y: 90 });
        expect(refit.req.schema.styles).toMatchObject({ width: [1040, "px"], height: [720, "px"] });
        expect(findIframe(refit.req.schema)).toEqual(findIframe(opened.req.schema));
    });
});
