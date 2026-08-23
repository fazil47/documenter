import { describe, expect, it } from "vitest";

import { suggestedFilename } from "./names.js";

describe("suggestedFilename", () => {
  it("handles words, acronyms, punctuation, and existing snake case", () => {
    expect(suggestedFilename("Request Routing")).toBe("request_routing");
    expect(suggestedFilename("HTTP Request Parser")).toBe("http_request_parser");
    expect(suggestedFilename("frame_loop")).toBe("frame_loop");
    expect(suggestedFilename("  State / Preview  ")).toBe("state_preview");
  });
});
