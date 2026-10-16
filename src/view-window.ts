import type { DomElementSchema } from "@drawdy/driver-protocol";
import { button, column, iframe, px, row, text, type Palette } from "./dom-schema";

export const VIEW_ID = "paper-stage-view";
export const CLOSE_ID = "paper-stage-close";
const HEADER = 40;
const SHARE = 0.8;

export type ViewLayout = { position: { x: number; y: number }; width: number; height: number };

export function viewLayout(window: { width: number; height: number }): ViewLayout {
    const width = Math.round(window.width * SHARE);
    const height = Math.round(window.height * SHARE);
    return {
        position: { x: Math.round((window.width - width) / 2), y: Math.round((window.height - height) / 2) },
        width,
        height,
    };
}

export function viewSchema(srcDoc: string, layout: ViewLayout, palette: Palette): DomElementSchema {
    const box = (child: DomElementSchema): DomElementSchema => ({
        type: "box",
        children: [child],
        styles: { padding: px(10) },
    });
    return column(
        [
            row(
                [
                    box(text("Paper Stage", { color: palette.text, size: 13, weight: "semibold" })),
                    box(
                        button(CLOSE_ID, [text("Close", { color: palette.text, size: 12, weight: "medium" })], {
                            padding: px(6),
                            borderRadius: px(6),
                            cursor: "pointer",
                            hover: { backgroundColor: palette.hover },
                        }),
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
