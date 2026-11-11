import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { apiUrl, routes } from "./api.js";

// Drawings sit beside the note that embeds them, so their links are bare `name.svg` filenames.
const DRAWING = /^[\w-]+\.svg$/i;

function render(text, module, markdownDocument) {
  const sanitized = DOMPurify.sanitize(marked.parse(text || ""));
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    // Module docs render without a note, so their images are left alone.
    if (!markdownDocument || !DRAWING.test(source)) continue;
    image.setAttribute("src", apiUrl("/api/drawing-file", { module, file: source }));
    image.setAttribute("loading", "lazy");
    const link = document.createElement("a");
    link.className = "edit-drawing-link";
    link.href = routes.drawing(module, source, { from: markdownDocument });
    link.textContent = "Edit drawing";
    image.insertAdjacentElement("afterend", link);
  }
  return document.body.innerHTML;
}

export default function Markdown({ children, module = "", document = "" }) {
  const html = useMemo(() => render(children, module, document), [children, module, document]);
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
