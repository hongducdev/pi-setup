import { Key, matchesKey } from "@earendil-works/pi-tui";

/** Keys that accept a visible ghost suggestion while the editor is empty. */
export type GhostAcceptKey = "space" | "right";

export const DEFAULT_GHOST_ACCEPT_KEYS: readonly GhostAcceptKey[] = ["space"];

export function isGhostAcceptKey(value: unknown): value is GhostAcceptKey {
	return value === "space" || value === "right";
}

/** Drop unknown entries, de-duplicate, and fall back to the default when nothing valid remains. */
export function normalizeGhostAcceptKeys(keys?: readonly GhostAcceptKey[] | undefined): GhostAcceptKey[] {
	const normalized = (keys ?? DEFAULT_GHOST_ACCEPT_KEYS).filter(isGhostAcceptKey);
	return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_GHOST_ACCEPT_KEYS];
}

export function matchesGhostAcceptKey(data: string, keys?: readonly GhostAcceptKey[] | undefined): boolean {
	return normalizeGhostAcceptKeys(keys).some((key) =>
		key === "space" ? matchesKey(data, Key.space) : matchesKey(data, Key.right),
	);
}

export function formatGhostAcceptKeys(keys?: readonly GhostAcceptKey[] | undefined): string {
	return normalizeGhostAcceptKeys(keys)
		.map((key) => (key === "space" ? "Space" : "Right"))
		.join("/");
}
