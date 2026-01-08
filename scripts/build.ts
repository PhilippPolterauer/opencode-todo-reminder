import { build } from "bun";

await build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    target: "bun",
    format: "esm",
    external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
});

console.log("Built to dist/index.js");
