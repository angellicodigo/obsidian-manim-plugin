/** Runs `action`, swallowing any error (used for best-effort cleanup and optional scene hooks). */
export function safely(action: () => unknown): void {
	try { action(); } catch { /* ignore */ }
}
