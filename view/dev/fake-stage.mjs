// A local stand-in for the Stage object, speaking the part of protocol v2 the 3D view uses.
// Stages: "demo" is a two-room plan with three cutouts, a walker circling, and a hand dragging the cart.
// "perf" is 40 walls and 30 cutouts with the same walker and hand. "uninit" closes with 4409, any other token 4401.
// GET /api/stages/<id>/dev/<action> changes a live stage: "reset" resizes the frame from the left, drops the tree, and
// stands a wall on the first viewer; "redraw" gives the star a new picture; "writer" elects a new writer.
// Usage: node view/dev/fake-stage.mjs [--port 8787]

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { DOODLE_KINDS, doodle } from "./png.mjs";

export const DEV_TOKEN = "dev-token";
const TICK_MS = 50;

const wallH = (id, x0, x1, y) => ({
    kind: "wall",
    id,
    shape: "rect",
    rotation: 0,
    rect: { x: x0, y: y - 6, width: x1 - x0, height: 12 },
});
const wallV = (id, x, y0, y1) => ({
    kind: "wall",
    id,
    shape: "rect",
    rotation: 0,
    rect: { x: x - 6, y: y0, width: 12, height: y1 - y0 },
});

function cutout(id, picture, x, y) {
    return {
        kind: "cutout",
        id,
        rect: { x, y, width: picture.width, height: picture.height },
        asset: { hash: picture.hash, width: picture.width, height: picture.height },
    };
}

function demoStage(assets) {
    const tree = doodle("tree", 120);
    const star = doodle("star", 48);
    const cart = doodle("cart", 200);
    for (const picture of [tree, star, cart]) assets.set(picture.hash, picture.png);
    const items = [
        wallH("top", 100, 1100, 150),
        wallH("bottom-left", 100, 300, 650),
        wallH("bottom-right", 400, 1100, 650),
        wallV("left", 100, 150, 650),
        wallV("middle-top", 600, 150, 350),
        wallV("middle-bottom", 600, 450, 650),
        wallV("right", 1100, 150, 650),
        { kind: "wall", id: "pillar", shape: "circle", rotation: 0, rect: { x: 1000, y: 190, width: 70, height: 70 } },
        {
            kind: "wall",
            id: "planter",
            shape: "diamond",
            rotation: 0,
            rect: { x: 980, y: 520, width: 100, height: 100 },
            color: "#2f855a",
        },
        {
            kind: "wall",
            id: "screen",
            shape: "rect",
            rotation: 0.6,
            rect: { x: 640, y: 580, width: 140, height: 12 },
            color: "#6b46c1",
        },
        cutout("tree", tree, 110, 300),
        cutout("star", star, 760, 170),
        cutout("cart", cart, 210, 150),
        { kind: "pawn", id: "pawn", x: 350, y: 560 },
    ];
    return {
        frame: { x: 0, y: 0, width: 1200, height: 800 },
        items,
        drag: { id: "cart", from: { x: 210, y: 150 }, to: { x: 400, y: 150 } },
        walkerOrbit: { x: 860, y: 440, r: 110 },
    };
}

function perfStage(assets) {
    const frame = { x: 0, y: 0, width: 2400, height: 1600 };
    const items = [];
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 4; col++) {
            const x0 = 100 + col * 560;
            items.push(wallH(`h${row}-${col}`, x0, x0 + 220, 100 + row * 350));
        }
    }
    for (let col = 0; col < 5; col++) {
        for (let row = 0; row < 3; row++) {
            const y0 = 100 + row * 470;
            items.push(wallV(`v${col}-${row}`, 100 + col * 560, y0, y0 + 200));
        }
    }
    const shapes = ["circle", "diamond"];
    for (let i = 0; i < 5; i++) {
        items.push({
            kind: "wall",
            id: `post${i}`,
            shape: shapes[i % 2],
            rotation: i * 0.3,
            rect: { x: 360 + i * 400, y: 800, width: 90, height: 90 },
        });
    }
    for (let i = 0; i < 30; i++) {
        const picture = doodle(DOODLE_KINDS[i % DOODLE_KINDS.length], (i * 37) % 360);
        assets.set(picture.hash, picture.png);
        items.push(cutout(`c${i}`, picture, 180 + (i % 6) * 370, 180 + Math.floor(i / 6) * 290));
    }
    items.push({ kind: "pawn", id: "pawn", x: 1200, y: 1500 });
    return {
        frame,
        items,
        drag: { id: "c0", from: { x: 180, y: 180 }, to: { x: 420, y: 330 } },
        walkerOrbit: { x: 1200, y: 800, r: 300 },
    };
}

