import { Plugin } from 'obsidian';
import { registerManimCodeBlockProcessor } from './manim/codeBlockProcessor';
import { DEFAULT_SETTINGS, ManimEditorTheme, MyPluginSettings, SampleSettingTab } from './settings';

export interface ThemeableEditor {
	setEditorTheme(newTheme: ManimEditorTheme): void;
	setVimEnabled?(enabled: boolean): void;
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private activeEditors = new Set<ThemeableEditor>();

	registerActiveEditor(editor: ThemeableEditor) {
		this.activeEditors.add(editor);
	}

	unregisterActiveEditor(editor: ThemeableEditor) {
		this.activeEditors.delete(editor);
	}

	updateAllEditorThemes(newTheme: ManimEditorTheme) {
		for (const editor of this.activeEditors) {
			try {
				editor.setEditorTheme(newTheme);
			} catch (err) {
				console.error('Failed to update editor theme', err);
			}
		}
	}

	updateAllEditorVim(enabled: boolean) {
		for (const editor of this.activeEditors) {
			try {
				editor.setVimEnabled?.(enabled);
			} catch (err) {
				console.error('Failed to update editor vim mode', err);
			}
		}
	}

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerEvent(
			(this.app.vault as any).on('config-changed', () => {
				const isVim = Boolean((this.app.vault as any).getConfig('vimMode'));
				this.updateAllEditorVim(isVim);
			})
		);

		registerManimCodeBlockProcessor(this);
	}

	onunload() {
		this.activeEditors.clear();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
