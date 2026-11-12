import { Plugin } from 'obsidian';
import { registerManimCodeBlockProcessor } from './manim/codeBlockProcessor';
import { DEFAULT_SETTINGS, ManimEditorFont, ManimEditorTheme, ManimPluginSettings, ManimSettingTab } from './settings';

/** What the plugin needs from an open embedded editor so setting changes apply live. */
export interface ManimEditor {
	setEditorTheme(theme: ManimEditorTheme): void;
	setVimEnabled(enabled: boolean): void;
	setEditorFontFamily(font: ManimEditorFont): void;
	setEditorFontSize(px: number): void;
}

export default class ManimPlugin extends Plugin {
	settings: ManimPluginSettings = { ...DEFAULT_SETTINGS };
	private readonly activeEditors = new Set<ManimEditor>();

	registerActiveEditor(editor: ManimEditor): void {
		this.activeEditors.add(editor);
	}

	unregisterActiveEditor(editor: ManimEditor): void {
		this.activeEditors.delete(editor);
	}

	/** Runs `action` on every open editor, isolating failures so one bad editor can't block the rest. */
	applyToEditors(action: (editor: ManimEditor) => void): void {
		for (const editor of this.activeEditors) {
			try {
				action(editor);
			} catch (err) {
				console.error('Failed to update manim editor', err);
			}
		}
	}

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new ManimSettingTab(this.app, this));

		this.registerEvent(
			(this.app.vault as any).on('config-changed', () => {
				const isVim = Boolean((this.app.vault as any).getConfig('vimMode'));
				this.applyToEditors((editor) => editor.setVimEnabled(isVim));
			})
		);

		registerManimCodeBlockProcessor(this);
	}

	onunload() {
		this.activeEditors.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ManimPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
