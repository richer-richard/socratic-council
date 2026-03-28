import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const sourceDir = resolve(rootDir, "website");
const outputDir = resolve(rootDir, "site-dist");

const assetCopies = [
  ["docs/assets/readme-app-icon-rounded.png", "assets/readme-app-icon-rounded.png"],
  ["docs/assets/experience-map.svg", "assets/experience-map.svg"],
  ["docs/assets/architecture-diagram.svg", "assets/architecture-diagram.svg"],
  ["docs/assets/conversation-loop.svg", "assets/conversation-loop.svg"],
  ["docs/assets/export-pipeline.svg", "assets/export-pipeline.svg"],
  ["docs/assets/first-build-profile.svg", "assets/first-build-profile.svg"],
  ["docs/assets/installation-paths.svg", "assets/installation-paths.svg"],
  ["docs/assets/manual-install-flow.svg", "assets/manual-install-flow.svg"],
];

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await cp(sourceDir, outputDir, { recursive: true });

  for (const [from, to] of assetCopies) {
    const targetDir = dirname(resolve(outputDir, to));
    await mkdir(targetDir, { recursive: true });
    await cp(resolve(rootDir, from), resolve(outputDir, to));
  }

  await writeFile(resolve(outputDir, ".nojekyll"), "");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
