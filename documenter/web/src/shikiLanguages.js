// Replaces `shiki/langs` (see vite.config.js): source pages only show Rust and
// JavaScript modules, so the build ships those grammars instead of every Shiki
// language.
export const bundledLanguages = {
  rust: () => import("@shikijs/langs/rust"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
};
