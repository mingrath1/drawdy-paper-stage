import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import {
  type AssetHash,
  type ClientMessage,
  type ElementId,
  MAX_CUTOUTS_PER_STAGE,
  MAX_ITEMS_PER_STAGE,
  type Rect,
  type ServerMessage,
  type StageItem,
  type StageSnapshot,
} from "../../shared/protocol.ts";

export type SceneState = {
  revision: number;
  frame: Rect;
  items: Record<ElementId, StageItem>;
};

export const SceneDoc = defineDoc<SceneState>({
  kind: "app.stage",
  version: 1,
  scope: "session",
  initial: () => ({ revision: 0, frame: { x: 0, y: 0, width: 0, height: 0 }, items: {} }),
});

/** The revision each applied commit produced, keyed by its requestId, so a retried commit is acked, not reapplied. */
export const CommitReceipts = defineDocFamily<{ revision?: number }, null>({
  family: true,
  kind: "app.stage-commit-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

export type SceneCommit = Extract<ClientMessage, { type: "scene.commit" }>;
export type ScenePatch = Omit<Extract<ServerMessage, { type: "scene.patch" }>, "type">;
export type Refusal = Omit<
  Extract<ServerMessage, { type: "ack"; ok: false }>,
  "type" | "requestId"
>;

/** Keys that document paths cannot hold because they reach the prototype chain. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

const refuse = (error: Refusal["error"], message: string): Refusal => ({
  ok: false,
  error,
  message,
});

export const sceneSnapshot = (scene: Readonly<SceneState>): StageSnapshot => ({
  revision: scene.revision,
  frame: scene.frame,
  items: Object.values(scene.items),
});

export const referencedAssets = (scene: Readonly<SceneState>): Set<AssetHash> =>
  new Set(
    Object.values(scene.items).flatMap((item) => (item.kind === "cutout" ? [item.asset.hash] : [])),
  );

/**
 * Checks a writer's commit against the stage limits and the uploaded assets, and returns the patch that applies it.
 * `meshUrl` is server-owned: an upserted cutout keeps the one already stored under its id and drops any it sent.
 */
export function planCommit(
  scene: Readonly<SceneState>,
  assets: Readonly<Record<AssetHash, { width: number; height: number }>>,
  commit: SceneCommit,
): { ok: true; patch: ScenePatch } | Refusal {
  const touched = new Set([...commit.upserts.map((item) => item.id), ...commit.removes]);
  if ([...touched].some((id) => RESERVED_IDS.has(id))) {
    return refuse("bad_message", "element ids cannot be __proto__, constructor, or prototype");
  }
  for (const item of commit.upserts) {
    if (item.kind !== "cutout") continue;
    const { hash, width, height } = item.asset;
    if (!Object.hasOwn(assets, hash)) {
      return refuse("missing_asset", `asset ${hash} was never uploaded`);
    }
    if (assets[hash]!.width !== width || assets[hash]!.height !== height) {
      return refuse(
        "bad_message",
        `asset ${hash} is ${assets[hash]!.width}x${assets[hash]!.height}`,
      );
    }
  }

  const kept = commit.reset
    ? []
    : Object.values(scene.items).filter((item) => !touched.has(item.id));
  const items = [...kept, ...commit.upserts];
  if (items.length > MAX_ITEMS_PER_STAGE) {
    return refuse("limit", `a stage holds at most ${MAX_ITEMS_PER_STAGE} items`);
  }
  if (items.filter((item) => item.kind === "cutout").length > MAX_CUTOUTS_PER_STAGE) {
    return refuse("limit", `a stage holds at most ${MAX_CUTOUTS_PER_STAGE} cutouts`);
  }

  return {
    ok: true,
    patch: {
      revision: scene.revision + 1,
      ...(commit.reset ? { reset: true } : {}),
      ...(commit.frame === undefined ? {} : { frame: commit.frame }),
      upserts: commit.upserts.map((item) =>
        withStoredMesh(
          item,
          Object.hasOwn(scene.items, item.id) ? scene.items[item.id] : undefined,
        ),
      ),
      removes: commit.removes,
    },
  };
}

function withStoredMesh(item: StageItem, stored: StageItem | undefined): StageItem {
  if (item.kind !== "cutout") return item;
  const { meshUrl: _sent, ...cutout } = item;
  return stored?.kind === "cutout" && stored.meshUrl !== undefined
    ? { ...cutout, meshUrl: stored.meshUrl }
    : cutout;
}

/** Applies a planned patch. The Stage runs it on the document draft and then on its in-memory copy. */
export function applyPatch(scene: SceneState, patch: ScenePatch): void {
  if (patch.reset) for (const id of Object.keys(scene.items)) delete scene.items[id];
  for (const id of patch.removes) delete scene.items[id];
  for (const item of patch.upserts) scene.items[item.id] = item;
  if (patch.frame !== undefined) scene.frame = patch.frame;
  scene.revision = patch.revision;
}
