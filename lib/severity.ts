/**
 * The one severity scale.
 *
 * Severity decides what a user looks at first, so it has to mean the same thing
 * everywhere. It did not. Five separate palettes had grown up across the app,
 * and two of them were broken outright:
 *
 *   conflicts list + briefing   high #bd7c0f  medium #b8760b  low #1f9d57
 *   conflict detail + home      high #e0464b  medium #e8890c  low #3da1f2
 *   share pages                 high #d83a3f  medium #9a6b12  low #2f6ad0
 *
 * In the first, High and Medium differed by (5, 6, 4) out of 255 per channel —
 * indistinguishable on any display, which made the severity filter useless as a
 * visual signal. And a High conflict was amber in the list but red on its own
 * page, so the palette taught nothing and severity had to be re-read as text.
 *
 * Three rules the scale follows now:
 *
 *   Red, amber, slate — steps far enough apart to read at a glance.
 *   Low is NOT green. Green means resolved; a low-severity conflict is still two
 *   teams contradicting each other, and colouring it green says "fine".
 *   Low is NOT blue either. Blue is the brand accent, and semantic colour must
 *   not borrow from it.
 *
 * Every pair passes WCAG AA on its own tint and on white — verified, not
 * eyeballed: 4.76:1, 5.60:1 and 6.79:1 on tint respectively.
 */

export type Severity = "high" | "medium" | "low";

/** Worst first, for sorting. */
export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export type SeverityTone = {
  label: string;
  /** Longer label, where there is room for it. */
  longLabel: string;
  /** Foreground, for text and icons. */
  text: string;
  /** The tint the foreground is designed to sit on. */
  bg: string;
  border: string;
  /** For a filled dot or bar, where no text sits on it. */
  solid: string;
  /** Slack has no CSS, so Fresh Brew and alerts carry the scale as emoji. */
  emoji: string;
};

export const SEVERITY: Record<Severity, SeverityTone> = {
  high: {
    label: "High",
    longLabel: "High severity",
    text: "#c62f35",
    bg: "#fdecec",
    border: "#f3c9cb",
    solid: "#d83a3f",
    emoji: "🔴",
  },
  medium: {
    label: "Medium",
    longLabel: "Medium severity",
    // Moved off #8a5606 / #fdf3e3 / #f0d8a8, which were a brown-amber at 23°
    // — close enough to the clay at 27° that a Medium chip and a clay mark on
    // the same card were 37 apart on the metric this file's own test calls
    // "can you tell these apart", where the bar is 40. The two meant entirely
    // different things: one is how bad, the other is what collides.
    //
    // This is a true yellow-amber at 46°, which is also where the tone's own
    // `solid` always was — the text was browner than the dot it shipped with.
    text: "#856600",
    bg: "#fef7e1",
    border: "#f7e8b6",
    solid: "#c79b0a",
    emoji: "🟠",
  },
  low: {
    label: "Low",
    longLabel: "Low severity",
    text: "#4a5566",
    bg: "#f1f3f7",
    border: "#dde1e9",
    solid: "#6b7686",
    emoji: "⚪",
  },
};

/** Narrows whatever the database returned, defaulting to the least alarming. */
export function severityOf(value: string | null | undefined): Severity {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

/** The tone for a raw severity value. */
export function severityTone(value: string | null | undefined): SeverityTone {
  return SEVERITY[severityOf(value)];
}

/** Sort comparator, worst first. */
export function bySeverity(a: string | null | undefined, b: string | null | undefined): number {
  return SEVERITY_ORDER[severityOf(a)] - SEVERITY_ORDER[severityOf(b)];
}
