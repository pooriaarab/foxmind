// Builds the demo extension.
//   node scripts/build-ext.mjs                the release build AMO signs, in dist-ext/
//   node scripts/build-ext.mjs --e2e          the test build: adds extension/e2e/ops.js and content.js
//   node scripts/build-ext.mjs --out <dir>    build into another directory
// esbuild bundles each script as an ES module. ONNX Runtime's WASM files go
// to ort/ (MV3 allows no remote code). It stops when the manifest version is
// not the package.json version, so AMO signs the version npm publishes.
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const { values } = parseArgs({ options: { e2e: { type: "boolean", default: false }, out: { type: "string", default: "dist-ext" } } });
const out = values.out;
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}
// The content script on 127.0.0.1 exists only for tests.
if (!values.e2e) delete manifest.content_scripts;

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: ["background.js", "panel.js", ...(values.e2e ? ["content.js"] : [])].map((file) => `extension/${file}`),
  outdir: out,
  bundle: true,
  format: "esm",
  target: "firefox153",
  logLevel: "warning",
  define: { __E2E__: String(values.e2e) },
});
for (const file of ["panel.html", "panel.css"]) cpSync(`extension/${file}`, join(out, file));
cpSync("extension/icons", join(out, "icons"), { recursive: true });
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const transformers = realpathSync("node_modules/@huggingface/transformers");
const ort = join(dirname(dirname(transformers)), "onnxruntime-web", "dist");
mkdirSync(join(out, "ort"));
for (const file of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) cpSync(join(ort, file), join(out, "ort", file));
console.log(`Built ${out}/ (version ${pkg.version}${values.e2e ? ", e2e build" : ""}).`);
