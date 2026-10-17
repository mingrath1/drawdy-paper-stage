import type { DomElementSchema } from "@drawdy/driver-protocol";
import { button, column, iframe, px, row, text, type Palette } from "./dom-schema";

export const VIEW_ID = "paper-stage-view";
export const CLOSE_ID = "paper-stage-close";
export const RESIZE_ID = "paper-stage-resize";
const HEADER = 40;

/** Docked sits at the left beside the board so both stay in reach; large covers most of the window. */
export type ViewMode = "docked" | "large";
export type ViewLayout = { position: { x: number; y: number }; width: number; height: number };
type WindowSize = { width: number; height: number };

// Drawdy's selection panel spans x 12 to 193, as measured on the board, and the dock sits clear of it.
const DOCK = { left: 209, top: 64, bottom: 64, side: 16, share: 0.44, minWidth: 420, maxWidth: 900, minHeight: 240 };
const LARGE_SHARE = 0.8;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const LAYOUTS: Record<ViewMode, (window: WindowSize) => ViewLayout> = {
    // The top margin clears Drawdy's toolbar and the bottom one its zoom bar.
    docked: (window) => ({
        position: { x: DOCK.left, y: DOCK.top },
        width: Math.round(
            Math.min(
                clamp(window.width * DOCK.share, DOCK.minWidth, DOCK.maxWidth),
                window.width - DOCK.left - DOCK.side,
            ),
        ),
        height: Math.max(window.height - DOCK.top - DOCK.bottom, DOCK.minHeight),
    }),
    large: (window) => {
        const width = Math.round(window.width * LARGE_SHARE);
        const height = Math.round(window.height * LARGE_SHARE);
        return {
            position: { x: Math.round((window.width - width) / 2), y: Math.round((window.height - height) / 2) },
            width,
            height,
        };
    },
};

export function viewLayout(window: WindowSize, mode: ViewMode): ViewLayout {
    return LAYOUTS[mode](window);
}

export const otherMode = (mode: ViewMode): ViewMode => (mode === "docked" ? "large" : "docked");

export function viewSchema(srcDoc: string, mode: ViewMode, layout: ViewLayout, palette: Palette): DomElementSchema {
    const box = (child: DomElementSchema): DomElementSchema => ({
        type: "box",
        children: [child],
        styles: { padding: px(10) },
    });
    const headerButton = (domId: string, label: string) =>
        button(domId, [text(label, { color: palette.text, size: 12, weight: "medium" })], {
            padding: px(6),
            borderRadius: px(6),
            cursor: "pointer",
            hover: { backgroundColor: palette.hover },
        });
    return column(
        [
            row(
                [
                    box(text("Paper Stage", { color: palette.text, size: 13, weight: "semibold" })),
                    box(
                        row(
                            [
                                headerButton(RESIZE_ID, mode === "docked" ? "Expand" : "Dock"),
                                headerButton(CLOSE_ID, "Close"),
                            ],
                            {
                                gap: 4,
                            },
                        ),
                    ),
                ],
                { align: "between", width: px(layout.width), height: px(HEADER) },
            ),
            iframe(srcDoc, layout.width, layout.height - HEADER),
        ],
        {
            width: px(layout.width),
            height: px(layout.height),
            backgroundColor: palette.surface,
            borderColor: palette.border,
            borderWidth: px(1),
            borderType: "solid",
            borderRadius: px(12),
            overflow: "hidden",
            pointerEvents: "auto",
        },
    );
}
