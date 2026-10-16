import { describe, expect, it } from "vitest";
import { CLOSE } from "../../shared/protocol.ts";
import { connect, freshStage, hello, join, TOKEN, writerOf } from "./stage-client.ts";

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
});
