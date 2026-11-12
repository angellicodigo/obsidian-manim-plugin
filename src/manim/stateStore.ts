import { MarkdownPostProcessorContext } from 'obsidian';

export interface BlockState {
	isCollapsed: boolean;
	cursor?: { anchor: number; head: number };
	scroll?: { top: number; left: number };
	hadFocus?: boolean;
	timestamp: number;
}

// Map from unique block key to its state
const blockStateCache = new Map<string, BlockState>();

// lastActiveBlockByFile removed: no cross-block fallback. State is keyed per block only.

export function getBlockKey(ctx: MarkdownPostProcessorContext, el: HTMLElement): string {
	const sectionInfo = ctx.getSectionInfo(el);
	if (sectionInfo) {
		return `${ctx.sourcePath}::line:${sectionInfo.lineStart}`;
	}
	return `${ctx.sourcePath}::el:${el.id || 'default'}`;
}

export function saveBlockState(
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	updates: Partial<BlockState>,
): void {
	const key = getBlockKey(ctx, el);
	const existing = blockStateCache.get(key) ?? {
		isCollapsed: false,
		timestamp: Date.now(),
	};

	const merged: BlockState = {
		...existing,
		...updates,
		timestamp: Date.now(),
	};

	blockStateCache.set(key, merged);
}

export function getPersistedBlockState(
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
): BlockState | undefined {
	const key = getBlockKey(ctx, el);
	return blockStateCache.get(key);
}
