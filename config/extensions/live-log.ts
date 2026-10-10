/**
 * live-log.ts - live output + stall watchdog for long-running shell tool calls in Pi.
 *
 * Problem: long builds (e.g. `wsl -d Ubuntu bash build.sh` where the script does
 * `pio run > build.log 2>&1`, or a `Start-Job` + `Start-Sleep` poll loop) only show
 * "Elapsed 11m 49s" in the TUI, and a hung build runs until the tool timeout.
 *
 * 1. In-row log: a tool renderer (pi.registerToolRenderer) wraps the built-in
 *    bash/powershell renderResult. While the call runs, the log tail is appended to
 *    the row's own output preview (above "Elapsed"). The built-in renderer already
 *    redraws every second. Final results render unchanged.
 * 2. Optional widget above the editor (/livelog widget on), also used by /livelog <path>.
 * 3. Watchdog: no new output (stdout or log size/mtime) for the stall limit, or a total
 *    runtime over the max limit, aborts the turn with ctx.abort() (same as Esc; Pi
 *    then kills the shell process tree with taskkill /T, which also ends the Linux
 *    processes of a wsl.exe child). It warns `warnSec` seconds before (in the row,
 *    the widget and a notification). On stop it runs a local heuristic analysis (error
 *    lines + why it ran long) shown in the row/notify, writes ~/.pi/agent/
 *    live-log-last-stop.md (/livelog last), and sends the agent a follow-up asking for
 *    a summary in the conversation's language before any fix. The extension's own
 *    texts are Vietnamese or English, following the last assistant message
 *    (message_end / session entries) unless /livelog lang en|vi is set.
 *
 * Log sources (priority): a log file written since the call started, the streamed
 * stdout (tool_execution_update), an older log file. Log files are detected from
 * `> f`, `>> f`, `*> f`, `| tee [-a] f`, Out-File/Tee-Object/Add-Content/Set-Content,
 * -RedirectStandardOutput, and *.log/*.txt/*.out files named in Get-Content/
 * Remove-Item/Test-Path/cat/tail/rm. It also reads redirects inside .sh/.bash/.ps1
 * scripts the command runs (Start-Job script blocks included). Relative paths
 * resolve against a leading `cd`/Set-Location, else ctx.cwd. WSL paths are mapped:
 * /mnt/d/x -> D:\x, /tmp/x -> \\wsl.localhost\<distro>\tmp\x (fallback \\wsl$\...).
 *
 * Commands: /livelog (status) | <path> | off | lines <n> | widget on|off | auto on|off
 *           | watchdog on|off | stall|max <min>|auto | limits | forget <sig>|all | keep | stop | last
 *           | lang auto|en|vi
 * Limits are per command: a category (build 10m/60m, install 5m/20m, test 5m/30m,
 * quick 2m/5m, default 5m/30m as stall/max) from the command and the scripts it runs,
 * raised by learned history (~/.pi/agent/live-log-history.json, last 10 successful
 * runs per signature like "pio run @ D:\CrosSen": max >= 2x p90, stall >= 1.5x longest
 * silence). /livelog stall|max <min> are global overrides ("auto" clears them).
 * Settings: ~/.pi/agent/live-log.json (env LIVE_LOG_SETTINGS overrides, for tests).
 * Never throws into Pi; fs errors are ignored silently.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const WIDGET = "live-log";
const SETTINGS = process.env.LIVE_LOG_SETTINGS || join(homedir(), ".pi", "agent", "live-log.json");
const LAST_STOP = join(dirname(SETTINGS), "live-log-last-stop.md");
const HISTORY = join(dirname(SETTINGS), "live-log-history.json");
const SHOW_AFTER_MS = 3000;
const TAIL_BYTES = 16 * 1024;
const SHELL_TOOLS = ["powershell", "bash"];
const PATH_RE = String.raw`("[^"]+"|'[^']+'|[^\s;&|<>(){}"']+)`;

type Settings = { enabled: boolean; lines: number; widget: boolean; watchdog: boolean; stallMin: number | null; maxMin: number | null; warnSec: number; lang: "auto" | Lang };
const DEFAULTS: Settings = { enabled: true, lines: 8, widget: false, watchdog: true, stallMin: null, maxMin: null, warnSec: 60, lang: "auto" };
type Run = {
	/** set for runs inside a @tintinweb subagent session (shown in the parent widget) */
	agent?: string;
	id: string; tool: string; command: string; start: number; ctx: any;
	partial: string; logs: string[][]; tail: string[]; source: string; logPath?: string;
	lastActivity: number; logSig: string; maxGap: number; limits: Limits; timeoutSec?: number; warning?: string; warned?: string; kept?: boolean;
	stopped?: { reason: string; kind: "stall" | "max" | "manual"; detail: string; at: number; analysis?: Analysis; analysisEn?: Analysis; lines: string[]; from: string };
};
export type Limits = { category: string; sig: string; stallMin: number; maxMin: number; why: string };
export type Analysis = { hasError: boolean; errors: string[]; why: string };
type Tail = { path: string; lines: string[]; sig: string };

// ---------- small helpers ----------
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Strip ANSI, keep only the text after the last \r of each line, drop blanks, keep last n. */
export function cleanLines(text: string, n: number): string[] {
	const out: string[] = [];
	for (let line of (text ?? "").replace(ANSI, "").split("\n")) {
		line = line.replace(/\r+$/, "");
		const cr = line.lastIndexOf("\r");
		if (cr >= 0) line = line.slice(cr + 1);
		line = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\t/g, "  ").trimEnd();
		if (line.trim()) out.push(line);
	}
	return out.slice(-n);
}

/** Approximate terminal width of one char (combining = 0, East Asian wide/emoji = 2). */
function charWidth(cp: number): number {
	if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
	if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
	return 1;
}

/** Truncate plain text to a visible width, adding an ellipsis when cut. */
export function fit(text: string, width: number): string {
	const chars = [...text], widths = chars.map((ch) => charWidth(ch.codePointAt(0) ?? 32));
	if (widths.reduce((a, b) => a + b, 0) <= width) return text;
	let w = 0, out = "";
	for (let i = 0; i < chars.length && w + widths[i] <= width - 1; i++) { w += widths[i]; out += chars[i]; }
	return out + "…";
}

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
	return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// ---------- path resolution ----------
