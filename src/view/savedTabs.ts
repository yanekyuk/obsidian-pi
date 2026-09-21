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

// Panes of a given view type in a saved workspace layout (workspace.json), wherever they sit in
// its tree, with the tabs they hold. Only panes whose state is plainly a list of session files.
export function panelsIn(layout: unknown, viewType: string): { id: string; tabs: SavedTab[] }[] {
	const found: { id: string; tabs: SavedTab[] }[] = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		const leaf = node as { id?: unknown; type?: unknown; state?: { type?: unknown; state?: unknown } };
		if (leaf.type === "leaf" && leaf.state?.type === viewType && typeof leaf.id === "string") {
			const tabs = savedTabsFrom(leaf.state.state)?.tabs ?? [];
			if (tabs.length && tabs.every((tab) => tab.sessionFile.endsWith(".jsonl"))) found.push({ id: leaf.id, tabs });
		}
		Object.values(node).forEach(walk);
	};
	walk(layout);
	return found;
}
