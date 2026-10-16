import { type CheckpointInfo, defineDoc } from "@earendil-works/pi-durable";
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

/**
 * Stores a full copy instead of a delta every 32 changes. A load replays only the deltas after the newest copy, and
 * pi-durable deletes the older revisions of a session document when it stores a copy.
 */
export const checkpointEvery32 = (_value: unknown, _ops: unknown, info: CheckpointInfo): boolean =>
  info.deltasSinceBase >= 32;

export const SceneDoc = defineDoc<SceneState>({
  kind: "app.stage",
  version: 1,
  scope: "session",
  initial: () => ({ revision: 0, frame: { x: 0, y: 0, width: 0, height: 0 }, items: {} }),
  checkpointWhen: checkpointEvery32,
});

/** An accepted commit, so a resend of the same commit is acked again instead of applied twice. */
export type CommitReceipt = { epoch: number; requestId: string; digest: string; revision: number };
export type ReceiptsState = { receipts: CommitReceipt[] };

/** A driver resends unanswered messages after 5 s, far fewer than this many. */
export const MAX_RECEIPTS = 256;

export const CommitReceipts = defineDoc<ReceiptsState>({
  kind: "app.stage-commit-receipts",
  version: 1,
  scope: "session",
  initial: () => ({ receipts: [] }),
  checkpointWhen: checkpointEvery32,
});

export const findReceipt = (
  state: Readonly<ReceiptsState>,
  epoch: number,
  requestId: string,
): CommitReceipt | undefined =>
  state.receipts.find((receipt) => receipt.epoch === epoch && receipt.requestId === requestId);

/** Keeps the newest MAX_RECEIPTS receipts. The Stage runs it on the document draft and then on its in-memory copy. */
export function remember(state: ReceiptsState, receipt: CommitReceipt): void {
  state.receipts.push(receipt);
  if (state.receipts.length > MAX_RECEIPTS) {
    state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS);
  }
}

/** The part of a commit a resend must repeat exactly. The parser builds every item with a fixed key order. */
export const commitPayload = ({ reset, frame, upserts, removes }: SceneCommit): string =>
  JSON.stringify([reset ?? false, frame ?? null, upserts, removes]);

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
 * Checks a writer's commit against the stage limits and the uploaded assets, and returns the patch that applies it,
 * or no patch when the commit would leave the scene as it is.
 * `meshUrl` is server-owned: an upserted cutout drops any it sent and keeps the one stored under its id while its
 * picture stays the same.
 */
export function planCommit(
  scene: Readonly<SceneState>,
  assets: Readonly<Record<AssetHash, { width: number; height: number }>>,
  commit: SceneCommit,
): { ok: true; patch: ScenePatch | undefined } | Refusal {
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

  const patch: ScenePatch = {
    revision: scene.revision + 1,
    ...(commit.reset ? { reset: true } : {}),
    ...(commit.frame === undefined ? {} : { frame: commit.frame }),
    upserts: commit.upserts.map((item) =>
      withStoredMesh(item, Object.hasOwn(scene.items, item.id) ? scene.items[item.id] : undefined),
    ),
    removes: commit.removes,
  };
  return { ok: true, patch: changesScene(scene, patch) ? patch : undefined };
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

function changesScene(scene: Readonly<SceneState>, patch: ScenePatch): boolean {
  const stored = (id: ElementId) => (Object.hasOwn(scene.items, id) ? scene.items[id] : undefined);
  if (patch.frame !== undefined && !sameJson(patch.frame, scene.frame)) return true;
  if (patch.removes.some((id) => stored(id) !== undefined)) return true;
  if (patch.upserts.some((item) => !sameJson(item, stored(item.id)))) return true;
  if (!patch.reset) return false;
  const upserted = new Set(patch.upserts.map((item) => item.id));
  return Object.keys(scene.items).some((id) => !upserted.has(id));
}

function withStoredMesh(item: StageItem, stored: StageItem | undefined): StageItem {
  if (item.kind !== "cutout") return item;
  const { meshUrl: _sent, ...cutout } = item;
  return stored?.kind === "cutout" &&
    stored.meshUrl !== undefined &&
    stored.asset.hash === cutout.asset.hash
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
