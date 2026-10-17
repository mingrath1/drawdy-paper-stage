import type { DomElementSchema } from "@drawdy/driver-protocol";
import { describe, expect, it } from "vitest";
import { otherMode, viewLayout, viewSchema } from "../src/view-window";

const palette = { text: "#111", muted: "#666", surface: "#fff", border: "#ddd", hover: "#eee" };

function texts(schema: DomElementSchema): string[] {
    if (schema.type === "text") return [schema.child as string];
    return ("children" in schema ? (schema.children ?? []) : []).flatMap(texts);
}

describe("viewLayout", () => {
    it("docks the view beside Drawdy's selection panel, below the toolbar, at 44% of the window's width", () => {
        expect(viewLayout({ width: 1200, height: 1289 }, "docked")).toEqual({
            position: { x: 209, y: 64 },
            width: 528,
            height: 1161,
        });
        expect(viewLayout({ width: 1600, height: 900 }, "docked")).toEqual({
            position: { x: 209, y: 64 },
            width: 704,
            height: 772,
        });
    });

    it("keeps the docked view between 420 and 900 px wide", () => {
        expect(viewLayout({ width: 800, height: 700 }, "docked").width).toBe(420);
        expect(viewLayout({ width: 2560, height: 1440 }, "docked").width).toBe(900);
    });

    it("keeps a docked view inside a window narrower than its minimum width", () => {
        const layout = viewLayout({ width: 600, height: 700 }, "docked");
        expect(layout.position.x + layout.width).toBe(600 - 16);
        expect(layout.height).toBe(700 - 128);
    });

    it("gives a window too small for the dock the large layout", () => {
        expect(viewLayout({ width: 400, height: 300 }, "docked")).toEqual(viewLayout({ width: 400, height: 300 }, "large"));
        expect(viewLayout({ width: 800, height: 250 }, "docked")).toEqual(viewLayout({ width: 800, height: 250 }, "large"));
    });

    it("fits every layout inside the window, from tiny to huge, with a view the iframe can fill", () => {
        const sizes = [
            [120, 90], [200, 160], [320, 240], [400, 300], [800, 250], [800, 600], [1024, 600], [1366, 768],
            [1920, 1080], [3840, 2160],
        ];
        for (const [width, height] of sizes)
            for (const mode of ["docked", "large"] as const) {
                const { position, width: w, height: h } = viewLayout({ width, height }, mode);
                const where = `${mode} at ${width}x${height}`;
                expect(position.x, where).toBeGreaterThanOrEqual(0);
                expect(position.y, where).toBeGreaterThanOrEqual(0);
                expect(w, where).toBeGreaterThan(0);
                expect(h, where).toBeGreaterThan(0);
                expect(position.x + w, where).toBeLessThanOrEqual(width);
                expect(position.y + h, where).toBeLessThanOrEqual(height);
                const schema = JSON.stringify(viewSchema("<p>", mode, { position, width: w, height: h }, palette));
                expect(schema, where).not.toMatch(/\[-\d/);
            }
    });

    it("centers the large view over 80% of the window", () => {
        expect(viewLayout({ width: 1200, height: 1289 }, "large")).toEqual({
            position: { x: 120, y: 129 },
            width: 960,
            height: 1031,
        });
        expect(viewLayout({ width: 1300, height: 900 }, "large")).toEqual({
            position: { x: 130, y: 90 },
            width: 1040,
            height: 720,
        });
    });
});

describe("the view's size toggle", () => {
    it("switches between docked and large", () => {
        expect(otherMode("docked")).toBe("large");
        expect(otherMode(otherMode("docked"))).toBe("docked");
    });

    it("offers the mode the view is not in, next to Close", () => {
        const layout = viewLayout({ width: 1200, height: 900 }, "docked");
        expect(texts(viewSchema("<p>", "docked", layout, palette))).toEqual(["Paper Stage", "Expand", "Close"]);
        expect(texts(viewSchema("<p>", "large", layout, palette))).toEqual(["Paper Stage", "Dock", "Close"]);
    });
});
