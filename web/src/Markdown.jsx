import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { apiUrl, routes } from "./api.js";

function render(text, module, explanation) {
  const sanitized = DOMPurify.sanitize(marked.parse(text || ""));
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    if (!source.includes(".documenter/drawings/")) continue;
    const filename = source.split("/").at(-1);
    if (!filename) continue;
    image.setAttribute("src", apiUrl("/api/drawing-file", { module, file: filename }));
    image.setAttribute("loading", "lazy");
    const link = document.createElement("a");
    link.className = "edit-drawing-link";
    link.href = routes.drawing(module, filename, { from: explanation });
    link.textContent = "Edit drawing";
    image.insertAdjacentElement("afterend", link);
  }
  return document.body.innerHTML;
}
export default function Markdown({ children, module = "", explanation = "" }) {
  const html = useMemo(
    () => render(children, module, explanation),
    [children, module, explanation],
  );
  return <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