const SCENARIOS = { demo: demoStage, perf: perfStage };

const MALI = { presenceId: "fake-mali", name: "Mali", color: "#0ea5e9" };
const NOK = { presenceId: "fake-nok", name: "Nok", color: "#a855f7" };

class FakeStage {
    constructor(build) {
        this.assets = new Map();
        const built = build(this.assets);
        this.frame = built.frame;
        this.items = new Map(built.items.map((item) => [item.id, item]));
        this.drag = built.drag;
        this.orbit = built.walkerOrbit;
        this.revision = 1;
        this.epoch = 1;
        this.views = new Map();
        this.started = Date.now();
    }

    welcome(connectionId) {
        return {
            type: "welcome",
            v: 2,
            connectionId,
            writer: { connectionId: null, epoch: 0 },
            snapshot: { revision: this.revision, frame: this.frame, items: [...this.items.values()] },
            walkers: [
                this.fakeWalker(),
                ...[...this.views.values()].filter((view) => view.walker).map((view) => view.walker),
            ],
        };
    }

    broadcast(message, except) {
        const text = JSON.stringify(message);
        for (const [id, view] of this.views) if (id !== except) view.socket.send(text);
    }

    fakeWalker() {
        const t = ((Date.now() - this.started) / 12_000) * Math.PI * 2;
        const { x, y, r } = this.orbit;
        return {
            connectionId: "fake-walker",
            participant: MALI,
            pose: { x: x + r * Math.sin(t), y: y + r * Math.cos(t), heading: normalize(t + Math.PI / 2), pitch: 0 },
        };
    }

    patch(change) {
        this.broadcast({ type: "scene.patch", revision: ++this.revision, removes: [], ...change });
    }

    act(action) {
        if (action === "reset") {
            const viewer = [...this.views.values()].find((view) => view.walker)?.walker.pose;
            this.frame = { ...this.frame, x: this.frame.x + 100, width: this.frame.width - 100 };
            this.items.delete("tree");
            if (viewer) this.items.set("dropped", wallV("dropped", viewer.x, viewer.y - 150, viewer.y + 150));
            this.patch({ reset: true, frame: this.frame, upserts: [...this.items.values()] });
        } else if (action === "redraw") {
            const star = this.items.get("star");
            const picture = doodle("star", (this.revision * 67) % 360);
            this.assets.set(picture.hash, picture.png);
            const asset = { hash: picture.hash, width: picture.width, height: picture.height };
            this.items.set("star", { ...star, asset });
            this.patch({ upserts: [this.items.get("star")] });
        } else if (action === "writer") {
            this.broadcast({ type: "writer", writer: { connectionId: "fake-writer", epoch: ++this.epoch } });
        } else return false;
        return true;
    }

