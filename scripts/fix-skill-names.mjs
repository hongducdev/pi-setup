// Makes skill frontmatter names Pi/Agent-Skills compliant (lowercase a-z, 0-9, hyphens). Re-run after reinstalling a skill kit.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const dirs = [join(homedir(), ".agents", "skills"), join(homedir(), ".pi", "agent", "skills")];
const fix = (n) => n.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
let changed = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const m = text.match(/^(---\r?\n[\s\S]*?^name:[ \t]*)(["']?)([^\r\n"']+)\2([ \t]*\r?$)/m);
    if (!m) continue;
    const name = m[3].trim();
    const fixed = fix(name);
    if (fixed && fixed !== name) {
      writeFileSync(file, text.replace(m[0], `${m[1]}${fixed}${m[4]}`));
      console.log(`${name} -> ${fixed}`);
      changed++;
    }
  }
}
console.log(`renamed: ${changed}`);