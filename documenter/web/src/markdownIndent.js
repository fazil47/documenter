const indent = "    ";

// Return the edited text and selection together so indenting preserves the caret.
export function indentMarkdown(value, start, end, outdent = false) {
  if (!outdent && start === end) {
    return { value: value.slice(0, start) + indent + value.slice(end), start: start + indent.length, end: end + indent.length };
  }

  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the next line's start does not include that line.
  const selectionEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextNewline = value.indexOf("\n", selectionEnd);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  let offset = lineStart;
  let startDelta = 0;
  let endDelta = 0;
  const replacement = value.slice(lineStart, lineEnd).split("\n").map((line) => {
    const removed = outdent ? (line.match(/^(\t| {1,4})/)?.[0].length ?? 0) : 0;
    startDelta += outdent ? -Math.min(removed, Math.max(0, start - offset)) : offset <= start ? indent.length : 0;
    endDelta += outdent ? -Math.min(removed, Math.max(0, end - offset)) : indent.length;
    offset += line.length + 1;
    return outdent ? line.slice(removed) : indent + line;
  }).join("\n");

  return {
    value: value.slice(0, lineStart) + replacement + value.slice(lineEnd),
    start: start + startDelta,
    end: end + endDelta,
  };
}
