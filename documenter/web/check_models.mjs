// Model-checks every Quint state model in the crate: each `quint/*.qnt` file
// beside a module defines `invariant`, which random runs must never violate.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const source = new URL("../src", import.meta.url).pathname;
const models = readdirSync(source, { recursive: true })
  .filter((path) => /(^|\/)quint\/[^/]+\.qnt$/.test(path))
  .map((path) => join(source, path))
  .sort();
for (const model of models) {
  console.log(`checking ${relative(process.cwd(), model)}`);
  execFileSync("npx", ["--no-install", "quint", "run", model, "--invariant=invariant", "--max-steps=30", "--max-samples=50000", "--verbosity=1"], { stdio: "inherit" });
}
