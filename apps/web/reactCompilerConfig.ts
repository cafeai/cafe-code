import type babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";

/**
 * Vite also transforms TypeScript imported from the shared workspaces. Babel
 * must therefore parse TypeScript explicitly instead of depending on the web
 * workspace's TSX transform. Babel 8 treats JSX grammar strictly: enabling it
 * for plain .ts files misinterprets generic arrows such as <A>(value: A).
 * Select JSX by filename while retaining the existing React compiler preset.
 * Keep these options shared with the compatibility fixture so an upgrade cannot
 * accidentally restore a parser configuration that fails only in production.
 */
export const reactCompilerConfig = {
  parserOpts: { plugins: ["typescript"] },
  overrides: [{ include: /\.[jt]sx$/, parserOpts: { plugins: ["typescript", "jsx"] } }],
  presets: [reactCompilerPreset()],
} satisfies NonNullable<Parameters<typeof babel>[0]>;
