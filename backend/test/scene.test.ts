import { describe, expect, it } from "vitest";
import type { StageItem } from "../../shared/protocol.ts";
import { applyPatch, planCommit, type SceneCommit, type SceneState } from "../src/scene.ts";

const asset = { hash: "a".repeat(64), width: 10, height: 10 };
const assets = { [asset.hash]: { width: 10, height: 10 } };
const doodle = (meshUrl?: string): StageItem => ({
  kind: "cutout",
  id: "doodle",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  asset,
  ...(meshUrl === undefined ? {} : { meshUrl }),
});

const sceneWith = (...items: StageItem[]): SceneState => ({
  revision: 4,
  frame: { x: 0, y: 0, width: 100, height: 100 },
  items: Object.fromEntries(items.map((item) => [item.id, item])),
});

const commit = (fields: Partial<SceneCommit>): SceneCommit => ({
  type: "scene.commit",
  requestId: "r",
  epoch: 1,
  upserts: [],
  removes: [],
  ...fields,
});

function applied(scene: SceneState, change: SceneCommit): SceneState {
  const plan = planCommit(scene, assets, change);
  if (!plan.ok) throw new Error(plan.message);
  applyPatch(scene, plan.patch);
  return scene;
}

describe("meshUrl is server-owned", () => {
  const stored = "https://meshes.example/doodle.glb";

  it("survives a writer upsert that omits it, including after a reset", () => {
    const moved = { ...doodle(), rect: { x: 5, y: 5, width: 10, height: 10 } };
    expect(applied(sceneWith(doodle(stored)), commit({ upserts: [moved] })).items.doodle).toEqual({
      ...moved,
      meshUrl: stored,
    });
    expect(
      applied(sceneWith(doodle(stored)), commit({ reset: true, upserts: [doodle()] })).items.doodle,
    ).toEqual(doodle(stored));
  });

  it("ignores a meshUrl sent by the writer", () => {
    expect(
      applied(
        sceneWith(doodle(stored)),
        commit({ upserts: [doodle("https://evil.example/x.glb")] }),
      ).items.doodle,
    ).toEqual(doodle(stored));
    expect(
      applied(sceneWith(), commit({ upserts: [doodle("https://evil.example/x.glb")] })).items
        .doodle,
    ).toEqual(doodle());
  });
});

it("refuses element ids that reach the prototype chain", () => {
  const wall: StageItem = {
    kind: "wall",
    id: "__proto__",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    shape: "rect",
    rotation: 0,
  };
  expect(planCommit(sceneWith(), assets, commit({ upserts: [wall] }))).toMatchObject({
    ok: false,
    error: "bad_message",
  });
  expect(planCommit(sceneWith(), assets, commit({ removes: ["constructor"] }))).toMatchObject({
    ok: false,
    error: "bad_message",
  });
});
