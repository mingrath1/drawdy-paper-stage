// Pose latency through a deployed Stage: a view sends poses, a driver on the same stage timestamps each walker frame.
// Usage: node tools/latency.mjs https://<worker-host> [poses=500] [hz=20]
import { parseServerMessage, PROTOCOL_VERSION, stageSocketUrl } from "../../shared/protocol.ts";

const [backendUrl, poses = "500", hz = "20"] = process.argv.slice(2);
if (backendUrl === undefined) {
  console.error("usage: node tools/latency.mjs https://<worker-host> [poses] [hz]");
  process.exit(2);
}
const count = Number(poses);
const intervalMs = 1000 / Number(hz);
const stageId = `latency-${crypto.randomUUID()}`;
const token = crypto.randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function join(role) {
  const socket = new WebSocket(stageSocketUrl(backendUrl, stageId));
  const listeners = new Set();
  socket.addEventListener("message", (event) => {
    const message = parseServerMessage(event.data);
    for (const listener of listeners) listener(message);
  });
  const welcomed = new Promise((resolve, reject) => {
    const onWelcome = (message) => {
      if (message.type !== "welcome") return;
      listeners.delete(onWelcome);
      resolve();
    };
    listeners.add(onWelcome);
    socket.addEventListener("close", (event) => reject(new Error(`${role} closed ${event.code}`)));
  });
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        v: PROTOCOL_VERSION,
        stageId,
        token,
        role,
        participant: { presenceId: `latency-${role}`, name: role, color: "#888888" },
      }),
    ),
  );
  return welcomed.then(() => ({
    send: (message) => socket.send(JSON.stringify(message)),
    listen: (listener) => listeners.add(listener),
    close: () => socket.close(1000, "done"),
  }));
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const summarize = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const round = (value) => Math.round(value * 10) / 10;
  return {
    n: sorted.length,
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
};

const driver = await join("driver");
const view = await join("view");

const pingSent = new Map();
const pingRtts = [];
view.listen((message) => {
  if (message.type === "pong" && pingSent.has(message.t))
    pingRtts.push(performance.now() - pingSent.get(message.t));
});
for (let index = 0; index < 20; index++) {
  pingSent.set(index, performance.now());
  view.send({ type: "ping", t: index });
  await sleep(intervalMs);
}

const sentAt = new Array(count);
const latencies = [];
driver.listen((message) => {
  if (message.type !== "walker") return;
  const sequence = message.walker.pose.x;
  latencies.push(performance.now() - sentAt[sequence]);
});

const start = performance.now();
for (let sequence = 0; sequence < count; sequence++) {
  await sleep(start + sequence * intervalMs - performance.now());
  sentAt[sequence] = performance.now();
  view.send({ type: "pose", pose: { x: sequence, y: 0, heading: 0, pitch: 0 } });
}
await sleep(2_000);
driver.close();
view.close();

console.log(
  JSON.stringify({
    stageId,
    sent: count,
    received: latencies.length,
    sendSeconds: Math.round((sentAt.at(-1) - start) / 100) / 10,
    poseMs: summarize(latencies),
    pingRttMs: summarize(pingRtts),
  }),
);
