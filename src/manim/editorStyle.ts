import { EditorView } from '@codemirror/view';
import type { ManimEditorFont } from '../settings';

export const manimEditorTheme = EditorView.theme({
	'&': {
		backgroundColor: 'var(--code-background, var(--background-primary))',
		color: 'var(--manim-code-color, var(--code-normal, var(--text-normal)))',
	},
	'.cm-content': {
		caretColor: '#ffffff !important',
	},
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
		backgroundColor: 'var(--manim-selection-color, var(--text-selection)) !important',
	},
	'.cm-fat-cursor, &:not(.cm-focused) .cm-fat-cursor, &.cm-focused .cm-fat-cursor': {
		position: 'absolute',
		backgroundColor: 'var(--manim-vim-cursor-color, #8b0000) !important',
		border: 'none !important',
		borderLeft: 'none !important',
		outline: 'none !important',
		whiteSpace: 'pre',
		zIndex: '10 !important',
		color: 'transparent !important',
		opacity: '0.85 !important',
	},
	'.cm-cursor:not(.cm-fat-cursor), .cm-dropCursor': {
		borderLeft: '2px solid #ffffff !important',
		borderLeftColor: '#ffffff !important',
		borderLeftWidth: '2px !important',
		zIndex: '10 !important',
		opacity: '1 !important',
	},
});

function setVarFromComputed(host: HTMLElement, name: string, element: Element | null, property: string): void {
	if (!(element instanceof HTMLElement)) {
		return;
	}
	const value = getComputedStyle(element).getPropertyValue(property);
	if (value.trim()) {
		host.style.setProperty(name, value);
	}
}

/**
 * Builds the CSS `font-family` value for the editor. The generic `monospace` keyword must not be
 * quoted (a quoted 'Monospace' is looked up as a font *name*), and Obsidian's own monospace font is
 * always the fallback for fonts that aren't installed.
 */
export function buildFontStack(font: ManimEditorFont): string {
	const family = font === 'Monospace' ? 'monospace' : `'${font}'`;
	return `${family}, var(--font-monospace)`;
}

export function syncStylesFromNativeCodeMirror(hostEl: HTMLElement): void {
	// Mirror colors/spacing from the currently visible native CM6 editor.
	// Font family and size are NOT mirrored: they come from the plugin settings (see ManimCodeEditorChild).
	const nativeContent = document.querySelector('.markdown-source-view.mod-cm6 .cm-editor .cm-content');
	const nativeSelection = document.querySelector('.markdown-source-view.mod-cm6 .cm-editor .cm-selectionBackground');

	// Note: We use var(--code-background) directly to match Python and native code blocks,
	// rather than reading nativeEditor (which is transparent in grid/canvas themes).
	setVarFromComputed(hostEl, '--manim-code-color', nativeContent, 'color');
	setVarFromComputed(hostEl, '--manim-code-line-height', nativeContent, 'line-height');
	setVarFromComputed(hostEl, '--manim-code-letter-spacing', nativeContent, 'letter-spacing');
	setVarFromComputed(hostEl, '--manim-code-font-weight', nativeContent, 'font-weight');
	setVarFromComputed(hostEl, '--manim-selection-color', nativeSelection, 'background-color');
}