    /** One 16 second loop: reach in, drag the cutout one way, leave the frame; then the same back. */
    tick() {
        if (this.views.size === 0) return;
        this.broadcast({ type: "walker", walker: this.fakeWalker() });
        const elapsed = (Date.now() - this.started) % 16_000;
        const backwards = elapsed >= 8_000;
        const local = elapsed % 8_000;
        const from = backwards ? this.drag.to : this.drag.from;
        const to = backwards ? this.drag.from : this.drag.to;
        const item = this.items.get(this.drag.id);
        const grip = (spot) => ({ x: spot.x + item.rect.width / 2, y: spot.y + item.rect.height / 2 });
        const outside = { x: -150, y: grip(from).y };
        let hand;
        if (local < 1_500) hand = lerp(outside, grip(from), ease(local / 1_500));
        else if (local < 5_000) {
            const spot = lerp(from, to, ease((local - 1_500) / 3_500));
            hand = grip(spot);
            this.items.set(item.id, { ...item, rect: { ...item.rect, x: spot.x, y: spot.y } });
            this.broadcast({
                type: "scene.patch",
                revision: ++this.revision,
                upserts: [this.items.get(item.id)],
                removes: [],
            });
        } else if (local < 6_000) hand = grip(to);
        else hand = lerp(grip(to), { x: -150, y: grip(to).y }, ease(Math.min(1, (local - 6_000) / 1_500)));
        this.broadcast({ type: "cursors", cursors: [{ ...NOK, ...hand }] });
    }
}

function lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function normalize(heading) {
    return Math.atan2(Math.sin(heading), Math.cos(heading));
}

export function startFakeStage({ port = 8787 } = {}) {
    const stages = new Map();
    const stageFor = (id) => {
        const scenario = SCENARIOS[id.split("-")[0]];
        if (!scenario) return null;
        if (!stages.has(id)) stages.set(id, new FakeStage(scenario));
        return stages.get(id);
    };

    const server = createServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        const headers = { "access-control-allow-origin": "*" };
        const dev = /^\/api\/stages\/([^/]+)\/dev\/([a-z]+)$/.exec(url.pathname);
        if (dev) {
            const done = stageFor(decodeURIComponent(dev[1]))?.act(dev[2]);
            return response.writeHead(done ? 200 : 404, headers).end(done ? "ok" : "no such stage or action");
        }
        const match = /^\/api\/stages\/([^/]+)\/assets\/([0-9a-f]{64})$/.exec(url.pathname);
        if (!match) return response.writeHead(404, headers).end();
        if (url.searchParams.get("token") !== DEV_TOKEN) return response.writeHead(401, headers).end();
        const png = stageFor(decodeURIComponent(match[1]))?.assets.get(match[2]);
        if (!png) return response.writeHead(404, headers).end();
        response
            .writeHead(200, {
                ...headers,
                "content-type": "image/png",
                "cache-control": "public, max-age=31536000, immutable",
            })
            .end(png);
    });

    const sockets = new WebSocketServer({ server });
    let nextConnection = 1;
    sockets.on("connection", (socket, request) => {
        const stageId = decodeURIComponent(new URL(request.url, "http://localhost").pathname.split("/").pop());
        const connectionId = `view-${nextConnection++}`;
        let stage = null;
        socket.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(String(data));
            } catch {
                return socket.close(1002);
            }
            if (message.type === "hello") {
                if (message.v !== 2) return socket.close(4426);
                if (stageId.startsWith("uninit")) return socket.close(4409);
                if (message.token !== DEV_TOKEN) return socket.close(4401);
                stage = stageFor(stageId);
                if (!stage) return socket.close(4409);
                socket.send(JSON.stringify(stage.welcome(connectionId)));
                stage.views.set(connectionId, { socket, participant: message.participant, walker: null });
                return;
            }
            if (!stage) return socket.close(1002);
            if (message.type === "ping") socket.send(JSON.stringify({ type: "pong", t: message.t }));
            if (message.type === "pose") {
                const view = stage.views.get(connectionId);
                view.walker = { connectionId, participant: view.participant, pose: message.pose };
                stage.broadcast({ type: "walker", walker: view.walker }, connectionId);
            }
        });
        socket.on("close", () => {
            if (!stage?.views.delete(connectionId)) return;
            stage.broadcast({ type: "walker.left", connectionId });
        });
    });

    const timer = setInterval(() => stages.forEach((stage) => stage.tick()), TICK_MS);
    server.on("close", () => clearInterval(timer));
    return new Promise((resolve) => server.listen(port, "localhost", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8787;
    await startFakeStage({ port });
    console.log(`fake stage on ws://localhost:${port}/api/stages/demo`);
}
