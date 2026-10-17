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

function fakeDrawdy(answer: (request: DriverCommandRequest) => Answer) {
    const requests: DriverCommandRequest[] = [];
    const issue = ((request: DriverCommandRequest) => {
        requests.push(request);
        const result = answer(request);
        if (result === "hang") return new Promise(() => {});
        return Promise.resolve({ ...request, res: result });
    }) as unknown as DriverCommandIssuer;
    return { issue, requests };
}

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
        expect(drawdy.requests.map((request) => request.type)).toEqual(["command:dom:window-size"]);
    });
});
