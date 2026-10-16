import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CLOSE, type ServerMessage } from "../../shared/protocol.ts";
import {
  type Client,
  commit,
  connect,
  freshStage,
  hello,
  join,
  TOKEN,
  wall,
  writerOf,
} from "./stage-client.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pings every 5 s like a live driver, and returns the first frame of `type` it receives. */
async function pingUntil<T extends ServerMessage["type"]>(
  client: Client,
  type: T,
  timeoutMs: number,
): Promise<Extract<ServerMessage, { type: T }>> {
  const pinger = setInterval(() => client.send({ type: "ping", t: 0 }), 5_000);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await client.next(deadline - Date.now());
      if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
  } finally {
    clearInterval(pinger);
  }
}

describe("socket caps", () => {
  it("refuses a socket past 64 on one stage with a retryable close", async () => {
    const stageId = freshStage();
    const sockets = await Promise.all(Array.from({ length: 64 }, () => connect(stageId)));
    const extra = await connect(stageId);
    expect(await extra.closed).toEqual({ code: CLOSE.full, reason: "the stage is full" });

    sockets[0]!.close();
    await sockets[0]!.closed;
    const next = await connect(stageId);
    next.send(hello(stageId, "driver"));
    await next.expect("welcome");
  });

  it("refuses a ninth socket from one person with a retryable close", async () => {
    const stageId = freshStage();
    await writerOf(stageId);
    for (let index = 0; index < 8; index++) await join(stageId, "view", "same");
    const ninth = await connect(stageId);
    ninth.send(hello(stageId, "view", TOKEN, "same"));
    expect(await ninth.expect("error")).toMatchObject({ code: "limit" });
    expect((await ninth.closed).code).toBe(CLOSE.full);
    await join(stageId, "view", "other");
  });

  it("admits only one of two hellos racing for a person's last slot", async () => {
    const stageId = freshStage();
    await writerOf(stageId);
    for (let index = 0; index < 7; index++) await join(stageId, "view", "same");
    const racers = await Promise.all([connect(stageId), connect(stageId)]);
    for (const racer of racers) racer.send(hello(stageId, "view", TOKEN, "same"));
    const firsts = await Promise.all(racers.map(async (racer) => (await racer.next()).type));
    expect(firsts.sort()).toEqual(["error", "welcome"]);
  });
});

describe.concurrent("liveness", () => {
  it("closes a socket that sends no hello within 10 s", { timeout: 20_000 }, async () => {
    const stageId = freshStage();
    const { client: writer } = await writerOf(stageId);
    const silent = await connect(stageId);
    const connectedAt = Date.now();
    expect((await silent.closed).code).toBe(CLOSE.policy);
    expect(Date.now() - connectedAt).toBeGreaterThanOrEqual(9_500);
    await writer.expectQuiet();
  });

  it(
    "hands the seat from a writer silent for 30 s to a driver still pinging",
    { timeout: 45_000 },
    async () => {
      const stageId = freshStage();
      const zombie = await writerOf(stageId);
      const awake = await join(stageId, "driver", "awake");
      const { client: view } = await join(stageId, "view");
      const startedAt = Date.now();

      const { writer } = await pingUntil(awake.client, "writer", 40_000);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(29_000);
      expect(writer).toEqual({ connectionId: awake.welcome.connectionId, epoch: zombie.epoch + 1 });
      expect((await view.expect("writer")).writer).toEqual(writer);

      zombie.client.send(commit(zombie.epoch, "late", { upserts: [wall("a")] }));
      expect((await zombie.client.expect("writer")).writer).toEqual(writer);
      expect(await zombie.client.expect("ack")).toMatchObject({ ok: false, error: "not_writer" });
      awake.client.send(commit(writer.epoch, "fresh", { upserts: [wall("a")] }));
      expect(await awake.client.expect("ack")).toMatchObject({ ok: true, revision: 1 });
    },
  );

  it(
    "re-runs the election on a refused commit before the sweep runs",
    { timeout: 45_000 },
    async () => {
      const { zombie, awake } = await silentWriterWithoutSweep();
      awake.client.send(commit(zombie.epoch, "early", { upserts: [wall("a")] }));
      expect(await awake.client.expect("ack")).toMatchObject({ ok: false, error: "not_writer" });
      const { writer } = await awake.client.expect("writer");
      expect(writer).toEqual({ connectionId: awake.welcome.connectionId, epoch: zombie.epoch + 1 });
    },
  );

  it(
    "re-runs the election on a driver hello before the sweep runs",
    { timeout: 45_000 },
    async () => {
      const { stageId, zombie, awake } = await silentWriterWithoutSweep();
      const late = await join(stageId, "driver", "late");
      expect(late.welcome.writer).toEqual({
        connectionId: zombie.connectionId,
        epoch: zombie.epoch,
      });
      const { writer } = await awake.client.expect("writer");
      expect(writer).toEqual({ connectionId: awake.welcome.connectionId, epoch: zombie.epoch + 1 });
    },
  );
});

/** A stage whose writer has been silent for 31 s while another driver pinged, with the alarm sweep switched off. */
async function silentWriterWithoutSweep() {
  const stageId = freshStage();
  const zombie = await writerOf(stageId);
  const awake = await join(stageId, "driver", "awake");
  const pinger = setInterval(() => awake.client.send({ type: "ping", t: 0 }), 5_000);
  try {
    await sleep(25_000);
    await runInDurableObject(env.STAGES.getByName(stageId), (_instance, state) =>
      state.storage.deleteAlarm(),
    );
    await sleep(6_000);
  } finally {
    clearInterval(pinger);
  }
  for (;;) {
    const message = await awake.client.next(200).catch(() => undefined);
    if (message === undefined) break;
    expect(message.type).toBe("pong");
  }
  return { stageId, zombie, awake };
}
