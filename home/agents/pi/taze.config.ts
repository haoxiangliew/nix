import { defineConfig } from "taze";

export default defineConfig({
  mode: "default",
  interactive: true,
  includeLocked: true,
  packageMode: {
    "/.*/": "major",
  },
});