let defaultDistroCache: string | undefined;
/** Default WSL distro from the registry (cached); falls back to "Ubuntu". */
function defaultDistro(): string {
	if (defaultDistroCache) return defaultDistroCache;
	defaultDistroCache = "Ubuntu";
	try {
		if (process.platform !== "win32") return defaultDistroCache;
		const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
		const q = (k: string, v: string) => execFileSync("reg", ["query", k, "/v", v], { encoding: "utf8", timeout: 2000, windowsHide: true });
		const guid = q(key, "DefaultDistribution").match(/DefaultDistribution\s+REG_SZ\s+(\S+)/)?.[1];
		const name = guid && q(`${key}\\${guid}`, "DistributionName").match(/DistributionName\s+REG_SZ\s+(.+)/)?.[1]?.trim();
		if (name) defaultDistroCache = name;
	} catch { /* keep fallback */ }
	return defaultDistroCache;
}

/** Map a Windows/WSL/relative path to candidate Windows paths (first existing one wins). */
export function toCandidates(raw: string, cwd: string, distro?: string): string[] {
	const p = raw.trim().replace(/^["']|["']$/g, "");
	if (!p || /[$`%*?]/.test(p) || /^(\/dev\/|\$null$|nul$|NUL$)/.test(p)) return [];
	const mnt = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
	if (mnt) return [`${mnt[1].toUpperCase()}:${(mnt[2] ?? "/").replace(/\//g, "\\")}`];
	if (p.startsWith("/")) {
		const d = distro ?? defaultDistro(), rest = p.replace(/\//g, "\\");
		return [`\\\\wsl.localhost\\${d}${rest}`, `\\\\wsl$\\${d}${rest}`];
	}
	if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || isAbsolute(p)) return [p];
	if (p.startsWith("~")) return [join(homedir(), p.slice(1))];
	return [resolve(cwd || process.cwd(), p)];
}

/** Directory of a leading `cd X` / Set-Location / pushd, used as the base for relative paths. */
export function baseDir(text: string, cwd: string, distro?: string): string {
	const m = text.match(new RegExp(String.raw`(?:^|[;&\n{]\s*)(?:cd|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Path|LiteralPath)\s+)?` + PATH_RE, "i"));
	return (m && toCandidates(m[1], cwd, distro)[0]) || cwd;
}

/** Extract log-file targets from shell or PowerShell text. */
export function findRedirectTargets(text: string): string[] {
	const res = [
		new RegExp(String.raw`(?:^|[^\w=-])(?:\d|\*|&)?>>?\s*` + PATH_RE, "g"),
		new RegExp(String.raw`\btee(?:\s+-a|\s+--append)?\s+` + PATH_RE, "gi"),
		new RegExp(String.raw`\b(?:Out-File|Tee-Object|Add-Content|Set-Content)\s+(?:-(?:FilePath|LiteralPath|Path)\s+)?` + PATH_RE, "gi"),
		new RegExp(String.raw`-RedirectStandard(?:Output|Error)\s+` + PATH_RE, "gi"),
	];
	const found: string[] = [];
	const add = (t?: string) => { if (t && !t.startsWith("&") && !t.startsWith("-") && !found.includes(t)) found.push(t); };
	for (const re of res) for (const m of text.matchAll(re)) add(m[1]);
	// Log-like files that the command reads, deletes or tests (e.g. `Get-Content .tmp-build.log -Tail 8`).
	const ref = new RegExp(String.raw`\b(?:Get-Content|gc|cat|type|tail|Remove-Item|rm|del|Test-Path)\b(?:\s+-\w+(?:\s+\d+)?)*\s+(?:-(?:Path|LiteralPath)\s+)?` + PATH_RE, "gi");
	for (const m of text.matchAll(ref)) if (/\.(log|txt|out)["']?$/i.test(m[1])) add(m[1]);
	return found;
}

/** All log-file candidates for a command, including redirects inside scripts it runs. */
export function resolveLogs(command: string, cwd: string): string[][] { return inspectCommand(command, cwd).logs; }

/** Log candidates, the text of scripts the command runs, and the directory it works in. */
export function inspectCommand(command: string, cwd: string): { logs: string[][]; scripts: string; dir: string } {
	let scripts = "", dir = "";
	const distro = command.match(/\bwsl(?:\.exe)?\b[^;|&\n]*?(?:-d|--distribution)\s+["']?([^\s"']+)/i)?.[1];
	const base = baseDir(command, cwd, distro);
	const out: string[][] = [];
	const push = (c: string[]) => { if (c.length && !out.some((o) => o[0] === c[0])) out.push(c); };
	for (const t of findRedirectTargets(command)) push(toCandidates(t, base, distro));
	const scriptRe = /("[^"]+\.(?:sh|bash|ps1)"|'[^']+\.(?:sh|bash|ps1)'|[^\s;&|<>"'{}]+\.(?:sh|bash|ps1))(?=$|[\s;&|)}"'])/gi;
	for (const m of command.matchAll(scriptRe)) {
		for (const file of toCandidates(m[1], base, distro)) {
			try {
				if (statSync(file).size > 256 * 1024) continue;
				const text = readFileSync(file, "utf8");
				scripts += "\n" + text;
				const sbase = baseDir(text, base, distro);
				dir ||= sbase !== base ? sbase : dirname(file); // the script's own `cd`, else its folder
				for (const t of findRedirectTargets(text)) push(toCandidates(t, sbase, distro));
				break;
			} catch { /* script not readable: ignore */ }
		}
	}
	return { logs: out.slice(0, 6), scripts, dir: dir || base };
}

// ---------- adaptive limits: category defaults + learned history ----------
export const CATEGORIES = [
	{ name: "test", stall: 5, max: 30, re: /\b(?:pytest|vitest|jest|ctest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:cargo|flutter|dotnet|pio|go)\s+test\b/i },
	{ name: "install", stall: 5, max: 20, re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bapt(?:-get)?\s+(?:install|update|upgrade)\b|\b(?:winget|choco|scoop)\s+install\b|\b(?:curl|wget|Invoke-WebRequest)\b|\bgit\s+clone\b|\bpio\s+pkg\b|\bflutter\s+pub\s+get\b/i },
	{ name: "build", stall: 10, max: 60, re: /\b(?:pio|platformio|idf\.py|cmake|make|ninja|msbuild|gradlew?|mvn)\b|\b(?:cargo|dotnet|flutter|tauri)\s+build\b|\bcargo\s+tauri\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i },
] as const;
const QUICK = /^(?:git|ls|dir|cat|type|gc|Get-Content|Get-ChildItem|gci|Get-Item|Select-String|sls|rg|grep|findstr|echo|Write-Output|Write-Host|Test-Path|pwd|cd|Set-Location|sl|head|tail|wc|which|where|Get-Command|Get-Location|Resolve-Path|Measure-Object|Sort-Object|Select-Object|Format-\w+|Out-String)$/i;
const DEFAULT_CAT = { name: "default", stall: 5, max: 30 }, QUICK_CAT = { name: "quick", stall: 2, max: 5 };
type HistoryEntry = { ms: number; gap: number; at: number };
export type History = Record<string, HistoryEntry[]>;

/** Category + a normalized signature such as "pio run @ D:\CrosSen". */
export function classify(command: string, scripts: string, dir: string): { category: string; stall: number; max: number; sig: string } {
	const text = `${command}\n${scripts}`;
	for (const c of CATEGORIES) {
		const m = c.re.exec(text);
		if (m) {
			const w = text.slice(m.index).split(/\s+/), key = w.slice(0, w[1] === "run" ? 3 : 2).filter((x, i) => i === 0 || /^[A-Za-z][\w:.-]*$/.test(x)).join(" ");
			return { category: c.name, stall: c.stall, max: c.max, sig: `${key.toLowerCase().replace(/\s+/g, " ")} @ ${dir}` };
		}
	}
	const segs = command.split(/[;\n|]|&&|\|\|/).map((x) => x.trim()).filter(Boolean);
	const firstWords = segs.map((x) => x.split(/\s+/)[0]);
	const quick = segs.length > 0 && firstWords.every((w) => QUICK.test(w)) && !/\bgit\s+(?:clone|fetch|pull|push)\b/i.test(command);
	const c = quick ? QUICK_CAT : DEFAULT_CAT;
	return { category: c.name, stall: c.stall, max: c.max, sig: `${segs.slice(-1)[0]?.split(/\s+/).slice(0, 2).join(" ").toLowerCase() ?? "?"} @ ${dir}` };
}

const p90 = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)]; };
export const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${Math.round(m % 60)}m` : ""}` : `${Math.round(m * 10) / 10}m`);

/** Limits for one command: category defaults, raised by history (2x p90 duration, 1.5x longest silent gap), then global overrides. */
export function computeLimits(cls: ReturnType<typeof classify>, history: History, over: { stallMin: number | null; maxMin: number | null }): Limits {
	let stall = cls.stall, max = cls.max, why = "default";
	const h = (history[cls.sig] ?? []).filter((e) => e && e.ms > 0);
	if (h.length >= 2) {
		const p = p90(h.map((e) => e.ms)), gap = Math.max(...h.map((e) => e.gap || 0));
		max = Math.max(cls.max, Math.ceil((2 * p) / 60_000));
		stall = Math.max(cls.stall, Math.ceil((1.5 * gap) / 60_000));
		why = `history: ${h.length} runs, p90 ${fmtElapsed(p)}`;
	}
	if (over.stallMin != null || over.maxMin != null) why = `override${why === "default" ? "" : `; ${why}`}`;
	if (over.stallMin != null) stall = over.stallMin;
	if (over.maxMin != null) max = over.maxMin;
	return { category: cls.category, sig: cls.sig, stallMin: stall, maxMin: max, why };
}

/** Row/widget header, e.g. "⏱ build · stall 10m · max 45m (history: 6 runs, p90 18m)". */
export function limitsHeader(l: Limits, timeoutSec?: number): string {
	const t = timeoutSec && l.maxMin && timeoutSec < l.maxMin * 60 ? ` · ⚠ tool timeout ${timeoutSec}s < max` : "";
	return `⏱ ${l.category} · stall ${l.stallMin ? fmtMin(l.stallMin) : "off"} · max ${l.maxMin ? fmtMin(l.maxMin) : "off"} (${l.why})${t}`;
}

/** Read the last ~16KB of the first existing candidate modified at/after `since`. */
async function readTail(cands: string[], n: number, since = 0, bytes = TAIL_BYTES): Promise<Tail | undefined> {
	for (const p of cands) {
		try {
			const st = await stat(p);
			if (!st.isFile() || st.mtimeMs < since) continue;
			const fh = await open(p, "r");
			try {
				const len = Math.min(st.size, bytes), buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, st.size - len);
				return { path: p, lines: cleanLines(buf.toString("utf8"), n), sig: `${st.size}:${st.mtimeMs}` };
			} finally { await fh.close(); }
		} catch { /* missing / locked: try next */ }
	}
	return undefined;
}

// ---------- local heuristic analysis (no LLM) ----------
const ERROR_RE = /\berror\b|FAILED|\bfatal\b|undefined reference|No such file|Traceback|\bpanic\b|Exception|exit status [1-9]|\*\*\* \[|npm ERR!|permission denied|\bkilled\b|out of memory|timed out|Connection (?:refused|reset)|Could not resolve/i;
const NOT_ERROR_RE = /\b0 errors?\b|-Werror|error(?:s)?=0|\bno errors?\b/i;

export type Lang = "en" | "vi";
/** UI strings for the extension's own (non-LLM) output. */
const TXT = {
	en: {
		noOutput: "no output at all: the process was silent or hung from the start",
		prompt: (l: string) => `looks like it is waiting for input: "${l}"`,
		loop: (l: string) => `looks like a loop: "${l}" keeps repeating`,
		download: (p: string, l: string) => `downloading/installing packages or toolchain${p ? ` (${p})` : ""}: "${l}"`,
		compile: (p: string, l: string) => `still compiling${p ? `, progress ${p}` : ""}; last line: "${l}"`,
		unclear: (l: string) => `no clear sign; the process went silent after: "${l}"`,
		errVerdict: (t: string, e: string) => `✗ Stopped after ${t}: error — ${e}`,
		okVerdict: (t: string, w: string) => `⚠ Stopped after ${t}: no error found; ${w}`,
		stall: (t: string) => `no output for ${t}`, max: (m: number) => `exceeded the ${m} min limit`, manual: "stopped manually with /livelog stop",
		notify: (l: string, r: string) => `live-log: ${l} (reason: ${r}). See /livelog last`,
		md: { title: "Stopped command summary (live-log)", when: "Time", cmd: "Command", runtime: "Runtime", reason: "Stop reason", error: "Error?",
			yes: "yes", no: "no error found", why: "Why it took long (automatic analysis)", src: "Log source", last: (n: number) => `Last ${n} lines` },
		none: "live-log: no command has been stopped yet",
	},
	vi: {
		noOutput: "không có output nào: tiến trình im lặng hoặc bị treo ngay từ đầu",
		prompt: (l: string) => `có vẻ đang chờ nhập: "${l}"`,
		loop: (l: string) => `có vẻ bị lặp: dòng "${l}" lặp lại liên tục`,
		download: (p: string, l: string) => `đang tải/cài gói hoặc toolchain${p ? ` (${p})` : ""}: "${l}"`,
		compile: (p: string, l: string) => `vẫn đang biên dịch${p ? `, tiến độ ${p}` : ""}; dòng cuối: "${l}"`,
		unclear: (l: string) => `không thấy dấu hiệu rõ; tiến trình im lặng sau dòng cuối: "${l}"`,
		errVerdict: (t: string, e: string) => `✗ Dừng sau ${t}: có lỗi — ${e}`,
		okVerdict: (t: string, w: string) => `⚠ Dừng sau ${t}: không thấy lỗi; ${w}`,
		stall: (t: string) => `treo ${t} không ra log`, max: (m: number) => `vượt giới hạn ${m} phút`, manual: "dừng thủ công bằng /livelog stop",
		notify: (l: string, r: string) => `live-log: ${l} (lý do: ${r}). Xem /livelog last`,
		md: { title: "Tóm tắt lệnh bị dừng (live-log)", when: "Thời điểm", cmd: "Lệnh", runtime: "Thời gian chạy", reason: "Lý do dừng", error: "Có lỗi không",
			yes: "có", no: "không thấy lỗi", why: "Vì sao chạy lâu (phân tích tự động)", src: "Nguồn log", last: (n: number) => `${n} dòng cuối` },
		none: "live-log: chưa có lệnh nào bị dừng",
	},
};

/** Vietnamese if the text has several Vietnamese-only diacritics, else English. */
export function detectLang(text: string): Lang {
	return (text.match(/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length >= 3 ? "vi" : "en";
}

/** Classify the last log lines: error lines, and a hint for why the command ran long. */
export function analyzeLog(lines: string[], lang: Lang = "en"): Analysis {
	const T = TXT[lang];
	const errors = lines.filter((l) => ERROR_RE.test(l) && !NOT_ERROR_RE.test(l)).slice(-5).map((l) => l.trim().slice(0, 200));
	const last = lines.at(-1)?.trim() ?? "", recent = lines.slice(-10);
	const progress = (() => { for (const l of [...recent].reverse()) { const m = l.match(/\[\s*\d+\s*\/\s*\d+\s*\]|\b\d{1,3}(?:\.\d+)?%/); if (m) return m[0]; } return ""; })();
	const DL = /Downloading|Installing|Resolving|Fetching|Unpacking|Tool Manager|Cloning/i;
	let why: string;
	if (!lines.length) why = T.noOutput;
	else if (/\(y\/n\)|\[y\/n\]|\(yes\/no\)|press (?:any|enter|a key)|password|passphrase|continue\?|\?\s*$|(?:enter|input|choose|select)[^:]*:\s*$/i.test(last) && !ERROR_RE.test(last)) why = T.prompt(last.slice(0, 80));
	else if (lines.length >= 4 && lines.slice(-4).every((l) => l === lines.at(-1))) why = T.loop(last.slice(0, 60));
	else if (recent.some((l) => DL.test(l))) why = T.download(progress, recent.filter((l) => DL.test(l)).at(-1)!.trim().slice(0, 70));
	else if (recent.some((l) => /Compiling|Linking|Building|Archiving|Generating|Indexing/i.test(l))) why = T.compile(progress, last.slice(0, 60));
	else why = T.unclear(last.slice(0, 60));
	return { hasError: errors.length > 0, errors, why };
}

/** One-line verdict, e.g. "✗ Stopped after 7m 2s: error — src/a.cpp:12: error: ...". */
export function verdict(a: Analysis, elapsed: string, lang: Lang = "en"): string {
	// Prefer the most specific line (file:line: error / fatal error), else the first error line.
	const best = a.errors.find((e) => /:\d+(?::\d+)?:\s*(?:fatal\s+)?error\b/i.test(e)) ?? a.errors.find((e) => /\berror\b|Traceback|panic|npm ERR!/i.test(e)) ?? a.errors[0];
	return a.hasError ? TXT[lang].errVerdict(elapsed, best!) : TXT[lang].okVerdict(elapsed, a.why);
}

// ---------- extension ----------
/**
 * Process-wide bus: @tintinweb subagents run as child sessions in the same process with
 * their own live-log instance but NO UI (hasUI false, mode "print"). Child runs are
 * published here so the UI instance (parent) shows them in its widget, and a child's
 * auto-stop summary is delivered to the parent session (the child run is already over:
 * ctx.abort() in the child aborts only the child; the parent's Agent call returns "aborted").
 */
type Bus = {
	parent?: { id: number; send: (msg: string) => void; wake: () => void; notify: (m: string, level: string) => void };
	childRuns: Map<string, Run>;
	agents: Map<string, string>;
	seq: number;
};
const BUS: Bus = ((globalThis as any).__liveLogBus ??= { childRuns: new Map(), agents: new Map(), seq: 0 });

export default function liveLog(pi: ExtensionAPI) {
	const instanceId = ++BUS.seq;
	/** a no-UI instance while a UI instance exists in this process = subagent child session */
	const isChild = (ctx: any) => ctx?.hasUI === false && !!BUS.parent && BUS.parent.id !== instanceId;
	const claimParent = (ctx: any) => {
		if (ctx?.hasUI !== true) return;
		ui = ctx?.ui ?? ui;
		BUS.parent = {
			id: instanceId,
			send: (msg: string) => { try { (pi as any).sendUserMessage?.(msg, { deliverAs: "followUp" }); } catch { /* ignore */ } },
			wake: () => ensureTimer(),
			notify: (m: string, level: string) => notify(undefined, m, level),
		};
	};
	pi.on("session_start", (_e: any, ctx: any) => { try { claimParent(ctx); } catch { /* ignore */ } });
	let settings: Settings = { ...DEFAULTS };
	try { settings = { ...settings, ...JSON.parse(readFileSync(SETTINGS, "utf8")) }; } catch { /* defaults */ }
	const save = () => { try { writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch { /* ignore */ } };

	const runs = new Map<string, Run>();
	const stopSummaries = new Map<string, string>(); // toolCallId -> verdict line shown in the final row
	let manual: { label: string; cands: string[]; tail: string[] } | undefined;
	let finalLine: { text: string; ok: boolean } | undefined;
	let ui: any, timer: ReturnType<typeof setInterval> | undefined, finalTimer: any;
	let shown = false, busy = false, requestRender = () => {};
	const anyPi = pi as any;
	const inRow = typeof anyPi.registerToolRenderer === "function";
	const useWidget = () => settings.widget || !inRow;
	const notify = (ctx: any, m: string, level = "info") => { try { (ctx?.ui ?? ui)?.notify?.(m, level); } catch { /* ignore */ } };

	/** Log/stdout tail plus watchdog warning for a run (plain text lines). */
	const runLines = (run: Run) => {
		const tail = run.tail.length ? run.tail : cleanLines(run.partial, settings.lines);
		return run.warning ? [...tail, `⚠ ${run.warning}`] : tail;
	};

	// ----- in-row rendering: append the log tail to the built-in shell row while it runs -----
	if (inRow) {
		anyPi.registerToolRenderer((toolName: string, next: () => any) => {
			const base = next();
			if (!SHELL_TOOLS.includes(toolName) || !base?.renderResult) return base;
			return {
				...base,
				renderResult(result: any, options: any, theme: any, context: any) {
					try {
						const done = stopSummaries.get(context?.toolCallId);
						if (!options?.isPartial && done) {
							const own = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trimEnd();
							result = { ...result, content: [{ type: "text", text: [own, done].filter(Boolean).join("\n") }] };
						}
						const run = runs.get(context?.toolCallId);
						if (options?.isPartial && run && settings.enabled) {
							const own = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trimEnd();
							const body = run.logPath ? [own ? "──" : "", ...run.tail] : [];
							const head = limitsHeader(run.limits, run.timeoutSec) + (run.logPath ? ` · log ${basename(run.logPath)}` : "");
							const text = [own, ...body, settings.watchdog ? head : "", run.warning ? `⚠ ${run.warning}` : ""].filter(Boolean).join("\n");
							result = { ...result, content: [{ type: "text", text }] };
						}
					} catch { /* fall back to the original result */ }
					return base.renderResult(result, options, theme, context);
				},
			};
		});
	}

	// ----- optional widget above the editor -----
	const latestRun = () => [...runs.values()].filter((r) => useWidget() && Date.now() - r.start >= SHOW_AFTER_MS).pop();
	/** subagent runs are never visible as rows in this TUI → always shown in the widget */
	const childRun = () => BUS.parent?.id === instanceId ? [...BUS.childRuns.values()].filter((r) => Date.now() - r.start >= SHOW_AFTER_MS).pop() : undefined;
	function render(width: number, theme: any): string[] {
		const w = Math.max(20, width), c = (k: string, s: string) => { try { return theme?.fg ? theme.fg(k, s) : s; } catch { return s; } };
		if (manual) return [c("accent", fit(`▸ tail ${manual.label}`, w)),
			...(manual.tail.length ? manual.tail : ["(file empty or not found yet)"]).map((l) => c("dim", fit(`  ${l}`, w)))];
		const run = latestRun() ?? childRun();
		if (run) {
			const head = `▸ ${run.agent ? `⤷ ${run.agent}: ` : ""}${fmtElapsed(Date.now() - run.start)} · ${run.command.replace(/\s+/g, " ")}`;
			const src = run.source ? ` [${run.source}]` : "";
			const lines = settings.watchdog ? [...runLines(run), limitsHeader(run.limits, run.timeoutSec)] : runLines(run);
			return [c("accent", fit(fit(head, w - src.length) + src, w)),
				...(lines.length ? lines : ["(no output yet)"]).map((l) => c(l.startsWith("⚠") ? "warning" : "dim", fit(`  ${l}`, w)))];
		}
		if (finalLine && useWidget()) return [c(finalLine.ok ? "success" : "error", fit(finalLine.text, w))];
		return [];
	}
	function show() {
		if (shown || !ui?.setWidget) return;
		shown = true;
		try {
			ui.setWidget(WIDGET, (tui: any, theme: any) => {
				requestRender = () => { try { tui?.requestRender?.(); } catch { /* ignore */ } };
				return { render: (width: number) => render(width, theme), invalidate: () => requestRender() };
			}, { placement: "aboveEditor" });
		} catch { shown = false; }
	}
	function hide() {
		if (!shown) return;
		shown = false; requestRender = () => {};
		try { ui?.setWidget?.(WIDGET, undefined); } catch { /* ignore */ }
	}

	// ----- watchdog (per-run adaptive limits) -----
	let history: History = {};
	try { history = JSON.parse(readFileSync(HISTORY, "utf8")) ?? {}; } catch { /* none yet */ }
	const saveHistory = () => { try { writeFileSync(HISTORY, JSON.stringify(history)); } catch { /* ignore */ } };
	function record(run: Run, ms: number) {
		try {
			if (ms < 3000) return;
			const list = (history[run.limits.sig] ??= []);
			list.push({ ms, gap: Math.max(run.maxGap, Date.now() - run.lastActivity), at: Date.now() });
			history[run.limits.sig] = list.slice(-10);
			const keys = Object.keys(history);
			if (keys.length > 200) for (const k of keys.sort((x, y) => (history[x].at(-1)?.at ?? 0) - (history[y].at(-1)?.at ?? 0)).slice(0, keys.length - 200)) delete history[k];
			saveHistory();
		} catch { /* ignore */ }
	}

	function watchdog(run: Run, now: number) {
		run.warning = undefined;
		if (!settings.watchdog || run.kept || run.stopped) return;
		const stallMs = run.limits.stallMin * 60_000, maxMs = run.limits.maxMin * 60_000;
		const warnMs = Math.min(settings.warnSec * 1000, stallMs / 2 || Infinity);
		const idle = now - run.lastActivity, total = now - run.start;
		let reason = "", kind: "stall" | "max" = "stall", left = Infinity;
		if (stallMs > 0 && idle >= stallMs - warnMs) { left = stallMs - idle; reason = `no new output for ${fmtElapsed(idle)}`; }
		if (maxMs > 0 && total >= maxMs - warnMs && maxMs - total < left) { left = maxMs - total; reason = `running for ${fmtElapsed(total)} (max ${fmtMin(run.limits.maxMin)})`; kind = "max"; }
		if (!reason) return;
		if (left <= 0) return void stopRun(run, reason, kind, kind === "max" ? String(run.limits.maxMin) : fmtElapsed(idle));
		run.warning = `${reason}, auto-stop in ${Math.ceil(left / 1000)}s (/livelog keep to continue)`;
		if (run.warned !== kind) {
			run.warned = kind;
			if (run.agent) BUS.parent?.notify(`live-log: ⤷ ${run.agent}: ${run.warning}`, "warning");
			else notify(run.ctx, `live-log: ${run.warning}`, "warning");
		}
	}

	// ----- language of the extension's own texts: follows the conversation (or /livelog lang) -----
	let lastAssistantText = "";
	pi.on("message_end", (event: any) => {
		try {
			const m = event?.message;
			if (m?.role !== "assistant") return;
			const t = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
			if (t.trim()) lastAssistantText = t.slice(-4000);
		} catch { /* ignore */ }
	});
	function lang(ctx?: any): Lang {
		if (settings.lang === "en" || settings.lang === "vi") return settings.lang;
		let text = lastAssistantText;
		try { // after /reload: fall back to the session history
			const entries = ctx?.sessionManager?.getEntries?.() ?? [];
			for (let i = entries.length - 1; !text && i >= 0 && i >= entries.length - 200; i--) {
				const m = entries[i]?.message;
				if (m?.role === "assistant") text = (m.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
			}
		} catch { /* ignore */ }
		return detectLang(text);
	}
	const reasonText = (L: Lang, kind: string, detail: string) =>
		kind === "manual" ? TXT[L].manual : kind === "max" ? TXT[L].max(+detail) : TXT[L].stall(detail);

	/** Analyse the log locally, record the summary, then abort the turn (like Esc; Pi kills the shell tree). */
	async function stopRun(run: Run, reason: string, kind: "stall" | "max" | "manual", detail: string) {
		if (run.stopped) return;
		const at = Date.now(), L = lang(run.ctx), T = TXT[L];
		run.stopped = { reason, kind, detail, at, lines: [], from: "stdout" };
		run.warning = `auto-stopping: ${reason}`;
		let all: string[] = [];
		try {
			for (const c of run.logs) { const t = await readTail(c, 200, run.start - 2000, 64 * 1024); if (t) { all = t.lines; run.stopped.from = t.path; break; } }
			if (!all.length) all = cleanLines(run.partial, 200);
		} catch { /* ignore */ }
		const elapsed = fmtElapsed(at - run.start), why = reasonText(L, kind, detail);
		const analysis = analyzeLog(all, L), line = verdict(analysis, elapsed, L);
		Object.assign(run.stopped, { analysis, analysisEn: L === "en" ? analysis : analyzeLog(all, "en"), lines: all.slice(-40) });
		stopSummaries.set(run.id, line);
		run.warning = line;
		if (useWidget()) { finalLine = { ok: false, text: line }; clearTimeout(finalTimer); finalTimer = setTimeout(() => { finalLine = undefined; void tick(); }, 15000); (finalTimer as any).unref?.(); }
		try { run.ctx?.abort?.(); } catch { /* ignore */ }
		if (run.agent) BUS.parent?.notify(`⤷ ${run.agent}: ${T.notify(line, why)}`, analysis.hasError ? "error" : "warning");
		else notify(run.ctx, T.notify(line, why), analysis.hasError ? "error" : "warning");
		try {
			const M = T.md;
			const md = `# ${M.title}\n\n- ${M.when}: ${new Date(at).toLocaleString("sv-SE")}\n- ${M.cmd}: \`${run.command.replace(/\s+/g, " ").slice(0, 300)}\`\n` +
				`- ${M.runtime}: ${elapsed}\n- ${M.reason}: ${why}\n- ${M.error}: ${analysis.hasError ? M.yes : M.no}\n` +
				analysis.errors.map((e) => `  - \`${e}\`\n`).join("") + `- ${M.why}: ${analysis.why}\n- ${M.src}: ${run.stopped.from}\n\n` +
				`## ${M.last(run.stopped.lines.length)}\n\n\`\`\`\n${run.stopped.lines.join("\n")}\n\`\`\`\n`;
			writeFileSync(LAST_STOP, md, "utf8");
		} catch { /* ignore */ }
		if (!runs.has(run.id)) void sendFollowUp(run); // tool already ended while we were analysing
	}

	/** After an auto-stop: wait for the agent to go idle, then ask for a summary (in the conversation's language) before any fix. */
	async function sendFollowUp(run: Run) {
		const st = run.stopped as any;
		if (!st?.analysis || st.sent) return; // stopRun calls again once the analysis is ready
		st.sent = true;
		if (run.agent) {
			// the child session is over (abort ended it) → tell the parent instead
			const elapsed = fmtElapsed(st.at - run.start), cmd = run.command.replace(/\s+/g, " ");
			BUS.parent?.send(`[live-log] Subagent "${run.agent}" was auto-stopped while running \`${run.tool}\` after ${elapsed} (${reasonText("en", st.kind, st.detail)}); its Agent call returned as aborted.\n` +
				`Command: ${cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd}\n` +
				`Local pre-analysis: ${verdict(st.analysisEn, elapsed, "en")}\n` +
				`Last ${st.lines.length} lines of ${st.from}:\n\`\`\`\n${st.lines.join("\n") || "(no output)"}\n\`\`\`\n` +
				"Give the user a short summary (command, runtime, stop reason, error yes/no with the exact lines, why it took long, next step) in the conversation's language. " +
				"Do not blindly re-run the subagent: rerun only with streamed output (`cmd 2>&1 | tee <log>`) or a longer limit (/livelog stall|max <min>) if the cause is unclear.");
			return;
		}
		const elapsed = fmtElapsed(st.at - run.start), cmd = run.command.replace(/\s+/g, " ");
		const msg = `[live-log] Auto-stopped \`${run.tool}\` after ${elapsed} (${reasonText("en", st.kind, st.detail)}).\n` +
			`Command: ${cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd}\n` +
			`Local pre-analysis: ${verdict(st.analysisEn, elapsed, "en")}\n` +
			`Last ${st.lines.length} lines of ${st.from}:\n\`\`\`\n${st.lines.join("\n") || "(no output)"}\n\`\`\`\n` +
			"Before fixing anything, give a short summary with these headings:\n" +
			"**Stopped command summary** — Command (short) · Runtime · Stop reason · Error? (yes/no/unclear; quote the exact error lines) · " +
			"Why it took long (from the log: compiling many files, downloading packages/toolchain, waiting for input, network hang, infinite loop, deadlock, silent process) · Next step.\n" +
			"Reply in the same language you have been using with the user in this conversation (translate the headings too). " +
			"Then fix only if the error is clear; otherwise do not guess: propose rerunning with streamed output (`cmd 2>&1 | tee <log>`) or a longer limit (/livelog stall|max <min>).";
		for (let i = 0; i < 75; i++) {
			try { if (!run.ctx?.isIdle || run.ctx.isIdle()) break; } catch { break; }
			await new Promise((r) => setTimeout(r, 200));
		}
		try {
			const idle = !run.ctx?.isIdle || run.ctx.isIdle();
			anyPi.sendUserMessage?.(msg, idle ? undefined : { deliverAs: "followUp" });
		} catch { /* ignore */ }
	}

	/** Refresh tails once per second, run the watchdog, show/hide the widget. */
	async function tick() {
		if (busy) return;
		busy = true;
		try {
			const now = Date.now();
			if (manual) manual.tail = (await readTail(manual.cands, settings.lines))?.lines ?? [];
			for (const run of runs.values()) {
				let got: Tail | undefined;
				for (const c of run.logs) if ((got = await readTail(c, settings.lines, run.start - 2000))) break;
				if (got) {
					run.tail = got.lines; run.source = basename(got.path); run.logPath = got.path;
					if (got.sig !== run.logSig) { run.logSig = got.sig; run.maxGap = Math.max(run.maxGap, now - run.lastActivity); run.lastActivity = now; }
				} else if (run.partial) { run.tail = cleanLines(run.partial, settings.lines); run.source = "stdout"; }
				else {
					for (const c of run.logs) if ((got = await readTail(c, settings.lines))) break;
					if (got) { run.tail = got.lines; run.source = `old ${basename(got.path)}`; }
				}
				watchdog(run, now);
			}
			const kids = BUS.parent?.id === instanceId && BUS.childRuns.size > 0;
			const wantWidget = manual || (settings.enabled && (latestRun() || childRun())) || (useWidget() && finalLine);
			if (wantWidget) { show(); requestRender(); } else hide();
			if (!manual && !runs.size && !kids && !finalLine && timer) { clearInterval(timer); timer = undefined; }
		} catch { /* never throw into Pi */ } finally { busy = false; }
	}
	const ensureTimer = () => { if (!timer) { timer = setInterval(() => void tick(), 1000); (timer as any).unref?.(); } };

	// ----- tool events -----
	pi.on("tool_execution_start", (event: any, ctx: any) => {
		try {
			claimParent(ctx);
			if (BUS.parent?.id === instanceId && event?.toolName === "Agent") {
				BUS.agents.set(event.toolCallId, String(event?.args?.name || event?.args?.description || event?.args?.subagent_type || "subagent"));
				return;
			}
			const command = event?.args?.command;
			if (!settings.enabled || typeof command !== "string" || !command.trim()) return;
			const child = isChild(ctx);
			if (!child) ui = ctx?.ui ?? ui;
			const cwd = ctx?.cwd ?? process.cwd(), now = Date.now();
			const info = inspectCommand(command, cwd);
			const limits = computeLimits(classify(command, info.scripts, info.dir), history, settings);
			const timeoutSec = typeof event?.args?.timeout === "number" ? event.args.timeout : undefined;
			runs.set(event.toolCallId, { id: event.toolCallId, tool: event.toolName ?? "shell", command, start: now, ctx, timeoutSec,
				partial: "", logs: info.logs, tail: [], source: "", lastActivity: now, logSig: "", maxGap: 0, limits });
			if (child) {
				const names = [...BUS.agents.values()];
				const run = runs.get(event.toolCallId)!;
				run.agent = names.length === 1 ? names[0] : names.length ? `subagent (${names.length} running)` : "subagent";
				BUS.childRuns.set(`${instanceId}:${run.id}`, run);
				BUS.parent?.wake();
			}
			ensureTimer();
		} catch { /* ignore */ }
	});

	pi.on("tool_execution_update", (event: any) => {
		try {
			const run = runs.get(event?.toolCallId);
			const text = (event?.partialResult?.content ?? []).filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
			if (run && text) {
				const t = text.slice(-TAIL_BYTES);
				if (t !== run.partial) { const now = Date.now(); run.partial = t; run.maxGap = Math.max(run.maxGap, now - run.lastActivity); run.lastActivity = now; }
			}
		} catch { /* ignore */ }
	});

	pi.on("tool_execution_end", (event: any) => {
		try {
			if (BUS.agents.delete(event?.toolCallId)) return;
			const run = runs.get(event?.toolCallId);
			if (!run) return;
			runs.delete(run.id);
			if (run.agent) { BUS.childRuns.delete(`${instanceId}:${run.id}`); BUS.parent?.wake(); }
			if (run.stopped) { void sendFollowUp(run); return void tick(); }
			const ms = event?.durationMs ?? Date.now() - run.start;
			if (!event?.isError) record(run, ms);
			if (ms < SHOW_AFTER_MS || !useWidget()) return void tick();
			const text = (event?.result?.content ?? []).map((p: any) => p?.text ?? "").join("\n");
			const code = text.match(/exit(?:ed with)? code[:\s]+(-?\d+)/i)?.[1];
			const ok = !event?.isError && (!code || code === "0");
			finalLine = { ok, text: `${ok ? "✓ done" : `✗ failed${code ? ` (exit ${code})` : ""}`} in ${fmtElapsed(ms)} · ${run.command.replace(/\s+/g, " ")}` };
			clearTimeout(finalTimer);
			finalTimer = setTimeout(() => { finalLine = undefined; void tick(); }, 5000);
			(finalTimer as any).unref?.();
			void tick();
		} catch { /* ignore */ }
	});

	// ----- /livelog -----
	const onOff = (v: string) => v.toLowerCase() === "on";
	pi.registerCommand("livelog", {
		description: "Live log: /livelog <path>|off|lines <n>|widget on|off|watchdog on|off|stall|max <min>|auto|limits|forget|keep|stop|last|lang",
		handler: async (args: string, ctx: any) => {
			try {
				ui = ctx?.ui ?? ui;
				const a = (args ?? "").trim(), say = (m: string) => notify(ctx, m);
				let m: RegExpMatchArray | null;
				if (!a) {
					const running = [...runs.values()].map((r) => `${fmtElapsed(Date.now() - r.start)} ${r.source || "-"} ${limitsHeader(r.limits, r.timeoutSec)}${r.kept ? " (kept)" : ""}`).join("; ");
					return say(`live-log: auto ${settings.enabled ? "on" : "off"}, in-row ${inRow ? "on" : "unavailable"}, widget ${settings.widget ? "on" : "off"}, ${settings.lines} lines, lang ${settings.lang}${settings.lang === "auto" ? ` (${lang(ctx)})` : ""}\n` +
						`watchdog ${settings.watchdog ? "on" : "off"}: stall ${settings.stallMin == null ? "auto" : settings.stallMin || "off"}, max ${settings.maxMin == null ? "auto" : settings.maxMin || "off"}, warn ${settings.warnSec}s (/livelog limits)` +
						`${running ? `\nrunning: ${running}` : ""}${manual ? `\ntailing ${manual.label}` : ""}\n` +
						"Usage: /livelog <path> | off | lines <n> | widget on|off | auto on|off | watchdog on|off | stall <min>|auto | max <min>|auto (0 = off) | limits | forget <sig>|all | keep | stop | last | lang auto|en|vi");
				}
				if (a === "last") {
					try { return say(readFileSync(LAST_STOP, "utf8").split("\n").slice(0, 70).join("\n")); } catch { return say(TXT[lang(ctx)].none); }
				}
				if (a === "off") { manual = undefined; await tick(); return say("live-log: manual tail stopped"); }
				if (a === "keep") {
					const live = [...runs.values()].filter((r) => !r.stopped);
					live.forEach((r) => { r.kept = true; r.warning = undefined; });
					return say(live.length ? "live-log: watchdog disabled for the running command" : "live-log: nothing running");
				}
				if (a === "stop") {
					const run = [...runs.values()].filter((r) => !r.stopped).pop();
					if (!run) return say("live-log: nothing running");
					run.ctx = run.ctx ?? ctx;
					return void stopRun(run, "stopped with /livelog stop", "manual", "");
				}
				if ((m = a.match(/^lang\s+(auto|en|vi)$/i))) { settings.lang = m[1].toLowerCase() as any; save(); return say(`live-log: lang ${settings.lang}`); }
				if ((m = a.match(/^lines\s+(\d+)$/i))) { settings.lines = Math.min(40, Math.max(1, +m[1])); save(); await tick(); return say(`live-log: ${settings.lines} lines`); }
				if ((m = a.match(/^(auto|widget|watchdog)\s+(on|off)$/i))) {
					const key = m[1].toLowerCase() === "auto" ? "enabled" : (m[1].toLowerCase() as "widget" | "watchdog");
					settings[key] = onOff(m[2]); save(); await tick(); return say(`live-log: ${m[1]} ${m[2]}`);
				}
				if ((m = a.match(/^(stall|max)\s+(auto|\d+(?:\.\d+)?)$/i))) {
					const key = m[1].toLowerCase() === "stall" ? "stallMin" : "maxMin", v = m[2].toLowerCase() === "auto" ? null : Math.max(0, +m[2]);
					settings[key] = v; save(); return say(`live-log: ${m[1].toLowerCase()} ${v == null ? "auto (per command)" : v ? v + "m (global override)" : "off"}`);
				}
				if (a === "limits") {
					const cats = [...CATEGORIES, QUICK_CAT, DEFAULT_CAT].map((c) => `  ${c.name}: stall ${c.stall}m, max ${c.max}m`).join("\n");
					const hist = Object.entries(history).map(([k, v]) => `  ${k}: ${v.length} runs, p90 ${fmtElapsed(p90(v.map((e) => e.ms)))}, longest silence ${fmtElapsed(Math.max(...v.map((e) => e.gap || 0)))}`).join("\n");
					return say(`live-log limits (override: stall ${settings.stallMin ?? "auto"}, max ${settings.maxMin ?? "auto"})\n${cats}\nlearned (${HISTORY}):\n${hist || "  (none yet)"}\n` +
						"With ≥2 successful runs: max = max(category, 2×p90), stall = max(category, 1.5×longest silence).");
				}
				if ((m = a.match(/^forget\s+(.+)$/i))) {
					const q = m[1].trim(), keys = q === "all" ? Object.keys(history) : Object.keys(history).filter((k) => k === q || k.toLowerCase().includes(q.toLowerCase()));
					keys.forEach((k) => delete history[k]); saveHistory();
					return say(`live-log: forgot ${keys.length} signature(s)${keys.length ? `: ${keys.join(", ")}` : ""}`);
				}
				const cands = toCandidates(a, ctx?.cwd ?? process.cwd());
				if (!cands.length) return say(`live-log: cannot resolve path ${a}`);
				manual = { label: cands.find((p) => existsSync(p)) ?? cands[0], cands, tail: [] };
				ensureTimer(); await tick();
				say(`live-log: tailing ${manual.label} (/livelog off to stop)`);
			} catch { /* ignore */ }
		},
	});

	pi.on("session_shutdown", () => {
		try {
			if (timer) clearInterval(timer); timer = undefined; clearTimeout(finalTimer);
			for (const [k, r] of BUS.childRuns) if (k.startsWith(`${instanceId}:`) && !r.stopped) BUS.childRuns.delete(k);
			if (BUS.parent?.id === instanceId) BUS.parent = undefined;
		} catch { /* ignore */ }
	});
}
