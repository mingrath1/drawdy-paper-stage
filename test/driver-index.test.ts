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

const pictureOf = (message: Extract<ClientMessage, { type: "asset.put" }>) => JSON.parse(atob(message.pngBase64)) as Rect;

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
    socket.receive({
        type: "welcome",
        v: 2,
        connectionId: "c1",
        writer: { connectionId: "c1", epoch: 1 },
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
        expect(writes(socket).at(-1)).toMatchObject({ type: "scene.commit", reset: true, upserts: [{ id: "d", rect: area }] });
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
});
