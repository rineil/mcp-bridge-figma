import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, "plugin", "main.ts")],
  bundle: true,
  outfile: join(__dirname, "plugin", "dist", "code.js"),
  platform: "browser",
  target: "es2018",
  format: "iife",
  logLevel: "info",
});
