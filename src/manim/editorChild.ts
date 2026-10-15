import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { MarkdownPostProcessorContext, MarkdownRenderChild, Plugin } from 'obsidian';
import { manimEditorTheme } from './editorStyle';
import { getEditorThemeExtension } from './editorThemes';
import { persistManimCode } from './sourcePersistence';
import { ManimEditorTheme } from '../settings';

export class ManimCodeEditorChild extends MarkdownRenderChild {
	private editorView: EditorView | null = null;
	private saveTimer: number | null = null;
	private hideSavedTimer: number | null = null;
	private themeCompartment = new Compartment();

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly contextEl: HTMLElement,
		private readonly editorHostEl: HTMLElement,
		private readonly initialSource: string,
		private readonly saveStateEl: HTMLElement,
		private readonly theme: ManimEditorTheme,
	) {
		super(editorHostEl);
	}

	onload(): void {
		const state = EditorState.create({
			doc: this.initialSource,
			extensions: [
				history(),
				drawSelection(),
				highlightActiveLine(),
				manimEditorTheme,
				this.themeCompartment.of(getEditorThemeExtension(this.theme)),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				javascript({ typescript: true }),
				EditorView.lineWrapping,
				EditorState.tabSize.of(4),
				indentUnit.of('    '),
				keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						this.scheduleSave();
					}
				}),
			],
		});

		this.editorView = new EditorView({
			state,
			parent: this.editorHostEl,
		});
		this.editorView.dom.classList.add('cm-s-obsidian');
		(this.plugin as any).registerActiveEditor?.(this);
	}

	onunload(): void {
		(this.plugin as any).unregisterActiveEditor?.(this);
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
		}
		if (this.hideSavedTimer !== null) {
			window.clearTimeout(this.hideSavedTimer);
		}
		this.editorView?.destroy();
		this.editorView = null;
	}

	setEditorTheme(newTheme: ManimEditorTheme): void {
		if (this.editorView) {
			this.editorView.dispatch({
				effects: this.themeCompartment.reconfigure(getEditorThemeExtension(newTheme)),
			});
		}
	}

	getCode(): string {
		return this.editorView?.state.doc.toString() ?? this.initialSource;
	}

	async flushPendingSave(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
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
		// Import MyPlugin type to access settings
		const delayMs = ((this.plugin as any).settings.autoSaveDelaySeconds ?? 60) * 1000;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.persistChanges();
		}, delayMs);
	}

	private async persistChanges(): Promise<void> {
		await persistManimCode(this.plugin, this.ctx, this.contextEl, this.getCode());
		this.setSaveState('Saved');
		if (this.hideSavedTimer !== null) {
			window.clearTimeout(this.hideSavedTimer);
		}
		this.hideSavedTimer = window.setTimeout(() => {
			this.hideSavedTimer = null;
			this.setSaveState('');
		}, 1000);
	}
}
