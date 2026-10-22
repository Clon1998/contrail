import { cn } from "cn";
import { hasAnsi, parseAnsi } from "@/lib/ansi";

/** Text with ANSI colour codes rendered as coloured spans. */
export function Ansi({ text }: { text: string }) {
  if (!hasAnsi(text)) return <>{text}</>;
  return (
    <>
      {parseAnsi(text).map((segment, i) => (
        <span
          key={i}
          className={cn(
            segment.color,
            segment.bold && "font-semibold",
            segment.dim && "opacity-60",
          )}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}
