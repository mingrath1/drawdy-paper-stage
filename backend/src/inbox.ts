import { type ClientMessage, CURSOR_HZ, POSE_HZ } from "../../shared/protocol.ts";

type Rate = { readonly perSecond: number; readonly burst: number };

const MEMBER_RATE: Rate = { perSecond: 60, burst: 60 };
/** Room for the writer to upload every cutout of a full stage and commit it in one burst. */
const WRITER_RATE: Rate = { perSecond: 150, burst: 150 };
/** Lets a few poses or cursor lists that the network delivers together through without raising the sustained rate. */
const POSE_RATE: Rate = { perSecond: POSE_HZ, burst: 5 };
const CURSOR_RATE: Rate = { perSecond: CURSOR_HZ, burst: 5 };

export const MAX_PENDING_FRAMES = 200;

class TokenBucket {
  readonly #rate: Rate;
  #tokens: number;
  #at = -Infinity;

  constructor(rate: Rate) {
    this.#rate = rate;
    this.#tokens = rate.burst;
  }

  take(now: number): boolean {
    const { perSecond, burst } = this.#rate;
    this.#tokens = Math.min(burst, this.#tokens + ((now - this.#at) * perSecond) / 1000);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/**
 * One socket's rate budget and its frames still being handled. In memory only: hibernation means the socket was idle,
 * so a fresh budget is correct after a wake.
 */
export class Inbox {
  readonly #memberMessages = new TokenBucket(MEMBER_RATE);
  /** Separate, so a driver elected writer starts with the writer's full burst. */
  readonly #writerMessages = new TokenBucket(WRITER_RATE);
  readonly #poses = new TokenBucket(POSE_RATE);
  readonly #cursors = new TokenBucket(CURSOR_RATE);
  #lastWarning = -Infinity;
  #pending = 0;

  /** Spends the budget for a frame that arrived at `now`. The elected writer gets a larger budget. */
  admit(type: ClientMessage["type"], writer: boolean, now: number): boolean {
    if (!(writer ? this.#writerMessages : this.#memberMessages).take(now)) return false;
    if (type === "pose") return this.#poses.take(now);
    if (type === "cursors") return this.#cursors.take(now);
    return true;
  }

  /** True at most once a second, for the error that tells a socket its frames are being dropped. */
  warn(now: number): boolean {
    if (now - this.#lastWarning < 1_000) return false;
    this.#lastWarning = now;
    return true;
  }

  get full(): boolean {
    return this.#pending >= MAX_PENDING_FRAMES;
  }

  /** Counts a frame as pending until its handling settles. */
  async hold(handle: () => Promise<void>): Promise<void> {
    this.#pending++;
    try {
      await handle();
    } finally {
      this.#pending--;
    }
  }
}
