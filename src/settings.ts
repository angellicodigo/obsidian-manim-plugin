import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";

export type ManimEditorTheme = 'obsidian' | 'github-light' | 'github-dark' | 'one-dark' | 'monokai';

export interface MyPluginSettings {
	editorTheme: ManimEditorTheme;
	autoSaveDelaySeconds: number;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	editorTheme: 'obsidian',
	autoSaveDelaySeconds: 60,
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();
		new Setting(containerEl)
			.setName('Editor theme')
			.setDesc('Syntax highlighting theme used in the embedded manim editor.')
			.addDropdown((dropdown) => dropdown
				.addOption('obsidian', 'Obsidian (match current UI)')
				.addOption('github-light', 'GitHub Light')
				.addOption('github-dark', 'GitHub Dark')
				.addOption('one-dark', 'One Dark')
				.addOption('monokai', 'Monokai')
				.setValue(this.plugin.settings.editorTheme)
				.onChange(async (value: ManimEditorTheme) => {
					this.plugin.settings.editorTheme = value;
					await this.plugin.saveSettings();
					this.plugin.updateAllEditorThemes(value);
				}));

		new Setting(containerEl)
			.setName('Auto-save delay')
			.setDesc('Seconds to wait after editing stops before auto-saving to disk. (1-300, default: 5)')
			.addText((text) => text
				.setPlaceholder('5')
				.setValue(String(this.plugin.settings.autoSaveDelaySeconds))
				.onChange(async (value: string) => {
					const numValue = parseInt(value, 10);
					if (!isNaN(numValue) && numValue >= 1 && numValue <= 300) {
						this.plugin.settings.autoSaveDelaySeconds = numValue;
						await this.plugin.saveSettings();
					}
				}));
	}
}
