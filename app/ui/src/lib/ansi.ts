/** A piece of text with the ANSI styles that apply to it. */
export interface AnsiSegment {
  text: string;
  /** A Tailwind text colour class, if a colour is set. */
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** SGR colour codes (30–37 normal, 90–97 bright) → Tailwind classes that work in both themes. */
const COLORS: Record<number, string> = {
  30: "text-muted-foreground",
  31: "text-red-500",
  32: "text-green-500",
  33: "text-yellow-500",
  34: "text-blue-500",
  35: "text-fuchsia-500",
  36: "text-cyan-500",
  37: "text-foreground",
  90: "text-muted-foreground",
  91: "text-red-400",
  92: "text-green-400",
  93: "text-yellow-400",
  94: "text-blue-400",
  95: "text-fuchsia-400",
  96: "text-cyan-400",
  97: "text-foreground",
};

// eslint-disable-next-line no-control-regex
const SEQUENCE = /\u001b\[([0-9;]*)([A-Za-z])/g;

/**
 * Splits text with ANSI escape sequences into styled segments. Colours, bold and dim are
 * kept; everything else (cursor movement, 256/true colour) is dropped.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style: Omit<AnsiSegment, "text"> = {};
  let last = 0;
  for (const match of text.matchAll(SEQUENCE)) {
    if (match.index > last) segments.push({ ...style, text: text.slice(last, match.index) });
    last = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = (match[1] ?? "").split(";").map((c) => (c === "" ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] ?? 0;
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 22) style = { ...style, bold: false, dim: false };
      else if (code === 39) style = { ...style, color: undefined };
      else if (COLORS[code]) style = { ...style, color: COLORS[code] };
      // 38;5;n and 38;2;r;g;b carry extra numbers: skip them.
      else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  if (last < text.length) segments.push({ ...style, text: text.slice(last) });
  return segments.filter((s) => s.text.length > 0);
}

/** Whether `text` contains ANSI escape sequences. */
export function hasAnsi(text: string): boolean {
  return text.includes("\u001b[");
}
