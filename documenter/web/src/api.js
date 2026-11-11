const params = new URLSearchParams(window.location.search);

export const token = params.get("token") || "";

export function apiUrl(path, values = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export async function api(path, options = {}, values = {}) {
  const response = await fetch(apiUrl(path, values), {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function href(path, values = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(values)) {
    if (value || value === 0) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

export const routes = {
  graph: () => href("/"),
  module: (module) => href(`/modules/${encodeURIComponent(module)}`),
  code: (module, values = {}) => href(`/code/${encodeURIComponent(module)}`, values),
  note: (module, file) =>
    href(`/notes/${encodeURIComponent(module)}/${encodeURIComponent(file)}`),
  drawing: (module, file, values = {}) =>
    href(`/drawings/${encodeURIComponent(module)}/${encodeURIComponent(file)}`, values),
};
