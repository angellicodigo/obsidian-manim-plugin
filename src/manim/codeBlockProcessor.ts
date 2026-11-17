import { MarkdownView, Notice, setIcon } from 'obsidian';
import type ManimPlugin from '../main';
import { runManimSource, type ConstructableScene, type SceneStateChange } from './runtime';

type RunState = 'idle' | 'running' | 'paused';

const pendingPlaybackTimeByBlock = new Map<string, number>();

interface EditableBlock {
	plugin: ManimPlugin;
	ctx: { sourcePath: string; getSectionInfo: (el: HTMLElement) => { lineStart: number } | null };
	el: HTMLElement;
}

const editableBlockByContainer = new WeakMap<HTMLElement, EditableBlock>();

async function openBlockInSourceMode(target: EditableBlock): Promise<void> {
	const section = target.ctx.getSectionInfo(target.el);
	const view = target.plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!section || !view || view.file?.path !== target.ctx.sourcePath) return;

	if (view.getMode() !== 'source') {
		await (view as any).setState({ mode: 'source' }, { history: false });
	}

	const position = { line: section.lineStart + 1, ch: 0 };
	view.editor.setCursor(position);
	view.editor.scrollIntoView({ from: position, to: position }, true);
	view.editor.focus();
}

function getBlockKey(ctx: { sourcePath: string; getSectionInfo: (el: HTMLElement) => { lineStart: number } | null }, el: HTMLElement): string {
	return `${ctx.sourcePath}:${ctx.getSectionInfo(el)?.lineStart ?? el.id}`;
}

function formatRuntimeError(error: unknown): string {
	if (error instanceof Error) {
		const stack = error.stack?.trim();
		return stack ? `${error.name}: ${error.message}\n\n${stack}` : `${error.name}: ${error.message}`;
	}
	return String(error);
}

function toRunState(state: SceneStateChange): RunState {
	if (state.isRunning) return 'running';
	return state.isPaused ? 'paused' : 'idle';
}

export function registerManimCodeBlockProcessor(plugin: ManimPlugin): void {
	plugin.registerDomEvent(document, 'click', (event: MouseEvent) => {
		const clicked = (event.target as HTMLElement | null)?.closest<HTMLElement>(
			'.edit-block-button, button[aria-label*="Edit this block"], button[title*="Edit this block"]',
		);
		if (!clicked) return;

		let container: HTMLElement | null = clicked;
		let target: EditableBlock | undefined;
		while (container && !target) {
			target = editableBlockByContainer.get(container);
			container = container.parentElement;
		}
		if (!target) return;

		event.preventDefault();
		event.stopImmediatePropagation();
		void openBlockInSourceMode(target);
	}, true);

	plugin.registerMarkdownCodeBlockProcessor('manim', (source, el, ctx) => {
		const editableBlock: EditableBlock = { plugin, ctx, el };
		const wrapper = el.createDiv({ cls: 'manim-block' });
		editableBlockByContainer.set(wrapper, editableBlock);
		let editableContainer: HTMLElement | null = wrapper.parentElement;
		for (let depth = 0; editableContainer && depth < 6; depth++) {
			editableBlockByContainer.set(editableContainer, editableBlock);
			editableContainer = editableContainer.parentElement;
		}
		const blockKey = getBlockKey(ctx, el);
		const header = wrapper.createDiv({ cls: 'manim-block-header' });
		const controls = header.createDiv({ cls: 'manim-block-controls' });
		const statusEl = controls.createSpan({ cls: 'manim-save-state' });
		statusEl.style.display = 'none';

		const runButton = controls.createEl('button', { cls: 'manim-control-button manim-run-button' });
		runButton.type = 'button';
		const runIcon = runButton.createSpan({ cls: 'manim-button-icon' });
		const runLabel = runButton.createSpan({ cls: 'manim-run-label' });
		const restartButton = controls.createEl('button', { cls: 'manim-control-button manim-restart-button' });
		restartButton.type = 'button';
		setIcon(restartButton, 'rotate-ccw');
		restartButton.setAttribute('aria-label', 'Restart animation');

		const canvas = wrapper.createDiv({ cls: 'manim-canvas' });
		const errorPanel = wrapper.createEl('pre', { cls: 'manim-error-panel' });
		errorPanel.style.display = 'none';

		let runState: RunState = 'idle';
		const setStatus = (text: string) => {
			statusEl.textContent = text;
			statusEl.style.display = text ? 'inline-block' : 'none';
		};
		const setRunState = (state: RunState) => {
			runState = state;
			const running = state === 'running';
			setIcon(runIcon, running ? 'pause' : 'play');
			runLabel.textContent = running ? 'Pause' : 'Run';
			runButton.setAttribute('aria-label', running ? 'Pause animation' : 'Run animation');
			setStatus(running ? 'Running...' : state === 'paused' ? 'Paused' : '');
		};
		setRunState('idle');

		let executionCounter = 0;
		let currentScene: ConstructableScene | null = null;
		let unsubscribeSceneState: (() => void) | null = null;
		let unloaded = false;

		const teardownScene = () => {
			unsubscribeSceneState?.();
			unsubscribeSceneState = null;
			try { currentScene?.dispose?.(); } catch { /* cleanup is best effort */ }
			currentScene = null;
		};
		const showError = (message: string | null) => {
			errorPanel.textContent = message ?? '';
			errorPanel.style.display = message ? 'block' : 'none';
		};

		const execute = async (resumeTime: number | null) => {
			pendingPlaybackTimeByBlock.delete(blockKey);
			const executionId = ++executionCounter;
			const isStale = () => unloaded || executionId !== executionCounter;
			teardownScene();
			showError(null);
			setRunState('running');
			try {
				const mountedScene = await runManimSource(source, canvas, (scene) => {
					if (isStale()) { scene.dispose?.(); return; }
					currentScene = scene;
					unsubscribeSceneState = scene.onStateChange?.((state) => {
						if (!isStale()) setRunState(toRunState(state));
					}) ?? null;
				});
				if (isStale()) return;
				if (mountedScene) currentScene = mountedScene;
				if (resumeTime !== null && currentScene?.seek && currentScene.play) {
					currentScene.seek(Math.max(0, resumeTime - plugin.settings.playbackLeadInSeconds));
					await currentScene.play();
				}
				if (typeof currentScene?.onStateChange !== 'function') setRunState('idle');
			} catch (error) {
				if (isStale()) return;
				showError(formatRuntimeError(error));
				new Notice(`Manim render failed: ${error instanceof Error ? error.message : String(error)}`);
				setRunState('idle');
			}
		};

		const runOrPause = () => {
			if (runState === 'running') {
				currentScene?.pause?.();
				setRunState('paused');
				return;
			}
			if (runState === 'paused') {
				currentScene?.resume?.();
				setRunState('running');
				return;
			}
			void execute(pendingPlaybackTimeByBlock.get(blockKey) ?? currentScene?.getCurrentTime?.() ?? null);
		};
		runButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); runOrPause(); });
		restartButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void execute(null); });

		ctx.addChild({
			load: () => undefined,
			onunload: () => {
				const time = currentScene?.getCurrentTime?.();
				if (time !== undefined && time > 0) pendingPlaybackTimeByBlock.set(blockKey, time);
				unloaded = true;
				executionCounter++;
				teardownScene();
			},
		} as any);

		if (plugin.settings.autoRun === 'always') void execute(null);
		else if (plugin.settings.autoRun === 'visible') {
			const observer = new IntersectionObserver((entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer.disconnect();
					void execute(null);
				}
			});
			observer.observe(wrapper);
		}
	});
}
