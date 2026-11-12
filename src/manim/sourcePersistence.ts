import { MarkdownPostProcessorContext, TFile } from 'obsidian';
import type ManimPlugin from '../main';

const OPENING_FENCE = /^\s*(`{3,}|~{3,})\s*manim\b/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Writes `code` back into the ```manim block that `contextEl` was rendered from.
 * The block is located by line range and re-validated against the *current* file contents
 * inside an atomic read-modify-write, so a stale range can never overwrite unrelated lines.
 */
export async function persistManimCode(
	plugin: ManimPlugin,
	ctx: MarkdownPostProcessorContext,
	contextEl: HTMLElement,
	code: string,
): Promise<void> {
	const sectionInfo = ctx.getSectionInfo(contextEl);
	if (!sectionInfo) {
		return;
	}

	const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) {
		return;
	}

	const { lineStart, lineEnd } = sectionInfo;
	await plugin.app.vault.process(file, (data) => {
		const eol = data.includes('\r\n') ? '\r\n' : '\n';
		const lines = data.split(eol);
		const opening = lines[lineStart];
		const closing = lines[lineEnd];
		if (opening === undefined || closing === undefined || !OPENING_FENCE.test(opening) || !CLOSING_FENCE.test(closing)) {
			return data;
		}

		lines.splice(lineStart, lineEnd - lineStart + 1, opening, ...code.split('\n'), closing);
		return lines.join(eol);
	});
}
