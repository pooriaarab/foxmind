// Builds extension/ into dist-ext/: esbuild bundles each script as an ES
// module, ONNX Runtime's WASM files go to dist-ext/ort/ (MV3 allows no remote
// code), and the other files are copied. It stops when the manifest version
// is not the package.json version, so AMO signs the version npm publishes.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

rmSync("dist-ext", { recursive: true, force: true });
const files = readdirSync("extension");
await build({
  entryPoints: files.filter((f) => f.endsWith(".js")).map((f) => `extension/${f}`),
  outdir: "dist-ext",
  bundle: true,
  format: "esm",
  target: "firefox153",
  logLevel: "warning",
});
for (const file of files.filter((f) => !f.endsWith(".js"))) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });

const transformers = realpathSync("node_modules/@huggingface/transformers");
const ort = join(dirname(dirname(transformers)), "onnxruntime-web", "dist");
mkdirSync("dist-ext/ort");
for (const file of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) cpSync(join(ort, file), join("dist-ext/ort", file));
console.log(`Built dist-ext/ (version ${pkg.version}).`);
