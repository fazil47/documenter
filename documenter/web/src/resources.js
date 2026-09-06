const resources = {
  explanation: {
    kind: "explanation",
    label: "explanation",
    title: "Explanation",
    plural: "explanations",
    path: "explanations",
    memberApi: "/api/explanation",
    collectionApi: "/api/explanations",
    empty: "No explanations have been written for this module.",
    placeholder: "Request routing",
  },
  exploration: {
    kind: "exploration",
    label: "exploration",
    title: "Exploration",
    plural: "explorations",
    path: "explorations",
    memberApi: "/api/exploration",
    collectionApi: "/api/explorations",
    empty: "No explorations have been written for this module.",
    placeholder: "Alternative rendering model",
  },
};

export const markdownKinds = Object.keys(resources);

export function markdownResource(kind) {
  const resource = resources[kind];
  if (!resource) throw new Error(`Unknown Markdown resource kind: ${kind}`);
  return resource;
}

export function markdownResourceForPath(path) {
  return Object.values(resources).find((resource) => resource.path === path);
}
