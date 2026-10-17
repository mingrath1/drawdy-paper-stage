// Serves the built 3D view against the fake stage for development.
// http://localhost:5180/?stage=demo embeds the view the way Drawdy does, in a sandboxed allow-scripts iframe.
// http://localhost:5180/bare?stage=perf serves the view document itself, which scripts can measure directly.
// Query: stage (demo, perf, uninit; a suffix such as demo-2 makes a fresh stage), name, color, me, token.
// Usage: node view/dev/serve.mjs [--port 5180] [--stage-port 8787]

import { statSync } from "node:fs";
import { createServer } from "node:http";
import { DEV_TOKEN, startFakeStage } from "./fake-stage.mjs";

const option = (name, fallback) => Number(process.argv[process.argv.indexOf(name) + 1]) || fallback;
const port = option("--port", 5180);
const stagePort = option("--stage-port", 8787);
const viewModule = new URL("../../src/view-html.ts", import.meta.url);

/** Imports the generated module again whenever build:view rewrites it. */
async function buildViewHtml(boot) {
    const { buildViewHtml } = await import(`${viewModule.href}?t=${statSync(viewModule).mtimeMs}`);
    return buildViewHtml(boot);
}

function bootFrom(url) {
    const query = url.searchParams;
    return {
        backendUrl: `http://localhost:${stagePort}`,
        stageId: query.get("stage") ?? "demo",
        token: query.get("token") ?? DEV_TOKEN,
        participant: {
            presenceId: query.get("me") ?? `dev-${Math.random().toString(36).slice(2, 8)}`,
            name: query.get("name") ?? "You",
            color: query.get("color") ?? "#f97316",
        },
    };
}

const attribute = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

function framed(html, stageId) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Paper Stage view, ${stageId}</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#f7f5f0;font:13px system-ui}
iframe{width:80vw;height:80vh;border:0;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
nav{position:fixed;top:8px;left:12px;color:#666}a{color:#555;margin-right:10px}</style></head>
<body><nav>Paper Stage dev: <a href="/?stage=demo">demo</a><a href="/?stage=perf">perf</a><a href="/?stage=uninit">uninit</a><a href="/?stage=demo&token=wrong">bad token</a></nav>
<iframe sandbox="allow-scripts" srcdoc="${attribute(html)}"></iframe></body></html>`;
}

await startFakeStage({ port: stagePort });
createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/" && url.pathname !== "/bare") return response.writeHead(404).end();
    const boot = bootFrom(url);
    const html = await buildViewHtml(boot);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(url.pathname === "/bare" ? html : framed(html, boot.stageId));
}).listen(port, "localhost", () => {
    console.log(`view: http://localhost:${port}/?stage=demo  fake stage: ws://localhost:${stagePort}`);
});
