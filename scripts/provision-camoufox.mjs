// Copies the installed Camoufox browser into browser-dist/camoufox so it can be
// bundled (extraResources -> resources/browsers). Run AFTER `npx camoufox fetch`.
// Works on Linux/Windows/macOS because it asks the package for INSTALL_DIR.
import fs from "node:fs";
import path from "node:path";

const dest = path.resolve("browser-dist", "camoufox");

let pkg;
try {
  pkg = await import("@camoufox/camoufox");
} catch (err) {
  console.error("cannot import @camoufox/camoufox:", err.message);
  process.exit(1);
}

const src = pkg.INSTALL_DIR;
if (!src || !fs.existsSync(src)) {
  console.error(`camoufox not installed at ${src}. Run: npx camoufox fetch`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true, dereference: true });

function sizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

console.log(`copied camoufox: ${src} -> ${dest} (${(sizeBytes(dest) / 1048576).toFixed(0)} MB)`);
