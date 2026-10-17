import { assetUrl, type AssetHash, type ViewBoot } from "../shared/protocol";
import { CanvasTexture, SRGBColorSpace, type Texture } from "./vendor/three.module.js";
import { cutOutPaper } from "./paper";

type Load<T> =
    | { kind: "loading" }
    | { kind: "loaded"; value: T }
    | { kind: "failed"; retry: ReturnType<typeof setTimeout> };

type Entry<T> = { users: number; failures: number; load: Load<T> };

export function assetRetryDelayMs(failures: number): number {
    return Math.min(30_000, 1_000 * 2 ** (failures - 1));
}

/**
 * Assets by content hash, loaded once however many users share one and freed when the last user lets go. A failed
 * load retries with backoff for as long as anyone still wants it.
 */
export class AssetCache<T> {
    private readonly entries = new Map<AssetHash, Entry<T>>();

    constructor(
        private readonly load: (hash: AssetHash) => Promise<T>,
        private readonly free: (value: T) => void,
    ) {}

    acquire(hash: AssetHash): void {
        const entry = this.entries.get(hash);
        if (entry) {
            entry.users++;
            return;
        }
        const created: Entry<T> = { users: 1, failures: 0, load: { kind: "loading" } };
        this.entries.set(hash, created);
        this.start(hash, created);
    }

    release(hash: AssetHash): void {
        const entry = this.entries.get(hash);
        if (!entry || --entry.users > 0) return;
        this.entries.delete(hash);
        if (entry.load.kind === "loaded") this.free(entry.load.value);
        if (entry.load.kind === "failed") clearTimeout(entry.load.retry);
    }

    /** The loaded asset, or null while it loads or after it failed. */
    get(hash: AssetHash): T | null {
        const load = this.entries.get(hash)?.load;
        return load?.kind === "loaded" ? load.value : null;
    }

    /** Retries every failed asset now instead of waiting out its backoff, as after a reconnect. */
    retryFailed(): void {
        for (const [hash, entry] of this.entries) {
            if (entry.load.kind !== "failed") continue;
            clearTimeout(entry.load.retry);
            this.start(hash, entry);
        }
    }

    private start(hash: AssetHash, entry: Entry<T>): void {
        entry.load = { kind: "loading" };
        this.load(hash).then(
            (value) => {
                if (this.entries.get(hash) !== entry) return this.free(value);
                entry.failures = 0;
                entry.load = { kind: "loaded", value };
            },
            (error) => {
                if (this.entries.get(hash) !== entry) return;
                entry.failures++;
                console.warn("paper-stage: asset failed", hash, error);
                entry.load = {
                    kind: "failed",
                    retry: setTimeout(() => this.start(hash, entry), assetRetryDelayMs(entry.failures)),
                };
            },
        );
    }
}

/** Fetches a cutout's PNG and cuts it out of its board background. */
export function cutoutLoader(boot: ViewBoot, anisotropy: number): (hash: AssetHash) => Promise<Texture> {
    return async (hash) => {
        const response = await fetch(assetUrl(boot.backendUrl, boot.stageId, boot.token, hash));
        if (!response.ok) throw new Error(`asset ${hash} answered ${response.status}`);
        const texture = cutOut(await createImageBitmap(await response.blob()));
        texture.anisotropy = anisotropy;
        return texture;
    };
}

/** Frees the GPU copy and the canvas behind a cutout texture. */
export function freeCutout(texture: Texture): void {
    texture.dispose();
    const canvas = texture.image as HTMLCanvasElement;
    canvas.width = canvas.height = 0;
}

function cutOut(bitmap: ImageBitmap): Texture {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    cutOutPaper(image.data, image.width, image.height);
    context.putImageData(image, 0, 0);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
}
