import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { vim } from '@replit/codemirror-vim';
import { MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian';
import type ManimPlugin from '../main';
import type { ManimEditor } from '../main';
import type { ManimEditorFont, ManimEditorTheme } from '../settings';
import { buildFontStack, manimEditorTheme } from './editorStyle';
import { getEditorThemeExtension } from './editorThemes';
import { persistManimCode } from './sourcePersistence';
import { BlockState, saveBlockState } from './stateStore';

const SAVED_INDICATOR_MS = 1000;

function isVimEnabled(plugin: ManimPlugin): boolean {
	const app = plugin.app as any;
	if (typeof app?.vault?.getConfig === 'function') {
		return Boolean(app.vault.getConfig('vimMode'));
	}
	if (typeof app?.isVimEnabled === 'function') {
		return Boolean(app.isVimEnabled());
	}
	return Boolean((window as any)?.CodeMirrorAdapter?.Vim);
}

export class ManimCodeEditorChild extends MarkdownRenderChild implements ManimEditor {
	private editorView: EditorView | null = null;
	private saveTimer: number | null = null;
	private hideSavedTimer: number | null = null;
	private readonly themeCompartment = new Compartment();
	private readonly vimCompartment = new Compartment();

	constructor(
		private readonly plugin: ManimPlugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly contextEl: HTMLElement,
		private readonly editorHostEl: HTMLElement,
		private readonly initialSource: string,
		private readonly saveStateEl: HTMLElement,
		private readonly theme: ManimEditorTheme,
		private readonly savedState?: BlockState,
	) {
		super(editorHostEl);
	}

	onload(): void {
		const { settings } = this.plugin;

		// Font family/size are CSS variables on the host element, consumed by styles.css.
		this.setEditorFontFamily(settings.editorFontFamily);
		this.setEditorFontSize(settings.editorFontSize);

		const extensions: Extension[] = [
			this.vimCompartment.of(isVimEnabled(this.plugin) ? vim() : []),
			history(),
			drawSelection(),
			highlightActiveLine(),
			closeBrackets(),
			manimEditorTheme,
			this.themeCompartment.of(getEditorThemeExtension(this.theme)),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			javascript({ typescript: true }),
			EditorView.lineWrapping,
			EditorState.tabSize.of(4),
			indentUnit.of('    '),
			keymap.of([indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					this.scheduleSave();
				}
				if (update.selectionSet || update.docChanged) {
					this.recordCurrentState();
				}
			}),
		];

		const maxPos = this.initialSource.length;
		const clampPos = (pos: number) => Math.max(0, Math.min(pos, maxPos));
		const cursor = this.savedState?.cursor;

		this.editorView = new EditorView({
			state: EditorState.create({
				doc: this.initialSource,
				selection: cursor ? { anchor: clampPos(cursor.anchor), head: clampPos(cursor.head) } : undefined,
				extensions,
			}),
			parent: this.editorHostEl,
		});
		this.editorView.dom.classList.add('cm-s-obsidian');

		this.registerDomEvent(this.editorView.scrollDOM, 'scroll', () => this.recordCurrentState(), { passive: true });

		const scroll = this.savedState?.scroll;
		const hadFocus = this.savedState?.hadFocus;
		if (scroll || hadFocus) {
			requestAnimationFrame(() => {
				const view = this.editorView;
				if (!view) {
					return;
				}
				if (scroll) {
					view.scrollDOM.scrollTop = scroll.top;
					view.scrollDOM.scrollLeft = scroll.left;
				}
				if (hadFocus && !view.hasFocus) {
					view.focus();
				}
			});
		}

		this.registerDomEvent(this.editorHostEl, 'pointerdown', () => {
			if (this.editorView && !this.editorView.hasFocus) {
				this.editorView.focus();
			}
			this.recordCurrentState();
		});

		this.plugin.registerActiveEditor(this);
	}

	onunload(): void {
		this.recordCurrentState();
		this.plugin.unregisterActiveEditor(this);
		if (this.saveTimer !== null) {
			// Don't lose edits that were still waiting for the auto-save delay (best effort).
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.persistChanges();
		}
		if (this.hideSavedTimer !== null) {
			window.clearTimeout(this.hideSavedTimer);
		}
		this.editorView?.destroy();
		this.editorView = null;
	}

	recordCurrentState(forceCollapsed?: boolean): void {
		if (!this.editorView) return;
		const sel = this.editorView.state.selection.main;
		saveBlockState(this.ctx, this.contextEl, {
			cursor: { anchor: sel.anchor, head: sel.head },
			scroll: {
				top: this.editorView.scrollDOM.scrollTop,
				left: this.editorView.scrollDOM.scrollLeft,
			},
			hadFocus: this.editorView.hasFocus,
			...(forceCollapsed !== undefined ? { isCollapsed: forceCollapsed } : {}),
		});
	}

	setEditorTheme(newTheme: ManimEditorTheme): void {
		this.editorView?.dispatch({
			effects: this.themeCompartment.reconfigure(getEditorThemeExtension(newTheme)),
		});
	}

	setVimEnabled(enabled: boolean): void {
		this.editorView?.dispatch({
			effects: this.vimCompartment.reconfigure(enabled ? vim() : []),
		});
	}

	setEditorFontFamily(fontFamily: ManimEditorFont): void {
		this.editorHostEl.style.setProperty('--manim-code-font-family', buildFontStack(fontFamily));
		this.editorView?.requestMeasure();
	}

	setEditorFontSize(px: number): void {
		this.editorHostEl.style.setProperty('--manim-code-font-size', `${px}px`);
		this.editorView?.requestMeasure();
	}

	getCode(): string {
		return this.editorView?.state.doc.toString() ?? this.initialSource;
	}

	requestMeasure(): void {
		this.editorView?.requestMeasure();
	}

	/** Saves immediately if (and only if) there are edits waiting for the auto-save timer. */
	async flushPendingSave(): Promise<void> {
		if (this.saveTimer === null) {
			return;
		}
		window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		await this.persistChanges();
	}

	private setSaveState(text: string): void {
		this.saveStateEl.textContent = text;
		this.saveStateEl.style.display = text ? 'inline-block' : 'none';
	}

	private scheduleSave(): void {
		this.setSaveState('Saving...');
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.persistChanges();
		}, this.plugin.settings.autoSaveDelaySeconds * 1000);
	}

	private async persistChanges(): Promise<void> {
		this.recordCurrentState();
		try {
			await persistManimCode(this.plugin, this.ctx, this.contextEl, this.getCode());
		} catch (error) {
			console.error('Failed to save manim code block', error);
			this.setSaveState('Save failed');
			return;
		}
		this.setSaveState('Saved');
		if (this.hideSavedTimer !== null) {
			window.clearTimeout(this.hideSavedTimer);
		}
		this.hideSavedTimer = window.setTimeout(() => {
			this.hideSavedTimer = null;
			// The status label is shared with run state ("Running...", "Paused"): only clear our own text.
			if (this.saveStateEl.textContent === 'Saved') {
				this.setSaveState('');
			}
		}, SAVED_INDICATOR_MS);
	}
}
