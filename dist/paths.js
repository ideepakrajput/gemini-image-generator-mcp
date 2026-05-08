import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Parent of `dist/` — npm package root when running compiled output. */
export const PACKAGE_ROOT = join(__dirname, "..");
export function packageJsonVersion() {
    try {
        const raw = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8");
        const v = JSON.parse(raw).version;
        return typeof v === "string" && v.length > 0 ? v : "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
