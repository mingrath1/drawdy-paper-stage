import type {
    Dimension,
    DomElementSchema,
    ElementSchemaStyles,
    FontWeight,
    ModuleStyling,
} from "@drawdy/driver-protocol";

export type Palette = { text: string; muted: string; surface: string; border: string; hover: string };

/** Theme colors for driver UI. Newer hosts send `--dd-*` tokens, which the published types do not declare yet. */
export function paletteOf(styling: ModuleStyling): Palette {
    const tokens: Partial<Record<string, string>> = (styling as { tokens?: Record<string, string> }).tokens ?? {};
    return {
        text: tokens["--dd-text-primary"] ?? styling.foreground,
        muted: tokens["--dd-text-secondary"] ?? styling.mutedForeground,
        surface: tokens["--dd-surface-panel"] ?? styling.surface,
        border: tokens["--dd-border-medium"] ?? styling.border,
        hover: tokens["--dd-interaction-hover"] ?? styling.surface2,
    };
}

// Drawdy never answers a command whose schema it cannot parse, so every number goes through px().
export function px(value: number): Dimension {
    return [Number.isFinite(value) ? Math.round(value) : 0, "px"];
}

type TextStyle = { color?: string; size?: number; weight?: FontWeight };

export function text(child: string, style: TextStyle = {}): DomElementSchema {
    return {
        type: "text",
        child,
        styles: {
            fontSize: px(style.size ?? 12),
            ...(style.color ? { color: style.color } : {}),
            ...(style.weight ? { fontWeight: style.weight } : {}),
        },
    };
}

type StackStyle = ElementSchemaStyles & { gap?: number; align?: "between" | "start" | "center" | "end" };

function stack(
    type: "column" | "row",
    children: DomElementSchema[],
    { gap, align, ...styles }: StackStyle,
): DomElementSchema {
    return {
        type,
        children,
        styles: {
            ...styles,
            ...(gap === undefined ? {} : { gap: Math.round(gap) }),
            ...(align ? { mainAxisAlignment: align, crossAxisAlignment: "center" } : {}),
        },
    };
}

export function column(children: DomElementSchema[], styles: StackStyle = {}): DomElementSchema {
    return stack("column", children, styles);
}

export function row(children: DomElementSchema[], styles: StackStyle = {}): DomElementSchema {
    return stack("row", children, styles);
}

export function button(
    domId: string,
    children: DomElementSchema[],
    styles: ElementSchemaStyles = {},
): DomElementSchema {
    return { type: "button", domId, children, styles };
}

export function iframe(srcDoc: string, width: number, height: number): DomElementSchema {
    return {
        type: "iframe",
        child: { srcDoc },
        styles: { width: px(width), height: px(height), pointerEvents: "auto" },
    };
}
