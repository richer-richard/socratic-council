// Stage the OCR runtime so the packaged app never touches a CDN.
//
// tesseract.js's browser defaults fetch its worker, its WASM core and every
// language pack from cdn.jsdelivr.net at run time. Under the app's strict CSP
// (connect-src 'self') that fails silently, and even without the CSP it is an
// undisclosed third-party fetch. This script stages everything under
// apps/desktop/public/ (gitignored) so it ships inside the bundle:
//
//   public/tesseract/  worker.min.js + the SIMD LSTM core pair (from node_modules)
//   public/tessdata/   <lang>.traineddata.gz                 (downloaded once,
//                      SHA-256 pinned below; re-verified on every run)
//
// Run from apps/desktop (`pnpm prepare:ocr`); dev/build call it automatically.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..", "apps", "desktop");
const require = createRequire(join(desktopDir, "package.json"));
const publicDir = join(desktopDir, "public");
const coreOut = join(publicDir, "tesseract");
const langOut = join(publicDir, "tessdata");

// Same source tesseract.js itself uses for LSTM-only workers
// (`@tesseract.js-data/<lang>/4.0.0_best_int`), pinned by content hash.
const LANG_BASE = "https://cdn.jsdelivr.net/npm/@tesseract.js-data";
const LANGS = {
  eng: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
  chi_sim: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c",
  chi_tra: "11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743",
  jpn: "2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88",
  kor: "78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126",
  ara: "f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639",
  rus: "f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a",
  hin: "f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07",
  heb: "9c70b524200dae77fb25e3567566eee600ccbcae9aeb89722990ccae0e84e805",
};

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function stageCore() {
  await mkdir(coreOut, { recursive: true });
  const workerSrc = require.resolve("tesseract.js/dist/worker.min.js");
  await cp(workerSrc, join(coreOut, "worker.min.js"));
  // tesseract.js-core ships six core variants (~50 MB). The app pins ONE —
  // the WASM-SIMD LSTM build (every WKWebView / WebView2 / WebKitGTK the app
  // targets has WASM SIMD) — by pointing `corePath` at the .wasm.js file, whose
  // loader fetches its sibling .wasm. tesseract.js-core is tesseract.js's own
  // dependency (pnpm keeps it out of the app's node_modules), so resolve it
  // from tesseract.js's location.
  const tesseractDir = dirname(require.resolve("tesseract.js/package.json"));
  const requireFromTesseract = createRequire(join(tesseractDir, "package.json"));
  const coreDir = dirname(requireFromTesseract.resolve("tesseract.js-core/package.json"));
  for (const file of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm"]) {
    await cp(join(coreDir, file), join(coreOut, file));
  }
}

async function stageLang(lang, expected) {
  const target = join(langOut, `${lang}.traineddata.gz`);
  if (await exists(target)) {
    const current = sha256(await readFile(target));
    if (current === expected) return "cached";
    console.warn(`[ocr] ${lang}: on-disk hash mismatch, re-downloading`);
  }
  const url = `${LANG_BASE}/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[ocr] ${lang}: download failed (${res.status}) from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) {
    throw new Error(`[ocr] ${lang}: SHA-256 mismatch\n  expected ${expected}\n  got      ${got}`);
  }
  await writeFile(target, buf);
  return "downloaded";
}

async function main() {
  await stageCore();
  await mkdir(langOut, { recursive: true });
  const results = await Promise.all(
    Object.entries(LANGS).map(async ([lang, hash]) => [lang, await stageLang(lang, hash)]),
  );
  const downloaded = results.filter(([, r]) => r === "downloaded").map(([l]) => l);
  console.log(
    `[ocr] staged worker + core → public/tesseract, ${results.length} language packs → public/tessdata` +
      (downloaded.length ? ` (downloaded: ${downloaded.join(", ")})` : " (all cached)"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
