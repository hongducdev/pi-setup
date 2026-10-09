/**
 * Compacts noisy extension statuses shown in pi-footer.
 * - advisor-usage: "Advisor: 4 calls · ↑27k ↓8.5k cr:3.1k cw:0 · $0.0184" -> "Advisor 4× $0.0184"
 * - mcp:           "MCP: 1 server enabled" -> "MCP 1" (other MCP messages keep their text, minus "MCP: ")
 * - pi-lens-lsp:   "LSP Inactive" -> hidden; "LSP Active: ts, py" -> "LSP ts, py"; failures stay visible
 * Works by wrapping the shared extension UI context's setStatus; re-applied on every session start/reload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WRAPPED = Symbol.for("footer-compact.wrapped");
const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "").trim();

function compactAdvisor(text: string): string {
	const p = plain(text);
	const calls = p.match(/(\d+)\s+calls?/)?.[1];
	const cost = p.match(/\$\d+(?:\.\d+)?/)?.[0];
	if (!calls) return text;
	return cost ? `Advisor ${calls}× ${cost}` : `Advisor ${calls}×`;
}

function compactMcp(text: string): string {
	const p = plain(text);
	const enabled = p.match(/^MCP:\s*(\d+)\s+servers?\s+enabled$/i);
	if (enabled) return `MCP ${enabled[1]}`;
	return p.startsWith("MCP: ") ? text.replace("MCP: ", "MCP ") : text;
}

function compactLsp(text: string): string | undefined {
	const p = plain(text);
	if (/^LSP Inactive$/i.test(p)) return undefined;
	return text.replace("LSP Active: ", "LSP ");
}

function compact(key: string, text: string | undefined): string | undefined {
	if (typeof text !== "string") return text;
	if (key === "advisor-usage") return compactAdvisor(text);
	if (key === "mcp") return compactMcp(text);
	if (key === "pi-lens-lsp") return compactLsp(text);
	return text;
}

export default function footerCompact(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const ui: any = ctx.ui;
		if (!ui || typeof ui.setStatus !== "function" || ui.setStatus[WRAPPED]) return;
		const original = ui.setStatus.bind(ui);
		const wrapped = (key: string, text: string | undefined) => original(key, compact(key, text));
		(wrapped as any)[WRAPPED] = true;
		ui.setStatus = wrapped;
	});
}