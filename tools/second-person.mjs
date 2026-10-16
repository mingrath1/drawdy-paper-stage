/**
 * A synthetic second person on a deployed Paper Stage. It joins as a view, walks a slow circle at POSE_HZ, and logs
 * every cursor list the stage relays to views, one JSON line each.
 *
 *   node tools/second-person.mjs <stageId> <token> [--seconds 60] [--center x,y] [--radius 60] [--period 12]
 *
 * The stageId and token are the stage frame's `meta.paperStage`. The center and radius are canvas units; the center
 * defaults to the pawn, or the frame's center when the stage has none.
 */
import { parseArgs } from "node:util";
import { BACKEND_URL } from "../src/config.ts";
import { POSE_HZ, PROTOCOL_VERSION, parseServerMessage, stageSocketUrl } from "../shared/protocol.ts";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        seconds: { type: "string", default: "60" },
        center: { type: "string" },
        radius: { type: "string", default: "60" },
        period: { type: "string", default: "12" },
    },
});
const [stageId, token] = positionals;
if (!stageId || !token) {
    console.error("usage: node tools/second-person.mjs <stageId> <token> [--seconds 60] [--center x,y] [--radius 60]");
    process.exit(2);
}

const participant = { presenceId: "synthetic-b", name: "Nok (test)", color: "#a855f7" };
const radius = Number(values.radius);
const period = Number(values.period);
const startedAt = Date.now();
const seen = { cursorLists: 0, names: new Set() };
let walker = null;

const log = (event, fields = {}) =>
    console.log(JSON.stringify({ t: Number(((Date.now() - startedAt) / 1000).toFixed(2)), event, ...fields }));

function centerOf(snapshot) {
    if (values.center) {
        const [x, y] = values.center.split(",").map(Number);
        return { x, y };
    }
    const pawn = snapshot.items.find((item) => item.kind === "pawn");
    if (pawn) return { x: pawn.x, y: pawn.y };
    const { x, y, width, height } = snapshot.frame;
    return { x: x + width / 2, y: y + height / 2 };
}

/** Facing is (sin heading, cos heading), so a walker going counterclockwise round the circle faces -angle. */
function poseAt(center, seconds) {
    const angle = (seconds / period) * 2 * Math.PI;
    let heading = Math.atan2(-Math.sin(angle), Math.cos(angle));
    if (heading <= -Math.PI) heading += 2 * Math.PI;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle), heading, pitch: 0 };
}

const socket = new WebSocket(stageSocketUrl(BACKEND_URL, stageId));

socket.onopen = () =>
    socket.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, stageId, token, role: "view", participant }));

socket.onmessage = (event) => {
    const message = parseServerMessage(String(event.data));
    switch (message.type) {
        case "welcome": {
            const center = centerOf(message.snapshot);
            log("welcome", { connectionId: message.connectionId, items: message.snapshot.items.length, center, radius });
            const walkStart = Date.now();
            walker = setInterval(() => {
                const pose = poseAt(center, (Date.now() - walkStart) / 1000);
                socket.send(JSON.stringify({ type: "pose", pose }));
            }, 1000 / POSE_HZ);
            return;
        }
        case "cursors":
            seen.cursorLists++;
            for (const cursor of message.cursors) seen.names.add(cursor.name);
            log("cursors", {
                cursors: message.cursors.map(({ presenceId, name, x, y }) => ({
                    presenceId,
                    name,
                    x: Math.round(x),
                    y: Math.round(y),
                })),
            });
            return;
        case "error":
            log("error", { code: message.code, message: message.message });
            return;
        default:
            return;
    }
};

socket.onclose = (event) => {
    clearInterval(walker);
    log("closed", { code: event.code, reason: event.reason });
    log("summary", { cursorLists: seen.cursorLists, names: [...seen.names] });
    process.exit(0);
};

function stop() {
    clearInterval(walker);
    socket.close(1000, "synthetic person left");
}

setTimeout(stop, Number(values.seconds) * 1000);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
