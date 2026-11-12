import { Notice, setIcon } from 'obsidian';
import type ManimPlugin from '../main';
import { ManimCodeEditorChild } from './editorChild';
import { syncStylesFromNativeCodeMirror } from './editorStyle';
import { runManimSource, type ConstructableScene, type SceneStateChange } from './runtime';
import { getPersistedBlockState, saveBlockState } from './stateStore';
import type { Diagnostic } from '@codemirror/lint';

type RunState = 'idle' | 'running' | 'paused';

function formatRuntimeError(error: unknown): string {
	if (error instanceof Error) {
		const stack = error.stack?.trim();
		return stack ? `${error.name}: ${error.message}\n\n${stack}` : `${error.name}: ${error.message}`;
	}
	return String(error);
}

/** Build a CodeMirror diagnostic from a runtime error. Uses character offset 0 on line 0;
 * the line number (if extracted) is included in the message. */
function errorToDiagnostic(error: unknown): Diagnostic | null {
	const message = error instanceof Error ? error.message : String(error);
	return {
		from: 0,
		to: Math.max(1, message.length),
		message,
		severity: 'error',
	};
}

function toRunState(state: SceneStateChange): RunState {
	if (state.isRunning) {
		return 'running';
	}
	return state.isPaused ? 'paused' : 'idle';
}

function setCollapsedState(codeEditorEl: HTMLElement, collapseCaretEl: HTMLElement, collapsed: boolean): void {
	codeEditorEl.style.display = collapsed ? 'none' : 'block';
	collapseCaretEl.textContent = collapsed ? '▸' : '▾';
	collapseCaretEl.setAttribute('aria-label', collapsed ? 'Expand code' : 'Collapse code');
}

