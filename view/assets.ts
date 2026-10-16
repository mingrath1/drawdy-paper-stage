import { assetUrl, type AssetHash, type ViewBoot } from "../shared/protocol";
import { CanvasTexture, SRGBColorSpace, type Texture } from "./vendor/three.module.js";
import { cutOutPaper } from "./paper";

const ATTEMPTS = 3;

/** Cutout textures by content hash. Each PNG is fetched and cut out once per view, however many cutouts share it. */
export class CutoutTextures {
    private readonly byHash = new Map<AssetHash, Promise<Texture>>();

    constructor(
        private readonly boot: ViewBoot,
        readonly anisotropy: number,
    ) {}

    get(hash: AssetHash): Promise<Texture> {
        let texture = this.byHash.get(hash);
        if (!texture) {
            texture = this.load(hash);
            texture.catch(() => this.byHash.delete(hash));
            this.byHash.set(hash, texture);
        }
        return texture;
    }

    private async load(hash: AssetHash): Promise<Texture> {
        const url = assetUrl(this.boot.backendUrl, this.boot.stageId, this.boot.token, hash);
        for (let attempt = 1; ; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`asset ${hash} answered ${response.status}`);
                return this.cutOut(await createImageBitmap(await response.blob()));
            } catch (error) {
                if (attempt === ATTEMPTS) throw error;
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            }
        }
    }

    private cutOut(bitmap: ImageBitmap): Texture {
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
        texture.anisotropy = this.anisotropy;
        return texture;
    }
}
