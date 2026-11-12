import { App, PluginSettingTab, Setting } from 'obsidian';
import type ManimPlugin from './main';

export type ManimEditorTheme = 'obsidian' | 'github-light' | 'github-dark' | 'one-dark' | 'monokai';

export type ManimEditorFont = 'JetBrains Mono' | 'Monospace' | 'Fira Code' | 'Lucida Console' | 'Consolas';

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;
const MIN_AUTOSAVE_DELAY = 1;
const MAX_AUTOSAVE_DELAY = 300;

export interface ManimPluginSettings {
	editorTheme: ManimEditorTheme;
	editorFontFamily: ManimEditorFont;
	editorFontSize: number;
	autoSaveDelaySeconds: number;
	defaultCollapsed: boolean;
}

export const DEFAULT_SETTINGS: ManimPluginSettings = {
	editorTheme: 'obsidian',
	editorFontFamily: 'JetBrains Mono',
	editorFontSize: 14,
	autoSaveDelaySeconds: 60,
	defaultCollapsed: false,
};

const THEME_OPTIONS: Record<ManimEditorTheme, string> = {
	'obsidian': 'Obsidian (match current UI)',
	'github-light': 'GitHub Light',
	'github-dark': 'GitHub Dark',
	'one-dark': 'One Dark',
	'monokai': 'Monokai',
};

const FONT_OPTIONS: ManimEditorFont[] = ['JetBrains Mono', 'Monospace', 'Fira Code', 'Lucida Console', 'Consolas'];

/** Parses `value` as an integer in [min, max]. Returns null when it is not a valid value. */
function parseIntInRange(value: string, min: number, max: number): number | null {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed < min || parsed > max ? null : parsed;
}

export class ManimSettingTab extends PluginSettingTab {
	plugin: ManimPlugin;

	constructor(app: App, plugin: ManimPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Editor theme')
			.setDesc('Syntax highlighting theme used in the embedded manim editor.')
			.addDropdown((dropdown) => dropdown
				.addOptions(THEME_OPTIONS)
				.setValue(settings.editorTheme)
				.onChange(async (value) => {
					settings.editorTheme = value as ManimEditorTheme;
					await this.plugin.saveSettings();
					this.plugin.applyToEditors((editor) => editor.setEditorTheme(settings.editorTheme));
				}));

		new Setting(containerEl)
			.setName('Editor font')
			.setDesc('Font used by embedded manim code editors. The font must be installed on your system, otherwise Obsidian\'s monospace font is used.')
			.addDropdown((dropdown) => {
				for (const font of FONT_OPTIONS) {
					dropdown.addOption(font, font);
				}
				dropdown
					.setValue(settings.editorFontFamily)
					.onChange(async (value) => {
						settings.editorFontFamily = value as ManimEditorFont;
						await this.plugin.saveSettings();
						this.plugin.applyToEditors((editor) => editor.setEditorFontFamily(settings.editorFontFamily));
					});
			});

		new Setting(containerEl)
			.setName('Font size')
			.setDesc(`Set the font size of the code editor, in pixels. (${MIN_FONT_SIZE}-${MAX_FONT_SIZE}, default: ${DEFAULT_SETTINGS.editorFontSize})`)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(MIN_FONT_SIZE);
				text.inputEl.max = String(MAX_FONT_SIZE);
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.editorFontSize))
					.setValue(String(settings.editorFontSize))
					.onChange(async (value) => {
						const size = parseIntInRange(value, MIN_FONT_SIZE, MAX_FONT_SIZE);
						if (size === null) {
							return;
						}
						settings.editorFontSize = size;
						await this.plugin.saveSettings();
						this.plugin.applyToEditors((editor) => editor.setEditorFontSize(size));
					});
			});

		new Setting(containerEl)
			.setName('Auto-save delay')
			.setDesc(`Seconds to wait after editing stops before auto-saving to disk. (${MIN_AUTOSAVE_DELAY}-${MAX_AUTOSAVE_DELAY}, default: ${DEFAULT_SETTINGS.autoSaveDelaySeconds})`)
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS.autoSaveDelaySeconds))
				.setValue(String(settings.autoSaveDelaySeconds))
				.onChange(async (value) => {
					const seconds = parseIntInRange(value, MIN_AUTOSAVE_DELAY, MAX_AUTOSAVE_DELAY);
					if (seconds === null) {
						return;
					}
					settings.autoSaveDelaySeconds = seconds;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Collapse code by default')
			.setDesc('Choose whether to have the embedded manim editor to be expanded or collapsed when opening a .md file.')
			.addToggle((toggle) => toggle
				.setValue(settings.defaultCollapsed)
				.onChange(async (value) => {
					settings.defaultCollapsed = value;
					await this.plugin.saveSettings();
				}));
	}
}
