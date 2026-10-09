/**
 * Shows the pi-antigravity account currently in use in pi-footer (event widget "ag_account").
 * Reads only activeAccountId/email from ~/.pi/agent/antigravity-accounts.json (never tokens),
 * and refreshes when the file changes (e.g. automatic failover to the next account).
 */
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UPDATE_WIDGET_EVENT = "pi-footer:update-widget";
const WIDGET_ID = "ag_account";
const accountsPath = () =>
	join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "antigravity-accounts.json");

function activeAccountLabel(): string {
	try {
		const data = JSON.parse(readFileSync(accountsPath(), "utf8"));
		const accounts = data?.accounts && typeof data.accounts === "object" ? data.accounts : {};
		const ids = Object.keys(accounts);
		const id = typeof data?.activeAccountId === "string" ? data.activeAccountId : undefined;
		if (!id || !accounts[id]) return ids.length ? "chưa chọn" : "";
		const email: string = typeof accounts[id].email === "string" ? accounts[id].email : id;
		const position = ids.length > 1 ? ` ${ids.indexOf(id) + 1}/${ids.length}` : "";
		return `${email}${position}`;
	} catch {
		return "";
	}
}

export default function antigravityAccountFooter(pi: ExtensionAPI): void {
	let isAntigravity = false;
	let watching = false;

	const publish = () => {
		pi.events.emit(UPDATE_WIDGET_EVENT, { widgetId: WIDGET_ID, value: isAntigravity ? activeAccountLabel() : "" });
	};
	const setProvider = (provider: unknown) => {
		isAntigravity = typeof provider === "string" && provider.toLowerCase().includes("antigravity");
		publish();
	};

	pi.on("session_start", async (_event, ctx) => {
		setProvider((ctx as any).model?.provider);
		if (!watching) {
			watchFile(accountsPath(), { interval: 2000 }, publish);
			watching = true;
		}
	});
	pi.on("model_select", async (event: any, ctx: any) => {
		setProvider(event?.model?.provider ?? ctx?.model?.provider);
	});
	pi.on("turn_end", () => publish());
	pi.on("session_shutdown", () => {
		if (watching) unwatchFile(accountsPath());
		watching = false;
	});
}