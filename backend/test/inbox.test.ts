import { describe, expect, it } from "vitest";
import type { ClientMessage } from "../../shared/protocol.ts";
import { Inbox, MAX_PENDING_FRAMES } from "../src/inbox.ts";

const admitted = (
  inbox: Inbox,
  type: ClientMessage["type"],
  writer: boolean,
  count: number,
  now: number,
) => Array.from({ length: count }, () => inbox.admit(type, writer, now)).filter(Boolean).length;

describe("Inbox", () => {
  it("lets the writer burst 150 frames and every other socket 60, refilled at that rate", () => {
    const writer = new Inbox();
    expect(admitted(writer, "asset.put", true, 200, 1_000)).toBe(150);
    expect(admitted(writer, "asset.put", true, 200, 1_100)).toBe(15);

    const view = new Inbox();
    expect(admitted(view, "ping", false, 200, 1_000)).toBe(60);
    expect(admitted(view, "ping", false, 200, 1_500)).toBe(30);
  });

  it("starts a driver elected writer on the writer's full burst", () => {
    const inbox = new Inbox();
    expect(admitted(inbox, "ping", false, 60, 1_000)).toBe(60);
    expect(admitted(inbox, "asset.put", true, 200, 1_000)).toBe(150);
  });

  it("holds poses and cursor lists to their own rate", () => {
    const inbox = new Inbox();
    expect(admitted(inbox, "pose", false, 20, 1_000)).toBe(5);
    expect(admitted(inbox, "pose", false, 20, 1_050)).toBe(1);
    expect(admitted(inbox, "cursors", true, 20, 1_000)).toBe(5);
  });

  it("warns at most once a second", () => {
    const inbox = new Inbox();
    expect([1_000, 1_500, 1_999, 2_000].map((now) => inbox.warn(now))).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it(`is full while ${MAX_PENDING_FRAMES} frames are pending and frees a slot as one settles`, async () => {
    const inbox = new Inbox();
    const settle: Array<() => void> = [];
    const held = Array.from({ length: MAX_PENDING_FRAMES }, () =>
      inbox.hold(() => new Promise<void>((resolve) => settle.push(resolve))),
    );
    expect(inbox.full).toBe(true);
    settle[0]!();
    await held[0];
    expect(inbox.full).toBe(false);
    for (const resolve of settle) resolve();
    await Promise.all(held);
  });
});
