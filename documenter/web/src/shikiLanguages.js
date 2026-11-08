// Replaces `shiki/langs` (see vite.config.js): source pages only show Rust
// modules, so the build ships the Rust grammar instead of every Shiki language.
export const bundledLanguages = {
  rust: () => import("@shikijs/langs/rust"),
};
