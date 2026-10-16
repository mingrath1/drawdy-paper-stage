import type { LinkStatus } from "./link";

const STATUS_TEXT: { [K in LinkStatus["kind"]]: (status: Extract<LinkStatus, { kind: K }>) => string } = {
    connecting: () => "Connecting",
    live: () => "Live",
    retrying: (status) => `${status.note} in ${Math.max(1, Math.ceil((status.at - Date.now()) / 1000))}s`,
    stopped: (status) => status.note,
};

/** The small overlay: connection dot, people count, the how-to hint, and an fps readout that F toggles. */
export class Hud {
    private status: LinkStatus = { kind: "connecting" };
    private readonly root = document.getElementById("hud")!;
    private readonly statusText = document.getElementById("status-text")!;
    private readonly people = document.getElementById("people")!;
    private readonly fps = document.getElementById("fps")!;
    private readonly hint = document.getElementById("hint")!;

    constructor() {
        addEventListener("keydown", (event) => {
            if (event.code === "KeyF" && !event.metaKey && !event.ctrlKey) this.fps.hidden = !this.fps.hidden;
        });
        setInterval(() => this.render(), 500);
    }

    link(status: LinkStatus): void {
        this.status = status;
        this.render();
    }

    count(people: number): void {
        const text = people === 1 ? "1 here" : `${people} here`;
        if (this.people.textContent !== text) this.people.textContent = text;
    }

    frameRate(fps: number): void {
        this.fps.textContent = `${fps} fps`;
    }

    walked(): void {
        this.hint.classList.add("quiet");
    }

    private render(): void {
        this.root.dataset.link = this.status.kind;
        const render = STATUS_TEXT[this.status.kind] as (status: LinkStatus) => string;
        this.statusText.textContent = render(this.status);
    }
}
