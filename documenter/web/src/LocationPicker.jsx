import { useEffect, useMemo, useRef, useState } from "react";

// Helix-style picker for navigation results: type to filter, arrows or C-n/C-p
// to move, Enter to open, Esc to close. Keys never reach the editor while open.
export default function LocationPicker({ title, locations, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() => Math.max(0, locations.findIndex((location) => location.module)));
  const list = useRef(null);
  const visible = useMemo(() => {
    const needle = query.toLowerCase();
    return locations.filter((location) => `${location.path} ${location.preview}`.toLowerCase().includes(needle));
  }, [locations, query]);

  useEffect(() => {
    const keydown = (event) => {
      if (event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const key = event.key;
      // Moves to the next location that can be opened, skipping ones outside the workspace.
      const step = (direction) => setIndex((current) => {
        for (let offset = 1; offset <= visible.length; offset += 1) {
          const next = (((current + direction * offset) % visible.length) + visible.length) % visible.length;
          if (visible[next].module) return next;
        }
        return current;
      });
      if (key === "Escape" || (event.ctrlKey && key === "c")) onClose();
      else if (key === "Enter") {
        if (visible[index]) onPick(visible[index]);
      } else if (key === "ArrowDown" || (event.ctrlKey && key === "n") || (key === "Tab" && !event.shiftKey)) {
        step(1);
      } else if (key === "ArrowUp" || (event.ctrlKey && key === "p") || (key === "Tab" && event.shiftKey)) {
        step(-1);
      } else if (key === "Backspace") {
        setQuery((current) => current.slice(0, -1));
        setIndex(0);
      } else if (key.length === 1 && !event.ctrlKey && !event.altKey) {
        setQuery((current) => current + key);
        setIndex(0);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [visible, index, onPick, onClose]);

  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal picker" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="picker-header">
          <h2>{title}</h2>
          <span className="picker-query">{query}<span className="helix-prompt-cursor" /></span>
          <span className="picker-count">{visible.length}/{locations.length}</span>
        </header>
        <ul ref={list} className="picker-list">
          {visible.map((location, position) => (
            <li key={`${location.path}:${location.line}:${location.character}`}>
              <button
                type="button"
                className={position === index ? "selected" : ""}
                disabled={!location.module}
                title={location.module ? undefined : "Outside the workspace modules"}
                onClick={() => onPick(location)}
              >
                <code>{location.path}:{location.line + 1}</code>
                <span>{location.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
