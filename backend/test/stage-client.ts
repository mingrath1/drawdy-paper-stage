import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import {
  parseServerMessage,
  type Pose,
  type Role,
  type ServerMessage,
  type StageItem,
} from "../../shared/protocol.ts";

export const TOKEN = "stage-token";
export const freshStage = () => `stage-${crypto.randomUUID()}`;

type Message<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export class Client {
  readonly socket: WebSocket;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #inbox: ServerMessage[] = [];
  #wake: (() => void) | undefined;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.accept();
    socket.addEventListener("message", (event) => {
      // Every frame the Stage sends must satisfy the shared protocol.
      this.#inbox.push(parseServerMessage(event.data as string));
      this.#wake?.();
    });
    this.closed = new Promise((resolve) =>
      socket.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
        this.#wake?.();
      }),
    );
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  async next(timeoutMs = 3_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (this.#inbox.length === 0) {
      if (Date.now() > deadline) throw new Error(`no message within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 50);
      });
    }
    return this.#inbox.shift()!;
  }

  async expect<T extends ServerMessage["type"]>(type: T, timeoutMs?: number): Promise<Message<T>> {
    const message = await this.next(timeoutMs);
    expect(message.type).toBe(type);
    return message as Message<T>;
  }

  /** Proves nothing else is queued: the next frame after a ping must be its pong. */
  async expectQuiet(): Promise<void> {
    const t = Math.random();
    this.send({ type: "ping", t });
    expect(await this.next()).toEqual({ type: "pong", t });
  }

  close(): void {
    this.socket.close(1000, "done");
  }
}

export async function connect(stageId: string): Promise<Client> {
  const response = await exports.default.fetch(`https://example.com/api/stages/${stageId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  return new Client(response.webSocket!);
}

export const participant = (name: string) => ({
  presenceId: `presence-${name}`,
  name,
  color: "#ff7a00",
});

export const hello = (stageId: string, role: Role, token = TOKEN, name: string = role) => ({
  type: "hello",
  v: 2,
  stageId,
  token,
  role,
  participant: participant(name),
});

export async function join(stageId: string, role: Role, name: string = role) {
  const client = await connect(stageId);
  client.send(hello(stageId, role, TOKEN, name));
  const welcome = await client.expect("welcome");
  return { client, welcome };
}

/** The first driver of a fresh stage, after its election. */
export async function writerOf(stageId: string) {
  const { client, welcome } = await join(stageId, "driver");
  const { writer } = await client.expect("writer");
  expect(writer.connectionId).toBe(welcome.connectionId);
  return { client, epoch: writer.epoch, connectionId: welcome.connectionId };
}

export const wall = (id: string, x = 0): StageItem => ({
  kind: "wall",
  id,
  rect: { x, y: 0, width: 300, height: 10 },
  shape: "rect",
  rotation: 0,
});

export const commit = (epoch: number, requestId: string, fields: Record<string, unknown>) => ({
  type: "scene.commit",
  requestId,
  epoch,
  upserts: [],
  removes: [],
  ...fields,
});

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Bytes with a PNG signature and IHDR, which is all the Stage reads. */
export async function png(width: number, height: number, salt: number) {
  const bytes = new Uint8Array(37);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(33, salt);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes, hash, width, height, pngBase64: toBase64(bytes) };
}

export const put = (epoch: number, requestId: string, asset: Awaited<ReturnType<typeof png>>) => ({
  type: "asset.put",
  requestId,
  epoch,
  hash: asset.hash,
  width: asset.width,
  height: asset.height,
  pngBase64: asset.pngBase64,
});

export const cutout = (
  id: string,
  asset: { hash: string; width: number; height: number },
): StageItem => ({
  kind: "cutout",
  id,
  rect: { x: 10, y: 10, width: 40, height: 40 },
  asset: { hash: asset.hash, width: asset.width, height: asset.height },
});

export const pose = (x: number): Pose => ({ x, y: 2, heading: 0.5, pitch: 0.1 });
