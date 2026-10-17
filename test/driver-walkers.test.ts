import type { DriverCommandIssuer, DriverCommandRequest, ModuleStyling } from "@drawdy/driver-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALKER_TTL_MS, type Walker } from "../shared/protocol";
import { Host } from "../src/host";
import { WalkerMarkers } from "../src/walkers";

type Request = DriverCommandRequest & { req?: Record<string, unknown> };
type Schema = { type: string; drawdyElementId: string; x: number; y: number; [key: string]: unknown };

function fakeDrawdy() {
    const requests: Request[] = [];
    const failing = new Set<string>();
    let previews = 0;
    const issue = ((request: Request) => {
        requests.push(request);
        if (failing.has(request.type))
            return Promise.resolve({ ...request, res: { error: { type: "runtime", message: "busy" } } });
        const value =
            request.type === "command:scene:create-drawdy-preview-elements"
                ? { previewed: 2, previewId: `pv${++previews}` }
                : {};
        return Promise.resolve({ ...request, res: { value } });
    }) as unknown as DriverCommandIssuer;
    const of = (type: string) => requests.filter((request) => request.type === type);
    return { issue, requests, of, failing };
}

const walker = (connectionId: string, x: number, y: number, name = "Ploy"): Walker => ({
    connectionId,
    participant: { presenceId: `p-${connectionId}`, name, color: "#0ca678" },
    pose: { x, y, heading: 0, pitch: 0 },
});

const dotOf = (elements: unknown) => (elements as Schema[]).find((element) => element.type === "shape")!;
const centerOf = (elements: unknown) => {
    const dot = dotOf(elements);
    return { x: dot.x + (dot.width as number) / 2, y: dot.y + (dot.height as number) / 2 };
};

