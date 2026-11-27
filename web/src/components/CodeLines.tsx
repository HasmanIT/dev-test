interface Props {
  code: string;
  selected?: number | null;
  correct?: number | null;
  onSelect?: (line: number) => void;
  label?: string;
}

/** A code snippet whose lines can be clicked: used by bug-hunt questions (taker and admin). */
export function CodeLines({ code, selected, correct, onSelect, label = "Click the line with the bug" }: Props) {
  const lines = code.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <div className="code" role="listbox" aria-label={label}>
      {lines.map((text, i) => {
        const n = i + 1;
        const cls = ["code-line", selected === n ? "is-selected" : "", correct === n ? "is-correct" : "", onSelect ? "is-clickable" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            type="button"
            key={n}
            className={cls}
            role="option"
            aria-selected={selected === n}
            disabled={!onSelect}
            onClick={() => onSelect?.(n)}
          >
            <span className="code-no">{n}</span>
            <span className="code-text">{text || " "}</span>
          </button>
        );
      })}
    </div>
  );
}
