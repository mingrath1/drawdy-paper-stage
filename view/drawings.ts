import {
    CanvasTexture,
    DoubleSide,
    MeshLambertMaterial,
    RepeatWrapping,
    SRGBColorSpace,
    Sprite,
    SpriteMaterial,
    type Texture,
} from "./vendor/three.module.js";

export const INK = "#26221d";
export const PAPER = "#fcfaf4";

/** Paper lit softly, glowing a little with its own picture so drawings keep the colors they had on the board. */
export function paperMaterial(): MeshLambertMaterial {
    return new MeshLambertMaterial({
        side: DoubleSide,
        alphaTest: 0.2,
        alphaToCoverage: true,
        emissive: "#ffffff",
        emissiveIntensity: 0.4,
    });
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return [c, c.getContext("2d")!];
}

function texture(c: HTMLCanvasElement): CanvasTexture {
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    return t;
}

/** One square meter of floor paper with a faint pencil grid line on two edges, meant to repeat. */
export function floorPaper(): Texture {
    const size = 256;
    const [c, g] = canvas(size, size);
    g.fillStyle = "#f4efe4";
    g.fillRect(0, 0, size, size);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2600; i++) {
        g.fillStyle = random() > 0.5 ? "rgba(120,100,70,0.05)" : "rgba(255,255,255,0.35)";
        g.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
    }
    g.strokeStyle = "rgba(90,110,140,0.22)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 1);
    g.lineTo(size, 1);
    g.moveTo(1, 0);
    g.lineTo(1, size);
    g.stroke();
    const t = texture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    return t;
}

/** A paper doll facing the viewer, tinted with the person's color: face on the front, plain back. */
export function paperDoll(color: string): Texture {
    const [c, g] = canvas(256, 512);
    const body = new Path2D();
    body.arc(128, 92, 58, 0, Math.PI * 2);
    body.roundRect(58, 160, 140, 190, [44, 44, 18, 18]);
    body.roundRect(24, 172, 40, 150, 20);
    body.roundRect(192, 172, 40, 150, 20);
    body.roundRect(72, 330, 48, 168, 22);
    body.roundRect(136, 330, 48, 168, 22);
    g.lineJoin = "round";
    g.strokeStyle = PAPER;
    g.lineWidth = 18;
    g.stroke(body);
    g.fillStyle = PAPER;
    g.fill(body);
    g.fillStyle = color;
    g.globalAlpha = 0.85;
    g.fill(body);
    g.globalAlpha = 1;
    g.strokeStyle = INK;
    g.lineWidth = 5;
    g.stroke(body);
    g.fillStyle = INK;
    g.beginPath();
    g.arc(106, 86, 7, 0, Math.PI * 2);
    g.arc(150, 86, 7, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 5;
    g.beginPath();
    g.arc(128, 104, 22, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
    return texture(c);
}

/** A giant open hand reaching down, fingers toward the floor, with a soft glow in the person's color. */
export function glowingHand(color: string): Texture {
    const [c, g] = canvas(256, 320);
    const hand = new Path2D();
    hand.roundRect(70, 40, 116, 130, 44);
    [92, 112, 108, 88].forEach((length, i) => hand.roundRect(72 + i * 29, 140, 26, length, 13));
    const thumb = new Path2D();
    thumb.roundRect(-14, 0, 28, 84, 14);
    const drawThumb = (paint: () => void) => {
        g.save();
        g.translate(84, 96);
        g.rotate(0.55);
        paint();
        g.restore();
    };
    g.shadowColor = color;
    g.shadowBlur = 34;
    g.fillStyle = color;
    g.fill(hand);
    drawThumb(() => g.fill(thumb));
    g.shadowBlur = 0;
    g.fillStyle = "rgba(255,255,255,0.3)";
    g.beginPath();
    g.ellipse(150, 84, 24, 32, 0.3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 5;
    g.stroke(hand);
    drawThumb(() => g.stroke(thumb));
    return texture(c);
}

/** A round soft spot of light, used under hands on the floor. */
export function glowSpot(): Texture {
    const [c, g] = canvas(128, 128);
    const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.35)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gradient;
    g.fillRect(0, 0, 128, 128);
    return texture(c);
}

/** A name pill that always faces the camera. Its height in meters is `height`. */
export function nameLabel(name: string, color: string, height = 0.28): Sprite {
    const font = "600 44px ui-rounded, system-ui, sans-serif";
    const [, mg] = canvas(1, 1);
    mg.font = font;
    const width = Math.ceil(Math.min(mg.measureText(name).width, 900)) + 56;
    const [c, g] = canvas(width, 72);
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(2, 2, width - 4, 68, 34);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 4;
    g.stroke();
    g.font = font;
    g.fillStyle = readableOn(color);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(name, width / 2, 38, width - 40);
    const sprite = new Sprite(new SpriteMaterial({ map: texture(c), transparent: true, depthWrite: false }));
    sprite.scale.set((height * width) / 72, height, 1);
    return sprite;
}

function readableOn(color: string): string {
    const probe = canvas(1, 1)[1];
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? INK : "#ffffff";
}
