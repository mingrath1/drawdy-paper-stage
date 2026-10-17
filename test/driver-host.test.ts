import type { DriverCommandIssuer, DriverCommandRequest, ModuleStyling } from "@drawdy/driver-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, Host } from "../src/host";

const styling = {
    foreground: "#111111",
    mutedForeground: "#555555",
    surface: "#ffffff",
    border: "#dddddd",
    surface2: "#eeeeee",
} as ModuleStyling;

type Answer = { value: unknown } | { error: { type: string; message?: string } } | "hang";

function fakeDrawdy(answer: (request: DriverCommandRequest) => Answer, delayMs = (_: DriverCommandRequest) => 0) {
    const requests: DriverCommandRequest[] = [];
    const issue = ((request: DriverCommandRequest) => {
        requests.push(request);
        const result = answer(request);
        if (result === "hang") return new Promise(() => {});
        const response = { ...request, res: result };
        const ms = delayMs(request);
        return ms > 0 ? new Promise((resolve) => setTimeout(() => resolve(response), ms)) : Promise.resolve(response);
    }) as unknown as DriverCommandIssuer;
    return { issue, requests };
}

const types = (requests: DriverCommandRequest[]) => requests.map((request) => request.type);

describe("Host", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("returns the value of a command and fills in the envelope", async () => {
        const drawdy = fakeDrawdy(() => ({ value: { x: 1, y: 2, zoom: 1 } }));
        const host = new Host(drawdy.issue, "mingrath.paper-stage", styling);
        await expect(host.run("command:camera:get-info")).resolves.toEqual({
            ok: true,
            value: { x: 1, y: 2, zoom: 1 },
        });
        expect(drawdy.requests[0]).toEqual({
            type: "command:camera:get-info",
            driverId: "mingrath.paper-stage",
            requestId: "ps-1",
        });
    });

    it(`gives up on a silent command after ${COMMAND_TIMEOUT_MS / 1000} s once its permission is decided`, async () => {
        let hang = false;
        const drawdy = fakeDrawdy((request) =>
            hang && request.type === "command:scene:capture-screenshot" ? "hang" : { value: {} },
        );
        const host = new Host(drawdy.issue, "d", styling);
        await host.call("command:scene:get-drawdy-elements", { properties: [] });
        hang = true;
        const pending = host.call("command:scene:capture-screenshot", { area: { x: 0, y: 0, width: 1, height: 1 } });
        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
        await expect(pending).resolves.toMatchObject({ ok: false, error: "timeout" });
    });

    it("waits longer for the first command of a permission, which may sit behind a prompt", async () => {
        const drawdy = fakeDrawdy(() => "hang");
        const host = new Host(drawdy.issue, "d", styling);
        let settled = false;
        void host.call("command:scene:get-drawdy-elements", { properties: [] }).then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS * 3);
        expect(settled).toBe(false);
    });

    it("turns a denied scene permission into a floating hint built from px dimensions", async () => {
        const drawdy = fakeDrawdy((request) =>
            request.type === "command:scene:add-drawdy-elements"
                ? { error: { type: "unauthorized" } }
                : request.type === "command:dom:window-size"
                  ? { value: { width: 1200, height: 800 } }
                  : { value: { created: true } },
        );
        const host = new Host(drawdy.issue, "d", styling);
        await expect(host.run("command:scene:add-drawdy-elements", { elements: [] })).resolves.toMatchObject({
            ok: false,
            error: "unauthorized",
        });
        const hint = drawdy.requests.find((request) => request.type === "command:dom:upsert-floating-element");
        expect(hint).toBeDefined();
        const json = JSON.stringify(hint);
        expect(json).toContain("Permission needed");
        expect(json).toContain('"width":[360,"px"]');
        expect(json).not.toMatch(/"(width|height|padding|fontSize|borderRadius|borderWidth)":\d/);
    });

    it("shows no hint for a denied dom permission, since a hint needs it too", async () => {
        const drawdy = fakeDrawdy(() => ({ error: { type: "unauthorized" } }));
        const host = new Host(drawdy.issue, "d", styling);
        await host.run("command:dom:window-size");
        expect(types(drawdy.requests)).toEqual(["command:dom:window-size"]);
    });

    it("sends nothing once stopped, not even a hint that was waiting on the window size", async () => {
        const drawdy = fakeDrawdy(
            () => ({ value: { width: 1200, height: 800 } }),
            (request) => (request.type === "command:dom:window-size" ? 1_000 : 0),
        );
        const host = new Host(drawdy.issue, "d", styling);
        const hint = host.hint("Connecting to the stage", ["The 3D view opens soon."]);
        await vi.advanceTimersByTimeAsync(0);
        await host.stop();
        await vi.advanceTimersByTimeAsync(30_000);
        await hint;
        expect(types(drawdy.requests)).toEqual(["command:dom:window-size"]);
    });

    it("neither reports nor hints a failure Drawdy answers after it stopped", async () => {
        const drawdy = fakeDrawdy(
            (request) =>
                request.type === "command:scene:add-drawdy-elements"
                    ? { error: { type: "unauthorized" } }
                    : { value: { width: 1200, height: 800 } },
            (request) => (request.type === "command:scene:add-drawdy-elements" ? 1_000 : 0),
        );
        const host = new Host(drawdy.issue, "d", styling);
        const added = host.run("command:scene:add-drawdy-elements", { elements: [] });
        await vi.advanceTimersByTimeAsync(0);
        await host.stop();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(added).resolves.toMatchObject({ ok: false, error: "stopped" });
        expect(types(drawdy.requests)).toEqual(["command:scene:add-drawdy-elements"]);
    });

    it("takes down the floating elements and previews it put up when it stops, and nothing else", async () => {
        let previews = 0;
        const drawdy = fakeDrawdy((request) =>
            request.type === "command:scene:create-drawdy-preview-elements"
                ? { value: { previewed: 1, previewId: `pv${++previews}` } }
                : { value: {} },
        );
        const host = new Host(drawdy.issue, "d", styling);
        const floating = (domId: string) =>
            host.call("command:dom:upsert-floating-element", {
                domId,
                position: { x: 0, y: 0 },
                schema: { type: "column" } as never,
            });
        await floating("view");
        await floating("note");
        await host.call("command:dom:remove-floating-element", { domId: "note" });
        await host.call("command:scene:create-drawdy-preview-elements", { elements: [] });
        await host.call("command:scene:create-drawdy-preview-elements", { elements: [] });
        await host.call("command:scene:delete-drawdy-preview-elements", { previewIds: ["pv1"] });
        const before = drawdy.requests.length;
        await host.stop();
        expect(drawdy.requests.slice(before)).toMatchObject([
            { type: "command:dom:remove-floating-element", req: { domId: "view" } },
            { type: "command:scene:delete-drawdy-preview-elements", req: { previewIds: ["pv2"] } },
        ]);
        await host.stop();
        await host.call("command:dom:window-size");
        expect(drawdy.requests).toHaveLength(before + 2);
    });

    it("sends nothing until the previous instance has finished stopping", async () => {
        const drawdy = fakeDrawdy(() => ({ value: {} }));
        let finish = () => {};
        const previous = new Promise<void>((resolve) => (finish = resolve));
        const host = new Host(drawdy.issue, "d", styling, previous);
        const created = host.call("command:dom:create-action-button", { domElementId: "b", svg: "" });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(drawdy.requests).toEqual([]);
        finish();
        await expect(created).resolves.toMatchObject({ ok: true });
        expect(types(drawdy.requests)).toEqual(["command:dom:create-action-button"]);
    });
});
