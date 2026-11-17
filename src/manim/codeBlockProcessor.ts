import type { EditorView } from '@codemirror/view';
import { MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Notice, setIcon } from 'obsidian';
import type ManimPlugin from '../main';
import { OPENING_FENCE } from './fences';
import { runManimSource, type ConstructableScene, type SceneStateChange } from './runtime';

type RunState = 'idle' | 'running' | 'paused';

const EDIT_BUTTON_SELECTOR = '.edit-block-button, button[aria-label*="Edit this block"], button[title*="Edit this block"]';

/** Playback time of a block that was unloaded (e.g. while its source was being edited), so Run can resume there. */
const pendingPlaybackTimeByBlock = new Map<string, number>();

interface EditableBlock {
	ctx: MarkdownPostProcessorContext;
	el: HTMLElement;
}

/** Keyed by the rendered `.manim-block` element, so an "Edit this block" click maps to exactly one block. */
const editableBlockByWrapper = new WeakMap<HTMLElement, EditableBlock>();

function getBlockKey(ctx: MarkdownPostProcessorContext, el: HTMLElement): string {
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

/**
 * Finds the 0-based line of the block's opening fence in the *current* document.
 * The editor position of the rendered widget is preferred (it always reflects the live document);
 * the processor's section info is the fallback. Either candidate must really be a manim fence.
 */
function findOpeningFenceLine(view: MarkdownView, target: EditableBlock, embedEl: HTMLElement | null): number | null {
	const editor = view.editor;
	const candidates: Array<() => number | null> = [
		() => {
			const cm = (editor as unknown as { cm?: EditorView }).cm;
			if (!cm || !embedEl) return null;
			return cm.state.doc.lineAt(cm.posAtDOM(embedEl)).number - 1;
		},
		() => target.ctx.getSectionInfo(target.el)?.lineStart ?? null,
	];

	for (const candidate of candidates) {
		try {
			const line = candidate();
			if (line !== null && line >= 0 && line < editor.lineCount() && OPENING_FENCE.test(editor.getLine(line))) {
				return line;
			}
		} catch {
			// try the next candidate
		}
	}
	return null;
}

/** Puts the cursor inside the block's fence so Live Preview swaps the widget for the raw source. */
function revealBlockSource(plugin: ManimPlugin, target: EditableBlock, embedEl: HTMLElement | null): boolean {
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== target.ctx.sourcePath) return false;

	const fenceLine = findOpeningFenceLine(view, target, embedEl);
	if (fenceLine === null) return false;

	const editor = view.editor;
	const position = { line: Math.min(fenceLine + 1, editor.lineCount() - 1), ch: 0 };
	editor.setCursor(position);
	editor.scrollIntoView({ from: position, to: position }, true);
	editor.focus();
	return true;
}

export function registerManimCodeBlockProcessor(plugin: ManimPlugin): void {
	// Capture phase, so we run before anything inside the block (e.g. the animation player) can react to the click.
	// We only take over when we positively identified the block and revealed its source; otherwise the click is
	// left alone and Obsidian's own handler does the job.
	plugin.registerDomEvent(document, 'click', (event: MouseEvent) => {
		const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(EDIT_BUTTON_SELECTOR);
		if (!button) return;

		const embedEl = button.closest<HTMLElement>('.cm-embed-block') ?? button.parentElement;
		const wrapper = embedEl?.querySelector<HTMLElement>('.manim-block');
		const target = wrapper ? editableBlockByWrapper.get(wrapper) : undefined;
		if (!target) return;

		if (revealBlockSource(plugin, target, embedEl)) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, true);

	plugin.registerMarkdownCodeBlockProcessor('manim', (source, el, ctx) => {
		const wrapper = el.createDiv({ cls: 'manim-block' });
		editableBlockByWrapper.set(wrapper, { ctx, el });
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
		let visibilityObserver: IntersectionObserver | null = null;
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

		/** `resumeTime`: where the previous run was, or null to start from the beginning. */
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
			// Idle: a fresh run. It only resumes mid-animation when this block was just re-rendered
			// (pending time saved on unload); replaying a finished animation starts from the beginning.
			void execute(pendingPlaybackTimeByBlock.get(blockKey) ?? null);
		};
		runButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); runOrPause(); });
		restartButton.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void execute(null); });

		// Obsidian calls `unload()` on every child component, so this must be a real component (a plain
		// object without `unload` throws inside Obsidian's teardown and leaves the old widget behind).
		const lifecycle = new MarkdownRenderChild(el);
		lifecycle.register(() => {
			const time = currentScene?.getCurrentTime?.();
			if (time !== undefined && time > 0) pendingPlaybackTimeByBlock.set(blockKey, time);
			unloaded = true;
			executionCounter++;
			visibilityObserver?.disconnect();
			visibilityObserver = null;
			teardownScene();
		});
		ctx.addChild(lifecycle);

		const autoRunTime = () => pendingPlaybackTimeByBlock.get(blockKey) ?? null;
		if (plugin.settings.autoRun === 'always') {
			void execute(autoRunTime());
		} else if (plugin.settings.autoRun === 'visible') {
			visibilityObserver = new IntersectionObserver((entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					visibilityObserver?.disconnect();
					visibilityObserver = null;
					void execute(autoRunTime());
				}
			});
			visibilityObserver.observe(wrapper);
		}
	});
}