describe("WalkerMarkers", () => {
    let drawdy: ReturnType<typeof fakeDrawdy>;
    let markers: WalkerMarkers;

    beforeEach(() => {
        vi.useFakeTimers();
        drawdy = fakeDrawdy();
        markers = new WalkerMarkers(new Host(drawdy.issue, "d", {} as ModuleStyling), "#1e1e1e");
    });
    afterEach(() => vi.useRealTimers());

    it("draws a walker as a dot and a name at its spot, as local preview elements the pointer passes through", async () => {
        markers.show(walker("v1", 300, 200));
        await vi.advanceTimersByTimeAsync(0);
        const [created] = drawdy.of("command:scene:create-drawdy-preview-elements");
        expect(created.req!.hitTestable).toBeFalsy();
        const elements = created.req!.elements as Schema[];
        expect(centerOf(elements)).toEqual({ x: 300, y: 200 });
        expect(dotOf(elements)).toMatchObject({ componentType: "circle", fillColor: "#0ca678" });
        expect(elements.find((element) => element.type === "text")).toMatchObject({ text: "Ploy" });
        expect(drawdy.requests.map((request) => request.type)).toEqual([
            "command:scene:create-drawdy-preview-elements",
        ]);
    });

    it("labels this person's own walker You and everyone else by name", async () => {
        const mine = new WalkerMarkers(new Host(drawdy.issue, "d", {} as ModuleStyling), "#1e1e1e", Date.now, "p-me");
        mine.show(walker("me", 100, 100, "Mingrath"));
        mine.show(walker("v2", 300, 100, "Ploy"));
        await vi.advanceTimersByTimeAsync(0);
        const labels = drawdy
            .of("command:scene:create-drawdy-preview-elements")
            .map((request) => (request.req!.elements as Schema[]).find((element) => element.type === "text")!.text);
        expect(labels).toEqual(["You", "Ploy"]);
    });

    it("eases toward each new pose instead of jumping, then goes quiet once it arrives", async () => {
        markers.show(walker("v1", 0, 0));
        await vi.advanceTimersByTimeAsync(0);
        markers.show(walker("v1", 100, 0));
        await vi.advanceTimersByTimeAsync(50);
        const first = centerOf(drawdy.of("command:scene:update-drawdy-preview-elements")[0].req!.elements);
        expect(first.x).toBeGreaterThan(0);
        expect(first.x).toBeLessThan(100);
        await vi.advanceTimersByTimeAsync(2_000);
        const updates = drawdy.of("command:scene:update-drawdy-preview-elements");
        expect(centerOf(updates.at(-1)!.req!.elements)).toEqual({ x: 100, y: 0 });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(drawdy.of("command:scene:update-drawdy-preview-elements")).toHaveLength(updates.length);
    });

    it(`fades out a walker silent for ${WALKER_TTL_MS / 1000} s, then deletes it`, async () => {
        markers.show(walker("v1", 0, 0));
        await vi.advanceTimersByTimeAsync(WALKER_TTL_MS);
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements")).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        const opacities = drawdy
            .of("command:scene:update-drawdy-preview-elements")
            .map((update) => dotOf(update.req!.elements).opacity as number);
        expect(opacities.length).toBeGreaterThan(1);
        expect(opacities).toEqual([...opacities].sort((a, b) => b - a));
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements").map((r) => r.req!.previewIds)).toEqual([
            ["pv1"],
        ]);
    });

    it("keeps an idle walker whose keepalive poses keep coming", async () => {
        for (let t = 0; t < 3; t++) {
            markers.show(walker("v1", 0, 0));
            await vi.advanceTimersByTimeAsync(4_000);
        }
        await vi.advanceTimersByTimeAsync(4_000);
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements")).toEqual([]);
        expect(drawdy.of("command:scene:update-drawdy-preview-elements")).toEqual([]);
    });

    it("shows a fading walker at full strength again when its keepalive returns at the same spot", async () => {
        markers.show(walker("v1", 0, 0));
        await vi.advanceTimersByTimeAsync(WALKER_TTL_MS + 120);
        const fading = drawdy.of("command:scene:update-drawdy-preview-elements");
        expect(dotOf(fading.at(-1)!.req!.elements).opacity).toBeLessThan(1);
        markers.show(walker("v1", 0, 0));
        await vi.advanceTimersByTimeAsync(1_000);
        const last = drawdy.of("command:scene:update-drawdy-preview-elements").at(-1)!;
        expect(dotOf(last.req!.elements).opacity ?? 1).toBe(1);
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements")).toEqual([]);
    });

    it("keeps retrying a failed delete, backing off, until the marker is gone", async () => {
        markers.show(walker("v1", 0, 0));
        await vi.advanceTimersByTimeAsync(0);
        drawdy.failing.add("command:scene:delete-drawdy-preview-elements");
        markers.leave("v1");
        await vi.advanceTimersByTimeAsync(60_000);
        const tries = drawdy.of("command:scene:delete-drawdy-preview-elements");
        expect(tries.length).toBeGreaterThan(3);
        expect(tries.length).toBeLessThan(30);
        expect(tries.every((r) => (r.req!.previewIds as string[]).join() === "pv1")).toBe(true);
        drawdy.failing.clear();
        await vi.advanceTimersByTimeAsync(10_000);
        const after = drawdy.of("command:scene:delete-drawdy-preview-elements").length;
        expect(after).toBe(tries.length + 1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements")).toHaveLength(after);
    });

    it("deletes a marker whose delete is still being retried when it stops", async () => {
        markers.show(walker("v1", 0, 0));
        markers.show(walker("v2", 50, 50, "Ming"));
        await vi.advanceTimersByTimeAsync(0);
        drawdy.failing.add("command:scene:delete-drawdy-preview-elements");
        markers.leave("v1");
        await vi.advanceTimersByTimeAsync(1_000);
        drawdy.failing.clear();
        await markers.stop();
        const last = drawdy.of("command:scene:delete-drawdy-preview-elements").at(-1)!;
        expect([...(last.req!.previewIds as string[])].sort()).toEqual(["pv1", "pv2"]);
    });

    it("never draws a walker who left or went quiet before its first tick", async () => {
        markers.show(walker("v1", 0, 0));
        markers.leave("v1");
        markers.show(walker("v2", 0, 0));
        vi.setSystemTime(Date.now() + WALKER_TTL_MS + 1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(drawdy.requests).toEqual([]);
    });

    it("removes a walker who left, and every walker when it stops", async () => {
        markers.show(walker("v1", 0, 0));
        markers.show(walker("v2", 50, 50, "Ming"));
        await vi.advanceTimersByTimeAsync(0);
        markers.leave("v1");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements").map((r) => r.req!.previewIds)).toEqual([
            ["pv1"],
        ]);
        await markers.stop();
        expect(drawdy.of("command:scene:delete-drawdy-preview-elements").map((r) => r.req!.previewIds)).toEqual([
            ["pv1"],
            ["pv2"],
        ]);
    });
});
