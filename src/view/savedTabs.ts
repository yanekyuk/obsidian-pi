export interface SavedTab {
	sessionFile: string;
	title: string;
}

// The tabs as the workspace layout keeps them. Older layouts held a single session.
export function savedTabsFrom(state: unknown): { tabs: SavedTab[]; active: number } | null {
	const saved = state as { tabs?: unknown; active?: unknown; sessionFile?: unknown; fresh?: unknown } | null;
	if (Array.isArray(saved?.tabs)) {
		const tabs = (saved.tabs as { sessionFile?: unknown; title?: unknown }[])
			.filter((tab) => typeof tab?.sessionFile === "string")
			.map((tab) => ({ sessionFile: tab.sessionFile as string, title: typeof tab.title === "string" ? tab.title : "" }));
		return { tabs, active: typeof saved.active === "number" ? saved.active : 0 };
	}
	if (typeof saved?.sessionFile === "string") return { tabs: [{ sessionFile: saved.sessionFile, title: "" }], active: 0 };
	return saved?.fresh === true ? { tabs: [], active: 0 } : null;
}
