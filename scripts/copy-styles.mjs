// Copies client/styles.css into dist/public. tsc only emits .ts files, so the stylesheet needs its own step.
// With --watch, copies again on every change (used by `npm run dev`).
import fs from "node:fs";

const from = "client/styles.css";
const to = "dist/public/styles.css";

const copy = () => {
  fs.mkdirSync("dist/public", { recursive: true });
  fs.copyFileSync(from, to);
};

copy();
if (process.argv.includes("--watch")) {
  fs.watchFile(from, { interval: 300 }, copy);
}
