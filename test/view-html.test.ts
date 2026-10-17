import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ViewBoot } from "../shared/protocol";
import { buildViewHtml } from "../src/view-html";
// @ts-expect-error The build script is plain JavaScript with no declarations.
import { renderViewModule } from "../scripts/build-view.mjs";

const hostile: ViewBoot = {
    backendUrl: "https://paper-stage.example.workers.dev",
    stageId: "stage-1",
    token: "t&<>\u2028",
    participant: { presenceId: "p1", name: "</script><script>alert(1)</script><!--", color: "#a855f7" },
};

describe("view html", () => {
    it("carries the boot through any name or token without breaking out of its script", () => {
        const html = buildViewHtml(hostile);
        expect(html).not.toContain("alert(1)</script>");
        const embedded = /<script id="boot" type="application\/json">([^<]*)<\/script>/.exec(html);
        expect(embedded).not.toBeNull();
        expect(JSON.parse(embedded![1])).toEqual(hostile);
    });

    it("is one complete document with its script inline", () => {
        const html = buildViewHtml(hostile);
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html.trimEnd().endsWith("</html>")).toBe(true);
        expect(html).not.toMatch(/<script[^>]+src=/);
    });

    it("is committed fresh from view/", async () => {
        const fresh =
            readFileSync(new URL("../src/view-html.ts", import.meta.url), "utf8") === (await renderViewModule());
        expect(fresh, "src/view-html.ts is stale, run npm run build:view").toBe(true);
    });
});
