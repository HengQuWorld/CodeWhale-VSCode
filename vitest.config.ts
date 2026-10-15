import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // `vscode` does not exist at runtime — the extension host provides it.
      // Point it at the double every suite used to build inline with
      // `vi.mock("vscode", ...)`, which could not be shared because factories
      // are hoisted per file. A suite that must adjust a default does so on
      // `vscodeState` in its own setup, not by rebuilding the module.
      { find: /^vscode$/, replacement: path.resolve(__dirname, "src/chat-provider/vscode-double.ts") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
