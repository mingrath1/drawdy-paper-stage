import { defineDocFamily } from "@earendil-works/pi-durable";
import {
  type AssetHash,
  type ClientMessage,
  MAX_CUTOUTS_PER_STAGE,
} from "../../shared/protocol.ts";
import type { Refusal } from "./scene.ts";

export type AssetEntry = { width: number; height: number; storedAt: number };

/** One uploaded PNG per hash, kept out of the scene document so the scene stays small. */
export const AssetBytes = defineDocFamily<{ pngBase64: string }, string>({
  family: true,
  kind: "app.stage-asset",
  version: 1,
  scope: "session",
  initial: (pngBase64) => ({ pngBase64 }),
});

/**
 * Stored PNGs may outnumber cutouts, so a writer can upload a doodle's new version before the commit that swaps it in,
 * even on a stage that already holds MAX_CUTOUTS_PER_STAGE cutouts.
 */
export const MAX_STORED_ASSETS = 2 * MAX_CUTOUTS_PER_STAGE;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Checks that an upload is a PNG of the declared size whose bytes hash to the declared hash. */
export async function verifyUpload(
  put: Extract<ClientMessage, { type: "asset.put" }>,
): Promise<Refusal | undefined> {
  const bytes = decodeBase64(put.pngBase64);
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return { ok: false, error: "bad_message", message: "pngBase64 is not a PNG" };
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (width !== put.width || height !== put.height) {
    return { ok: false, error: "bad_message", message: `the PNG is ${width}x${height}` };
  }
  if ((await sha256Hex(bytes)) !== put.hash) {
    return {
      ok: false,
      error: "bad_message",
      message: "the PNG does not hash to its declared hash",
    };
  }
  return undefined;
}

/**
 * Hashes to delete so one more asset fits: the oldest that no scene item references. A scene references at most
 * MAX_CUTOUTS_PER_STAGE assets, so enough unreferenced ones always exist.
 */
export function evictionsFor(
  assets: Readonly<Record<AssetHash, AssetEntry>>,
  referenced: ReadonlySet<AssetHash>,
): AssetHash[] {
  const excess = Object.keys(assets).length + 1 - MAX_STORED_ASSETS;
  if (excess <= 0) return [];
  return Object.entries(assets)
    .filter(([hash]) => !referenced.has(hash))
    .sort(([, left], [, right]) => left.storedAt - right.storedAt)
    .slice(0, excess)
    .map(([hash]) => hash);
}
