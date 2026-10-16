import type {
    DriverCommand,
    DriverCommandIssuer,
    DriverCommandRequest,
    ModuleStyling,
    ProtocolCommandError,
} from "@drawdy/driver-protocol";
import { column, paletteOf, px, text, type Palette } from "./dom-schema";

export const COMMAND_TIMEOUT_MS = 10_000;
/** The first command of a permission can wait on a dialog, which waits on the person. */
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const HINT_ID = "paper-stage-hint";
const HINT_WIDTH = 360;
const HINT_MS = 9_000;

export type CommandType = DriverCommandRequest["type"];
type CommandOf<T extends CommandType> = Extract<DriverCommand, { type: T }>;
type RequestOf<T extends CommandType> = CommandOf<T> extends { req: infer Q } ? Q : undefined;
type ValueOf<T extends CommandType> = Extract<CommandOf<T>["res"], { value: unknown }>["value"];
export type RequestArgs<T extends CommandType> = RequestOf<T> extends undefined ? [] : [RequestOf<T>];

export type CommandFailure = { ok: false; error: ProtocolCommandError["type"] | "timeout"; message: string };
export type CommandResult<T extends CommandType> = { ok: true; value: ValueOf<T> } | CommandFailure;

type GatedPermission = "scene" | "dom" | "collaboration";

const PERMISSION_BY_PREFIX: [prefix: string, permission: GatedPermission][] = [
    ["command:scene:", "scene"],
    ["subscription:scene:", "scene"],
    ["command:dom:", "dom"],
    ["subscription:dom:", "dom"],
    ["command:collaboration:", "collaboration"],
    ["subscription:collaboration:", "collaboration"],
];

// A denied dom permission also blocks the hint itself, so it has no entry.
const DENIED_HINT: Partial<Record<GatedPermission, string>> = {
    scene: "Paper Stage needs the board permission to read your floor plan and build the stage.",
    collaboration: "Paper Stage can't see who else is on the board, so their hands stay hidden. Walking still works.",
};
const REENABLE = "To allow it, remove Paper Stage from your extensions, add it again, and click its button.";

// Drawdy lets a driver create its button and hear its clicks without a prompt, as the probes measured.
const UNGATED = new Set<CommandType>(["command:dom:create-action-button", "subscription:dom:element-clicked"]);

function permissionOf(type: CommandType): GatedPermission | null {
    if (UNGATED.has(type)) return null;
    return PERMISSION_BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1] ?? null;
}

/** The one door to Drawdy. Every command resolves to a result, times out instead of hanging, and explains denials. */
export class Host {
    private seq = 0;
    private hintTimer: ReturnType<typeof setTimeout> | null = null;
    private shownHint: string | null = null;
    private readonly decided = new Set<GatedPermission>();
    readonly palette: Palette;

    constructor(
        private readonly issueCommand: DriverCommandIssuer,
        private readonly driverId: string,
        styling: ModuleStyling,
    ) {
        this.palette = paletteOf(styling);
    }

    /** Issues a command and reports failures to the user. */
    async run<T extends CommandType>(type: T, ...args: RequestArgs<T>): Promise<CommandResult<T>> {
        const result = await this.call(type, ...args);
        if (!result.ok) await this.report(type, result);
        return result;
    }

    /** Issues a command without reporting failures. */
    async call<T extends CommandType>(type: T, ...[req]: RequestArgs<T>): Promise<CommandResult<T>> {
        const request = {
            type,
            driverId: this.driverId,
            requestId: `ps-${++this.seq}`,
            ...(req === undefined ? {} : { req }),
        } as Extract<DriverCommandRequest, { type: T }>;
        const permission = permissionOf(type);
        const limitMs = permission && !this.decided.has(permission) ? PROMPT_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), limitMs);
        });
        try {
            const response = await Promise.race([this.issueCommand(request), timeout]);
            if (response === "timeout") {
                return {
                    ok: false,
                    error: "timeout",
                    message: `Drawdy did not answer ${type} within ${limitMs / 1000} s`,
                };
            }
            if (permission) this.decided.add(permission);
            const res = response.res as { value?: ValueOf<T>; error?: ProtocolCommandError };
            if (res.error) return { ok: false, error: res.error.type, message: res.error.message ?? res.error.type };
            return { ok: true, value: res.value as ValueOf<T> };
        } catch (err) {
            return { ok: false, error: "runtime", message: err instanceof Error ? err.message : String(err) };
        } finally {
            clearTimeout(timer);
        }
    }

    private async report(type: CommandType, failure: CommandFailure): Promise<void> {
        console.warn(`[paper-stage] ${type} failed: ${failure.error} ${failure.message}`);
        const permission = permissionOf(type);
        if (failure.error === "unauthorized") {
            const reason = permission && DENIED_HINT[permission];
            if (reason) await this.hint("Permission needed", [reason, REENABLE]);
            return;
        }
        if (failure.error === "timeout") {
            await this.hint("Drawdy didn't answer", [
                "Paper Stage waited for the board and got no answer. Click the Paper Stage button to try again.",
            ]);
        }
    }

    /** Shows a short floating note at the top of the window. Never reports its own failures. */
    async hint(title: string, lines: string[]): Promise<void> {
        const key = [title, ...lines].join("\n");
        if (this.shownHint === key) return;
        const size = await this.call("command:dom:window-size");
        if (!size.ok) return;
        const palette = this.palette;
        const shown = await this.call("command:dom:upsert-floating-element", {
            domId: HINT_ID,
            position: { x: (size.value.width - HINT_WIDTH) / 2, y: 72 },
            asPopover: false,
            barrierDismissible: true,
            schema: column(
                [
                    text(title, { color: palette.text, size: 13, weight: "semibold" }),
                    ...lines.map((line) => text(line, { color: palette.muted, size: 12 })),
                ],
                {
                    gap: 6,
                    width: px(HINT_WIDTH),
                    padding: px(14),
                    backgroundColor: palette.surface,
                    borderColor: palette.border,
                    borderWidth: px(1),
                    borderType: "solid",
                    borderRadius: px(10),
                    pointerEvents: "auto",
                },
            ),
        });
        if (!shown.ok) return;
        this.shownHint = key;
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => {
            this.shownHint = null;
            void this.call("command:dom:remove-floating-element", { domId: HINT_ID });
        }, HINT_MS);
    }
}