export function registerManimCodeBlockProcessor(plugin: ManimPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('manim', (source, el, ctx) => {
		const savedState = getPersistedBlockState(ctx, el);

		const wrapper = el.createDiv({ cls: 'manim-block' });
		syncStylesFromNativeCodeMirror(wrapper);

		let isCollapsed = savedState?.isCollapsed ?? plugin.settings.defaultCollapsed;

		// --- Header: collapse caret + status label + run/restart buttons ---
		const header = wrapper.createDiv({ cls: 'manim-block-header' });
		const collapseCaret = header.createSpan({ cls: 'manim-collapse-caret' });
		collapseCaret.setAttribute('role', 'button');
		collapseCaret.setAttribute('tabindex', '0');

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

		// --- Body: code editor, canvas, error panel ---
		// Reuse Obsidian's CM6 container classes so native editor styles apply.
		const codeEditor = wrapper.createDiv({ cls: 'manim-code-editor markdown-source-view mod-cm6' });
		const editorChild = new ManimCodeEditorChild(
			plugin,
			ctx,
			el,
			codeEditor,
			source,
			statusEl,
			plugin.settings.editorTheme,
			savedState,
		);
		ctx.addChild(editorChild);

		const canvas = wrapper.createDiv({ cls: 'manim-canvas' });
		const errorPanel = wrapper.createEl('pre', { cls: 'manim-error-panel' });
		errorPanel.style.display = 'none';

		const showError = (message: string | null) => {
			errorPanel.textContent = message ?? '';
			errorPanel.style.display = message ? 'block' : 'none';
		};

		const setStatus = (text: string) => {
			statusEl.textContent = text;
			statusEl.style.display = text ? 'inline-block' : 'none';
		};

		// --- Run state (button + status label always change together) ---
		let runState: RunState = 'idle';
		const setRunState = (state: RunState) => {
			runState = state;
			const isRunning = state === 'running';
			setIcon(runIcon, isRunning ? 'pause' : 'play');
			runLabel.textContent = isRunning ? 'Pause' : 'Run';
			runButton.setAttribute('aria-label', isRunning ? 'Pause animation' : 'Run animation');
			setStatus(isRunning ? 'Running...' : state === 'paused' ? 'Paused' : '');
		};
		setRunState('idle');

		// --- Collapse ---
		setCollapsedState(codeEditor, collapseCaret, isCollapsed);
		if (!isCollapsed) {
			editorChild.requestMeasure();
		}

		const toggleCollapse = () => {
			isCollapsed = !isCollapsed;
			setCollapsedState(codeEditor, collapseCaret, isCollapsed);
			saveBlockState(ctx, el, { isCollapsed });
			if (!isCollapsed) {
				editorChild.requestMeasure();
			}
		};

		// Clicking anywhere in the header (including the caret) toggles, except on the buttons.
		editorChild.registerDomEvent(header, 'click', (evt: MouseEvent) => {
			if ((evt.target as HTMLElement).closest('.manim-control-button')) {
				return;
			}
			toggleCollapse();
		});

		editorChild.registerDomEvent(collapseCaret, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Enter' && evt.key !== ' ') {
				return;
			}
			evt.preventDefault();
			toggleCollapse();
		});

		// --- Scene lifecycle ---
		let executionCounter = 0;
		let currentScene: ConstructableScene | null = null;
		let unsubscribeSceneState: (() => void) | null = null;
		let lastRanCode = '';
		let isBlockUnloaded = false;

		const unsubscribeScene = () => {
			unsubscribeSceneState?.();
			unsubscribeSceneState = null;
		};

		const teardownScene = () => {
			unsubscribeScene();
			try {
				currentScene?.dispose?.();
			} catch {
				// ignore cleanup errors
			}
			currentScene = null;
		};

		editorChild.register(() => {
			isBlockUnloaded = true;
			teardownScene();
		});

		const execute = async () => {
			const executionId = ++executionCounter;
			const isStale = () => executionId !== executionCounter || isBlockUnloaded;

			teardownScene();
			setRunState('running');
			showError(null);

			const codeToRun = editorChild.getCode();
			lastRanCode = codeToRun;

			// Record cursor/scroll/focus without forcing collapsed state (that
			// only changes when the user toggles the caret).
			editorChild.recordCurrentState();

			try {
				await editorChild.flushPendingSave();
				if (isStale()) {
					return;
				}

				const mountedScene = await runManimSource(codeToRun, canvas, (scene) => {
					if (isStale()) {
						scene.dispose?.();
						return;
					}
					currentScene = scene;
					unsubscribeSceneState = scene.onStateChange?.((state) => {
						if (!isStale()) {
							setRunState(toRunState(state));
						}
					}) ?? null;
				});

				if (isStale()) {
					return;
				}
				if (mountedScene) {
					currentScene = mountedScene;
				}

				// Player scenes report their own state changes; class/function scenes are done once they resolve.
				if (typeof currentScene?.onStateChange !== 'function') {
					setRunState('idle');
				}
				editorChild.setLintErrors([]);
			} catch (error) {
				if (isStale()) {
					return;
				}
				unsubscribeScene();
				showError(formatRuntimeError(error));
				const diagnostic = errorToDiagnostic(error);
				if (diagnostic) editorChild.setLintErrors([diagnostic]);
				new Notice(`Manim render failed: ${error instanceof Error ? error.message : String(error)}`);
				setRunState('idle');
			}
		};

		const handleRunPauseClick = () => {
			if (runState === 'running') {
				try {
					currentScene?.pause?.();
				} catch {
					// ignore
				}
				setRunState('paused');
				return;
			}

			if (runState === 'paused' && currentScene && editorChild.getCode() === lastRanCode) {
				try {
					currentScene.resume?.();
					setRunState('running');
					return;
				} catch {
					// fall back to re-running if resume fails
				}
			}

			// Finished, never ran, edited while paused, or resume failed: restart from scratch.
			void execute();
		};

		editorChild.registerDomEvent(runButton, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			handleRunPauseClick();
		});

		editorChild.registerDomEvent(restartButton, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			void execute();
		});

		// Auto-run on open, honoring the user's auto-run setting.
		if (plugin.settings.autoRun === 'always') {
			void execute();
		} else if (plugin.settings.autoRun === 'visible') {
			// Only run when the block scrolled into view; stop observing after first run.
			const observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						observer.disconnect();
						void execute();
						return;
					}
				}
			}, { root: null, rootMargin: '0px', threshold: 0 });
			observer.observe(wrapper);
		}
		// 'never': do nothing; user clicks Run explicitly.
	});
}
