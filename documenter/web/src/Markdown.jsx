import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { apiUrl, routes } from "./api.js";

function render(text, module, markdownDocument, kind) {
  const sanitized = DOMPurify.sanitize(marked.parse(text || ""));
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    const drawingKind = source.includes(".documenter/exploration_drawings/")
      ? "exploration"
      : source.includes(".documenter/drawings/") ? "explanation" : null;
    if (!drawingKind) continue;
    const filename = source.split("/").at(-1);
    if (!filename) continue;
    image.setAttribute("src", apiUrl("/api/drawing-file", {
      module,
      file: filename,
      kind: drawingKind,
    }));
    image.setAttribute("loading", "lazy");
    const link = document.createElement("a");
    link.className = "edit-drawing-link";
    link.href = routes.drawing(module, filename, {
      from: markdownDocument,
      kind,
      drawingKind,
    });
    link.textContent = "Edit drawing";
    image.insertAdjacentElement("afterend", link);
  }
  return document.body.innerHTML;
}
export default function Markdown({ children, module = "", document = "", kind = "explanation" }) {
  const html = useMemo(
    () => render(children, module, document, kind),
    [children, module, document, kind],
  );
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
