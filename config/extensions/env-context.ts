/**
 * env-context.ts - make Pi's shell commands fit this machine and the current project.
 *
 * (a) Context: before_agent_start appends a compact block (<~40 lines) to the system prompt:
 *     shell facts (which PowerShell, Git Bash vs WSL, missing unix tools), where tools live
 *     (Windows vs WSL, pio in ~/.platformio/penv/bin), per-project recipes detected from cwd
 *     (platformio.ini, package.json + lockfile, Cargo, CMake, Flutter, Tauri, Go, Python, .NET)
 *     and the top learned fixes. The block is deterministic so it stays prompt-cache friendly.
 * (b) Guard: tool_call blocks clearly wrong shell commands with a precise corrective reason
 *     (bash-isms in PowerShell, missing unix tools, Select-String -Recurse, `&&` on PS 5.1,
 *     plain `wsl ... bash -c '$VAR'`, `pio run` on Windows in a WSL-built project, the wrong
 *     package manager, wsl from Git Bash). Never rewrites. Add `# envctx:allow` to bypass.
 * (c) Learning: a failed shell call (not recognized / command not found / parser / parameter
 *     errors) followed by a successful similar call is stored in env-context-learned.json.
 * (d) /envctx [refresh|learned|forget <n>|all|guard on|off].
 * Probes run async after startup (cached 24h in env-context-cache.json); never block startup.
 * No network, no secrets (learned commands are redacted and truncated).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const DIR = process.env.ENV_CONTEXT_DIR || join(homedir(), ".pi", "agent");
const CACHE = join(DIR, "env-context-cache.json"), LEARNED = join(DIR, "env-context-learned.json"), SETTINGS = join(DIR, "env-context.json");
const DAY = 24 * 3600_000;
const ALLOW = /#\s*envctx:allow/i;
const WIN_TOOLS = ["git", "gh", "node", "npm", "pnpm", "yarn", "bun", "python", "py", "uv", "cargo", "flutter", "cmake", "ninja", "pio", "dotnet", "go", "java", "make", "docker"];
const UNIX_ONLY: Record<string, string> = {
	uname: "[Environment]::OSVersion / $IsWindows", which: "Get-Command <name>", head: "Select-Object -First N", tail: "Select-Object -Last N (files: Get-Content f -Tail N)",
	grep: "Select-String (or `git grep -n`)", sed: "-replace, e.g. (Get-Content f) -replace 'a','b'", awk: "ForEach-Object / -split", wc: "Measure-Object -Line",
	xargs: "ForEach-Object", touch: "New-Item -ItemType File -Force", sh: "the powershell tool, or wsl -d <distro> -e bash -lc '...'",
	rg: "`git grep -n` or Select-String", jq: "ConvertFrom-Json", fd: "Get-ChildItem -Recurse -Filter",
};

export type Probe = { at: number; os: string; psExe: string; psVersion: string; gitBash: string; win: Record<string, boolean>; python: string;
	wsl: { distros: string[]; def: string; tools: Record<string, string>; pio: string } };
export type Project = { root: string; kinds: string[]; lines: string[]; pm?: string; pio?: boolean };
type Learned = { key: string; bad: string; good: string; err: string; n: number; last: number };

// ---------- helpers ----------
const redact = (s: string) => s.replace(/(sk-|ghp_|gho_|github_pat_|AIza|xox[bp]-)[\w-]{6,}/g, "$1***")
	.replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1***");
const short = (s: string, n = 110) => { const t = redact(s.replace(/\s+/g, " ").trim()); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const readJson = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const writeJson = (p: string, v: unknown) => { try { writeFileSync(p, JSON.stringify(v, null, 1)); } catch { /* ignore */ } };
const run = (file: string, args: string[], input?: string, timeout = 8000) => new Promise<string>((res) => {
	try {
		const p = spawn(file, args, { windowsHide: true });
		let out = ""; const t = setTimeout(() => { try { p.kill(); } catch { /* */ } res(out); }, timeout);
		p.stdout?.on("data", (d) => (out += d)); p.stderr?.on("data", () => {});
		p.on("error", () => { clearTimeout(t); res(""); }); p.on("close", () => { clearTimeout(t); res(out); });
		p.stdin?.on("error", () => {}); if (input !== undefined) p.stdin?.end(input); else p.stdin?.end();
	} catch { res(""); }
});
function onPath(name: string): string {
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
	for (const d of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) for (const e of exts) {
		try { if (d && existsSync(join(d, name + e))) return join(d, name + e); } catch { /* */ }
	}
	return "";
}
/** Remove quoted strings / here-strings so checks only see the shell-level syntax. */
export function stripQuoted(cmd: string): string {
	return cmd.replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, "''").replace(/'[^'\n]*'/g, "''").replace(/"(?:[^"`\n]|`.)*"/g, "''");
}
/** Words in command position (start of each pipeline/statement segment). */
export function commandWords(cmd: string): string[] {
	return stripQuoted(cmd).split(/[;|&\n(){}]+/).map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
}
/** Directory the command works in: a leading `cd X` / Set-Location, else cwd. */
export function workDir(cmd: string, cwd: string): string {
	const m = cmd.match(/^\s*(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/i);
	const p = m?.[1]?.replace(/^["']|["']$/g, "");
	if (!p) return cwd;
	if (/^\/[a-z]\//i.test(p)) return `${p[1].toUpperCase()}:\\${p.slice(3)}`; // Git Bash /d/x
	return /^[A-Za-z]:[\\/]/.test(p) ? p : resolve(cwd, p);
}
const toWsl = (p: string) => p.replace(/^([A-Za-z]):[\\/]?/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/").replace(/\/+$/, "");

// ---------- probing ----------
export async function probeEnv(): Promise<Probe> {
	const win: Record<string, boolean> = {};
	for (const t of WIN_TOOLS) win[t] = !!onPath(t);
	for (const t of Object.keys(UNIX_ONLY)) win[t] = !!onPath(t);
	const pwsh = onPath("pwsh"), psExe = pwsh ? "pwsh" : "powershell";
	const [psv, pyv, reg] = await Promise.all([
		run(pwsh || "powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], undefined, 8000),
		win.python ? run("python", ["--version"], undefined, 5000) : Promise.resolve(""),
		process.platform === "win32" ? run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s"], undefined, 5000) : Promise.resolve(""),
	]);
	const gitBash = ["ProgramFiles", "ProgramFiles(x86)"].map((v) => join(process.env[v] ?? "", "Git", "bin", "bash.exe")).find((p) => existsSync(p)) ?? "";
	const wsl = { distros: [] as string[], def: "", tools: {} as Record<string, string>, pio: "" };
	const defGuid = reg.match(/DefaultDistribution\s+REG_SZ\s+(\S+)/)?.[1];
	for (const blk of reg.split(/\r?\n(?=HKEY_)/)) {
		const name = blk.match(/DistributionName\s+REG_SZ\s+(.+)/)?.[1]?.trim();
		if (name && !/^docker-desktop/.test(name)) { wsl.distros.push(name); if (defGuid && blk.split(/\r?\n/)[0].includes(defGuid)) wsl.def = name; }
	}
	wsl.def ||= wsl.distros[0] ?? "";
	if (wsl.def) {
		const script = "for t in python3 gcc g++ make cmake git node rg jq pio; do printf '%s=%s\\n' \"$t\" \"$(command -v $t || echo -)\"; done\n" +
			"[ -x ~/.platformio/penv/bin/pio ] && echo PIO=$HOME/.platformio/penv/bin/pio\nexit 0\n";
		const out = (await run("wsl.exe", ["-d", wsl.def, "-e", "bash", "-s"], script, 20000)).replace(/\0/g, "");
		for (const m of out.matchAll(/^([\w+]+)=(.*)$/gm)) if (m[1] !== "PIO") wsl.tools[m[1]] = m[2].trim() === "-" ? "" : m[2].trim();
		wsl.pio = out.match(/^PIO=(.+)$/m)?.[1]?.trim().replace(/^\/home\/[^/]+|^\/root/, "~") ?? "";
	}
	return { at: Date.now(), os: process.platform, psExe, psVersion: psv.trim(), gitBash, win, python: pyv.trim().replace(/^Python\s*/, ""), wsl };
}

// ---------- project detection ----------
export function detectProject(cwd: string, probe?: Probe): Project | undefined {
	let dir = cwd;
	for (let i = 0; i < 5 && dir; i++) {
		const has = (f: string) => { try { return existsSync(join(dir, f)); } catch { return false; } };
		const kinds: string[] = [], lines: string[] = [];
		let pm: string | undefined, pio = false;
		const distro = probe?.wsl.def || "Ubuntu", w = toWsl(dir);
		if (has("platformio.ini")) {
			pio = true; kinds.push("PlatformIO");
			const ini = (() => { try { return readFileSync(join(dir, "platformio.ini"), "utf8"); } catch { return ""; } })();
			const envs = [...ini.matchAll(/^\[env:([^\]]+)\]/gm)].map((m) => m[1]);
			const def = ini.match(/^default_envs\s*=\s*([^\s,;]+)/m)?.[1] ?? envs[0] ?? "default";
			if (envs.length) lines.push(`- envs: ${envs.slice(0, 8).join(", ")}${envs.length > 8 ? ", …" : ""} (default: ${def})`);
			if (!probe || probe.wsl.pio) lines.push(
				"- Build in WSL (powershell tool), streamed so live-log can tail it, tool timeout 3600:",
				`  \`wsl -d ${distro} -e bash -lc 'export PATH="$HOME/.platformio/penv/bin:$PATH"; cd ${w} && pio run -e ${def} 2>&1 | tee /tmp/pio-build.log; exit \${PIPESTATUS[0]}'\``,
				"- Same pattern for `pio test -e <env>` / `pio check`; do not run pio from Windows here.");
			else lines.push("- Build: `pio run -e " + def + " 2>&1 | Tee-Object pio-build.log` (tool timeout 3600)");
		}
		if (has("package.json")) {
			const pkg = readJson<any>(join(dir, "package.json"), {});
			pm = String(pkg.packageManager ?? "").split("@")[0] || (has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm");
			kinds.push(`Node (${pm})`);
			const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 10);
			lines.push(`- Use ${pm} only (lockfile).${scripts.length ? ` Scripts: ${scripts.join(", ")} → \`${pm} run <name>\`` : ""}`);
		}
		if (has("src-tauri")) { kinds.push("Tauri"); lines.push(`- Tauri: \`${pm ?? "npm"} run tauri dev\`; Rust tests: \`cargo test --manifest-path src-tauri/Cargo.toml\``); }
		else if (has("Cargo.toml")) { kinds.push("Rust"); lines.push("- Rust: `cargo build` / `cargo test` (Windows cargo)"); }
		if (has("pubspec.yaml")) { kinds.push("Flutter"); lines.push("- Flutter (Windows): `flutter analyze`, `flutter test`, `flutter build apk`"); }
		if (has("CMakeLists.txt") && !pio) { kinds.push("CMake"); lines.push("- CMake: `cmake -S . -B build; cmake --build build`"); }
		if (has("go.mod")) { kinds.push("Go"); lines.push("- Go: `go build ./...`, `go test ./...`"); }
		if (has("pyproject.toml") || has("requirements.txt")) { kinds.push("Python"); lines.push(`- Python: ${has("uv.lock") ? "`uv run ...`" : "`python -m ...`"}; set \`$env:PYTHONIOENCODING='utf-8'\` first`); }
		try { if (readdirSync(dir).some((f) => /\.(sln|csproj)$/i.test(f))) { kinds.push(".NET"); lines.push("- .NET: `dotnet build`, `dotnet test`"); } } catch { /* */ }
		if (kinds.length) return { root: dir, kinds, lines, pm, pio };
		const up = dirname(dir); if (up === dir) break; dir = up;
	}
	return undefined;
}

// ---------- context block ----------
export function renderContext(p: Probe | undefined, proj: Project | undefined, learned: Learned[]): string {
	const L: string[] = ["## Shell environment (env-context: follow this to avoid failing commands)"];
	const ps7 = !p || p.psExe === "pwsh";
	L.push(`- \`powershell\` tool = ${ps7 ? `PowerShell ${p?.psVersion || "7"} (pwsh): \`&&\`/\`||\` work` : `Windows PowerShell ${p?.psVersion || "5.1"}: no \`&&\`/\`||\`, use \`;\``}. ` +
		"No bash-isms: `$env:X='v'` (not export), `2>$null` (not 2>/dev/null), `Get-ChildItem -Force` (not ls -la), `Remove-Item -Recurse -Force` (not rm -rf).");
	const missing = p ? Object.keys(UNIX_ONLY).filter((t) => !p.win[t]) : ["grep", "head", "tail", "uname", "which", "rg", "jq"];
	if (missing.length) L.push(`- Not on Windows PATH: ${missing.join(", ")}. Use Select-String or \`git grep -n\`, Select-Object -First/-Last, Get-Command. Select-String has no -Recurse: \`Get-ChildItem -Recurse -File | Select-String\`.`);
	L.push("- Exit code 1 from git grep / Select-String / findstr only means \"no matches\".");
	if (!p || p.win.python) L.push(`- Python${p?.python ? ` ${p.python}` : ""}: set \`$env:PYTHONIOENCODING='utf-8'\` before printing non-ASCII (console code page is not UTF-8).`);
	if (p?.gitBash) L.push("- `bash` tool = Git Bash (paths /d/x), not WSL; it mangles /mnt paths and $VARS given to wsl.exe. Run WSL through the powershell tool.");
	if (p?.wsl.def) {
		L.push(`- WSL: ${p.wsl.distros.join(", ")} (default ${p.wsl.def}). Always \`wsl -d ${p.wsl.def} -e bash -lc '...'\`: without -e the text goes through a shell first ($VAR/$(...) expand early to empty, ~ stays literal). D:\\x = /mnt/d/x.`);
		const have = Object.entries(p.wsl.tools).filter(([k, v]) => v && k !== "pio").map(([k]) => k), miss = Object.entries(p.wsl.tools).filter(([k, v]) => !v && k !== "pio").map(([k]) => k);
		const pio = p.wsl.pio ? (p.wsl.tools.pio ? `, pio (${p.wsl.pio})` : `, pio at ${p.wsl.pio} (NOT on PATH: export PATH="$HOME/.platformio/penv/bin:$PATH")`) : "";
		L.push(`- WSL tools: ${have.join(", ")}${pio}${miss.length ? `; missing: ${miss.join(", ")}` : ""}.`);
	}
	if (p) L.push(`- Windows tools: ${WIN_TOOLS.filter((t) => p.win[t]).join(", ")}; missing: ${WIN_TOOLS.filter((t) => !p.win[t]).join(", ") || "-"}.`);
	L.push("- Long builds: stream output (`2>&1 | tee <log>`) and pass a generous tool `timeout` (3600 for firmware builds).");
	if (proj) L.push(`## Project ${proj.root} (${proj.kinds.join(", ")})`, ...proj.lines);
	const top = [...learned].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 5);
	if (top.length) { L.push("## Learned fixes on this machine"); for (const l of top) L.push(`- ✗ \`${l.bad}\` (${l.err}) → ✔ \`${l.good}\``); }
	return L.join("\n");
}

// ---------- guard ----------
export function checkCommand(tool: string, cmd: string, cwd: string, p: Probe | undefined, projOf: (dir: string) => Project | undefined): string | undefined {
	if (!cmd || ALLOW.test(cmd)) return;
	const bare = stripQuoted(cmd), lower = commandWords(cmd).map((w) => w.toLowerCase());
	const distro = p?.wsl.def || "Ubuntu";
	const tip = " (If this is really intended, add `# envctx:allow` to the command.)";
	const SEG = "(?:^|[;|&\\n{(])\\s*";
	if (tool === "powershell") {
		if (p && p.psExe !== "pwsh" && /&&|\|\|/.test(bare)) return `Windows PowerShell ${p.psVersion || "5.1"} has no \`&&\`/\`||\` ("not a valid statement separator"). Use \`;\` or \`cmd1; if ($?) { cmd2 }\`.` + tip;
		if (new RegExp(SEG + "export\\s+[A-Za-z_]\\w*=").test(bare)) return "`export X=...` is bash. In PowerShell use `$env:X = 'value'`." + tip;
		if (/[12]?>\s*\/dev\/null/.test(bare)) return "`/dev/null` does not exist in PowerShell. Use `2>$null` / `*>$null` or `| Out-Null`." + tip;
		if (/\bSelect-String\b[^|;\n]*\s-Recurse\b/i.test(bare)) return "Select-String has no -Recurse. Use `Get-ChildItem -Path src -Recurse -File | Select-String -Pattern '...'` (or `git grep -n '...' -- src`)." + tip;
		if (new RegExp(SEG + "ls\\s+-(?=[a-zA-Z]*l)[alhtrRS1]{1,5}\\b").test(bare)) return "`ls -la` is bash; in PowerShell `ls` is Get-ChildItem. Use `Get-ChildItem -Force`." + tip;
		if (new RegExp(SEG + "rm\\s+-(?:rf|fr)\\b").test(bare)) return "`rm -rf` is bash. Use `Remove-Item -Recurse -Force <path>`." + tip;
		for (const w of lower) if (UNIX_ONLY[w] && p && !p.win[w]) return `\`${w}\` does not exist in PowerShell on this machine. Use ${UNIX_ONLY[w].replace("<distro>", distro)}.` + tip;
		const at = cmd.search(/(?:^|[\s;&|(])wsl(?:\.exe)?\s/i);
		if (at >= 0) {
			const seg = cmd.slice(at), q = seg.match(/\b(?:bash|sh)\s+-l?c\s+(['"])([\s\S]*?)\1/);
			if (q && !/\s(?:-e|--exec)\s/.test(seg.slice(0, q.index)) && /[$~`]/.test(q[2]))
				return `Without \`-e\`, wsl.exe runs the command line through a shell first, so $VAR / $(...) inside your quotes expand early (to empty) and ~ stays literal. Use \`wsl -d ${distro} -e bash -lc '...'\`.` + tip;
		}
	}
	if (tool === "bash" && p?.gitBash && lower.some((w) => w === "wsl" || w === "wsl.exe"))
		return `The bash tool is Git Bash: it rewrites /mnt/... paths and $VARS before wsl.exe sees them. Run WSL with the powershell tool: \`wsl -d ${distro} -e bash -lc '...'\`.` + tip;
	const proj = projOf(workDir(cmd, cwd));
	if (proj?.pio && p?.wsl.pio && new RegExp(SEG + "(?:pio|platformio)(?:\\.exe)?\\s+(?:run|test|ci|check)\\b", "i").test(bare) && !/\bwsl(\.exe)?\b/i.test(bare))
		return `This PlatformIO project is built inside WSL (pio: ${p.wsl.pio}), not with Windows pio. Use the powershell tool with timeout 3600: \`wsl -d ${distro} -e bash -lc 'export PATH="$HOME/.platformio/penv/bin:$PATH"; cd ${toWsl(proj.root)} && pio run -e <env> 2>&1 | tee /tmp/pio-build.log; exit \${PIPESTATUS[0]}'\`.` + tip;
	if (proj?.pm) {
		const m = bare.match(new RegExp(SEG + "(npm|pnpm|yarn|bun)\\s+(install|i|add|ci|run|test|remove|rm|update|up|exec)\\b"));
		if (m && m[1] !== proj.pm) return `${basename(proj.root)} uses ${proj.pm} (lockfile/packageManager); ${m[1]} would create a second lockfile or miss deps. Use \`${proj.pm} ${m[2] === "i" ? "install" : m[2]} ...\`.` + tip;
	}
	return;
}

// ---------- learning ----------
export const LEARN_RE = /is not recognized as|command not found|not a valid statement separator|ParserError|A parameter cannot be found|Cannot bind argument|Unexpected token|charmap' codec/i;
export function errorKey(text: string): string {
	const t = text.replace(/\x1b\[[0-9;]*m/g, "");
	const name = t.match(/The term '([^']+)' is not recognized|'([^']+)' is not recognized|(?:^|\s)([^\s:]+): (?:command )?not found|parameter name '([^']+)'|token '([^']+)' is not a valid/m);
	const kind = /not recognized/.test(t) ? "not recognized" : /command not found|: not found/.test(t) ? "command not found" : /parameter name/.test(t) ? "no such parameter"
		: /statement separator/.test(t) ? "invalid separator" : /charmap/.test(t) ? "console encoding" : (t.match(LEARN_RE)?.[0] ?? "error");
	const n = name?.slice(1).find(Boolean);
	return `${kind}${n ? `: ${n.slice(0, 40)}` : ""}`;
}
export function similar(a: string, b: string): boolean {
	const ta = new Set(commandWords(a).map((w) => w.toLowerCase()));
	if (commandWords(b).some((w) => ta.has(w.toLowerCase()))) return true;
	const wa = new Set(a.toLowerCase().split(/\W+/).filter((x) => x.length > 2)), wb = new Set(b.toLowerCase().split(/\W+/).filter((x) => x.length > 2));
	return [...wb].filter((x) => wa.has(x)).length / Math.max(1, Math.min(wa.size, wb.size)) >= 0.4;
}

// ---------- extension ----------
// ---------- one `pio run` per project folder (several agents/goals building the same tree corrupt .pio/) ----------
const PIO_RE = /\b(?:pio|platformio)(?:\.exe)?\s+run\b/i;
const LOCK_DIR = join(DIR, "env-context-locks");
const LOCK_MAX_MS = 3 * 3600_000;
type PioLock = { pid: number; id: string; dir: string; cmd: string; at: number };
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } }
/** cd targets in a command (cd / Set-Location / pushd / -d / --project-dir), /mnt/x/... mapped to X:/... */
export function pioProjectDir(command: string, cwd: string): string {
	let dir = cwd;
	const re = /(?:^|[;&|(]\s*|&&\s*|bash\s+-l?c\s+["']?)(?:cd|Set-Location|sl|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|)"']+)|(?:-d|--project-dir)\s+("[^"]+"|'[^']+'|\S+)/gi;
	for (const m of command.matchAll(re)) {
		let p = (m[1] ?? m[2] ?? "").replace(/^["']|["']$/g, "");
		if (!p || p.startsWith("$") || p.startsWith("~")) continue;
		const w = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
		if (w) p = `${w[1].toUpperCase()}:/${w[2]}`;
		dir = resolve(dir, p);
	}
	for (let d = dir, i = 0; i < 8; i++) { // walk up to the folder holding platformio.ini
		if (existsSync(join(d, "platformio.ini"))) return d;
		const up = dirname(d); if (up === d) break; d = up;
	}
	return dir;
}
const lockKey = (dir: string) => createHash("sha1").update(resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 16);
const myPioRuns = new Set<string>(); // shared by every instance in this process (parent + subagent sessions)
(globalThis as any).__envctxPioRuns ??= myPioRuns;
const livePio: Set<string> = (globalThis as any).__envctxPioRuns;
/** null = acquired; otherwise the holder */
export function acquirePio(dir: string, id: string, cmd: string): PioLock | null {
	mkdirSync(LOCK_DIR, { recursive: true });
	const f = join(LOCK_DIR, `pio-${lockKey(dir)}.json`);
	const mine: PioLock = { pid: process.pid, id, dir, cmd: cmd.slice(0, 160), at: Date.now() };
	for (let i = 0; i < 2; i++) {
		try { writeFileSync(f, JSON.stringify(mine), { flag: "wx" }); livePio.add(id); return null; } catch (e: any) { if (e?.code !== "EEXIST") return null; }
		let h: PioLock | undefined; try { h = JSON.parse(readFileSync(f, "utf8")); } catch { /* unreadable = stale */ }
		const stale = !h || !pidAlive(h.pid) || Date.now() - h.at > LOCK_MAX_MS || (h.pid === process.pid && !livePio.has(h.id));
		if (!stale) return h!;
		try { rmSync(f, { force: true }); } catch { /* */ }
	}
	return null;
}
export function releasePio(id: string): void {
	if (!livePio.delete(id)) return;
	try {
		for (const n of readdirSync(LOCK_DIR)) {
			const f = join(LOCK_DIR, n);
			try { if (JSON.parse(readFileSync(f, "utf8")).id === id) rmSync(f, { force: true }); } catch { /* */ }
		}
	} catch { /* */ }
}

export default function envContext(pi: ExtensionAPI) {
	const settings = { guard: true, ...readJson<any>(SETTINGS, {}) };
	let probe: Probe | undefined = readJson<Probe | undefined>(CACHE, undefined);
	let learned: Learned[] = readJson<Learned[]>(LEARNED, []);
	let probing: Promise<void> | undefined;
	const projCache = new Map<string, { at: number; proj?: Project }>();
	const projOf = (dir: string) => {
		const c = projCache.get(dir);
		if (c && Date.now() - c.at < 60_000) return c.proj;
		let proj: Project | undefined; try { proj = detectProject(dir, probe); } catch { /* */ }
		projCache.set(dir, { at: Date.now(), proj }); return proj;
	};
	const refresh = () => (probing ??= probeEnv().then((p) => { probe = p; writeJson(CACHE, p); projCache.clear(); }).catch(() => {}).finally(() => { probing = undefined; }));
	if (!probe || Date.now() - probe.at > DAY) { const t = setTimeout(() => void refresh(), 100); (t as any).unref?.(); } // async: never blocks startup
	const block = (cwd: string) => renderContext(probe, projOf(cwd), learned);

	pi.on("before_agent_start", (event: any, ctx: any) => {
		try { return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${block(ctx?.cwd ?? process.cwd())}` }; } catch { return; }
	});

	const ownPio = new Set<string>(); // this session's pio locks
	pi.on("agent_end", () => { for (const id of ownPio) releasePio(id); ownPio.clear(); });
	pi.on("tool_call", (event: any, ctx: any) => {
		try {
			if (event.toolName !== "powershell" && event.toolName !== "bash") return;
			const command = String(event.input?.command ?? ""), cwd = ctx?.cwd ?? process.cwd();
			let reason: string | undefined;
			try { reason = settings.guard ? checkCommand(event.toolName, command, cwd, probe, projOf) : undefined; } catch { /* guard is best-effort */ }
			if (reason) return { block: true, reason: `env-context: ${reason}` };
			if (settings.pioLock !== false && PIO_RE.test(command)) {
				const dir = pioProjectDir(command, cwd), id = String(event.toolCallId ?? `${process.pid}-${Date.now()}`);
				const h = acquirePio(dir, id, command);
				if (!h) ownPio.add(id);
				if (h) {
					const mins = Math.round((Date.now() - h.at) / 60000);
					return { block: true, reason: `env-context: another \`pio run\` is already building ${h.dir} (pid ${h.pid}, started ${mins} min ago: \`${h.cmd}\`). Two builds in one project folder corrupt .pio/ — wait for it to finish (check again in a few minutes) or build in your own worktree. Do not kill it unless it belongs to you. (/envctx pio off disables this lock.)` };
				}
			}
		} catch { /* never break tool calls */ }
		return;
	});

	// learning: failed call -> later successful similar call (within 3 shell calls / 10 min)
	const cmds = new Map<string, { tool: string; cmd: string }>();
	let pending: { tool: string; cmd: string; err: string; at: number; left: number } | undefined;
	pi.on("tool_execution_start", (e: any) => { try { if (typeof e?.args?.command === "string") cmds.set(e.toolCallId, { tool: e.toolName, cmd: e.args.command }); } catch { /* */ } });
	pi.on("tool_execution_end", (e: any) => {
		try { releasePio(String(e?.toolCallId)); ownPio.delete(String(e?.toolCallId)); } catch { /* */ }
		try {
			const c = cmds.get(e?.toolCallId); cmds.delete(e?.toolCallId);
			if (!c || (c.tool !== "powershell" && c.tool !== "bash")) return;
			const text = (e?.result?.content ?? []).map((x: any) => x?.text ?? "").join("\n").slice(-4000);
			if (e?.isError && LEARN_RE.test(text) && !/env-context:/.test(text)) { pending = { ...c, err: errorKey(text), at: Date.now(), left: 3 }; return; }
			if (!pending) return;
			if (!e?.isError && c.tool === pending.tool && Date.now() - pending.at < 600_000 && c.cmd.trim() !== pending.cmd.trim() && similar(pending.cmd, c.cmd)) {
				const key = `${pending.tool}|${pending.err}`, found = learned.find((l) => l.key === key);
				if (found) { found.n++; found.last = Date.now(); found.bad = short(pending.cmd); found.good = short(c.cmd); }
				else learned.push({ key, bad: short(pending.cmd), good: short(c.cmd), err: pending.err, n: 1, last: Date.now() });
				learned = learned.sort((a, b) => b.last - a.last).slice(0, 30); writeJson(LEARNED, learned); pending = undefined; return;
			}
			if (--pending.left <= 0) pending = undefined;
		} catch { /* ignore */ }
	});

	pi.registerCommand("envctx", {
		description: "Environment context: /envctx [refresh|learned|forget <n>|all|guard on|off|pio on|off]",
		handler: async (args: string, ctx: any) => {
			const say = (m: string) => { try { ctx?.ui?.notify?.(m, "info"); } catch { /* */ } };
			try {
				const a = (args ?? "").trim(); let m: RegExpMatchArray | null;
				if (a === "refresh") { say("env-context: probing…"); await refresh(); return say(block(ctx?.cwd ?? process.cwd())); }
				if (a === "learned") return say(learned.length ? learned.map((l, i) => `${i + 1}. [${l.n}×] ${l.err}\n   ✗ ${l.bad}\n   ✔ ${l.good}`).join("\n") : "env-context: nothing learned yet");
				if ((m = a.match(/^forget\s+(all|\d+)$/i))) {
					const before = learned.length, idx = Number(m[1]) - 1; learned = m[1] === "all" ? [] : learned.filter((_, i) => i !== idx);
					writeJson(LEARNED, learned); return say(`env-context: forgot ${before - learned.length}`);
				}
				if ((m = a.match(/^pio\s+(on|off)$/i))) { (settings as any).pioLock = m[1].toLowerCase() === "on"; writeJson(SETTINGS, settings); return say(`env-context: pio lock ${m[1].toLowerCase()}`); }
				if ((m = a.match(/^guard\s+(on|off)$/i))) { settings.guard = m[1].toLowerCase() === "on"; writeJson(SETTINGS, settings); return say(`env-context: guard ${m[1].toLowerCase()}`); }
				say(`${block(ctx?.cwd ?? process.cwd())}\n\n(probed ${probe ? new Date(probe.at).toLocaleString("sv-SE") : "not yet"}; guard ${settings.guard ? "on" : "off"}; ${learned.length} learned)\nUsage: /envctx [refresh|learned|forget <n>|all|guard on|off|pio on|off]`);
			} catch { /* ignore */ }
		},
	});
}