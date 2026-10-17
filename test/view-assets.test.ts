import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetCache } from "../view/assets";

type Picture = { hash: string; freed: boolean };

/** A cache whose loads the test settles by hand, recording every fetch and every free. */
function harness() {
    const fetches: { hash: string; resolve(): void; reject(): void }[] = [];
    const freed: string[] = [];
    const cache = new AssetCache<Picture>(
        (hash) =>
            new Promise((resolve, reject) =>
                fetches.push({
                    hash,
                    resolve: () => resolve({ hash, freed: false }),
                    reject: () => reject(new Error(`no ${hash}`)),
                }),
            ),
        (picture) => {
            picture.freed = true;
            freed.push(picture.hash);
        },
    );
    const settle = async (index: number, ok: boolean) => {
        fetches[index][ok ? "resolve" : "reject"]();
        await vi.advanceTimersByTimeAsync(0);
    };
    return { cache, fetches, freed, settle };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("asset cache", () => {
    it("fetches a picture once however many users share it", async () => {
        const { cache, fetches, settle } = harness();
        cache.acquire("a");
        cache.acquire("a");
        expect(fetches.map((f) => f.hash)).toEqual(["a"]);
        expect(cache.get("a")).toBeNull();
        await settle(0, true);
        expect(cache.get("a")?.hash).toBe("a");
    });

    it("frees a picture when its last user lets go, and fetches it again for a new user", async () => {
        const { cache, fetches, freed, settle } = harness();
        cache.acquire("a");
        cache.acquire("a");
        await settle(0, true);
        cache.release("a");
        expect(freed).toEqual([]);
        cache.release("a");
        expect(freed).toEqual(["a"]);
        expect(cache.get("a")).toBeNull();
        cache.acquire("a");
        expect(fetches).toHaveLength(2);
    });

    it("frees a picture that finishes loading after its last user is gone", async () => {
        const { cache, freed, settle } = harness();
        cache.acquire("a");
        cache.release("a");
        await settle(0, true);
        expect(freed).toEqual(["a"]);
        expect(cache.get("a")).toBeNull();
    });

    it("keeps retrying a failed picture with growing waits while anyone wants it", async () => {
        const { cache, fetches, settle } = harness();
        cache.acquire("a");
        await settle(0, false);
        expect(cache.get("a")).toBeNull();
        await vi.advanceTimersByTimeAsync(999);
        expect(fetches).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetches).toHaveLength(2);
        await settle(1, false);
        await vi.advanceTimersByTimeAsync(1999);
        expect(fetches).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetches).toHaveLength(3);
        for (let attempt = 3; attempt < 8; attempt++) {
            await settle(attempt - 1, false);
            await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(fetches).toHaveLength(8);
        await settle(7, true);
        expect(cache.get("a")?.hash).toBe("a");
    });

    it("stops retrying once nobody wants the picture", async () => {
        const { cache, fetches, settle } = harness();
        cache.acquire("a");
        await settle(0, false);
        cache.release("a");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetches).toHaveLength(1);
    });

    it("retries every failed picture at once after a reconnect", async () => {
        const { cache, fetches, settle } = harness();
        cache.acquire("a");
        cache.acquire("b");
        await settle(0, false);
        await settle(1, true);
        cache.retryFailed();
        expect(fetches.map((f) => f.hash)).toEqual(["a", "b", "a"]);
        await settle(2, true);
        expect(cache.get("a")?.hash).toBe("a");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetches).toHaveLength(3);
    });
});
