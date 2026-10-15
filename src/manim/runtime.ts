import * as manimWeb from 'manim-web';
import { transform } from 'sucrase';

const manimNamedImportPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['\"]manim-web['\"]\s*;?/gm;

function toDestructureField(specifier: string): string {
	const clean = specifier.trim().replace(/\s+/g, ' ');
	if (!clean) {
		return '';
	}

	const aliasMatch = clean.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
	if (aliasMatch) {
		return `${aliasMatch[1]}: ${aliasMatch[2]}`;
	}

	if (/^[A-Za-z_$][\w$]*$/.test(clean)) {
		return clean;
	}

	throw new Error(`Unsupported manim-web import specifier: ${clean}`);
}

function replaceContainerLookup(source: string): string {
	return source.replace(/document\.getElementById\((['\"])container\1\)/g, '__MANIM_CONTAINER__');
}

function assertNoUnsupportedImports(source: string): void {
	const hasImport = /^\s*import\s+/m.test(source);
	if (hasImport) {
		throw new Error('Only imports from manim-web are supported inside ```manim code blocks.');
	}
}

function collectManimImportFields(source: string): string[] {
	const fields: string[] = [];
	for (const match of source.matchAll(manimNamedImportPattern)) {
		const specifierGroup = match[1] ?? '';
		const rawSpecifiers = specifierGroup.split(',');
		for (const rawSpecifier of rawSpecifiers) {
			const field = toDestructureField(rawSpecifier);
			if (field) {
				fields.push(field);
			}
		}
	}
	return fields;
}

function stripManimWebImports(source: string): string {
	return source.replace(manimNamedImportPattern, '');
}

function prepareCode(source: string): string {
	// Map `import { ... } from 'manim-web'` to runtime-bound symbols.
	const manimImportFields = collectManimImportFields(source);
	const withoutManimImport = stripManimWebImports(source);
	const withContainerAlias = replaceContainerLookup(withoutManimImport);
	assertNoUnsupportedImports(withContainerAlias);

	const lines = ['const __MANIM_CONTAINER__ = container;'];
	if (manimImportFields.length > 0) {
		lines.push(`const { ${manimImportFields.join(', ')} } = manimWeb;`);
	}
	lines.push(withContainerAlias);

	return lines.join('\n');
}

function transpileToJavaScript(source: string): string {
	try {
		return transform(source, {
			transforms: ['typescript', 'imports'],
			disableESTransforms: true,
		}).code;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`TypeScript transpilation failed: ${message}`);
	}
}

function createDocumentProxy(container: HTMLElement): Document {
	const getElementById = (id: string) => {
		if (id === 'container') {
			return container;
		}
		return document.getElementById(id);
	};

	return new Proxy(document, {
		get(target, prop, receiver) {
			if (prop === 'getElementById') {
				return getElementById;
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as Document;
}

export interface ConstructableScene {
	construct?: () => Promise<void> | void;
	play?: (...args: any[]) => Promise<void>;
	playAll?: (...args: any[]) => Promise<void>;
	wait?: (duration?: number) => Promise<void>;
	pause?: () => void;
	resume?: () => void;
	stop?: () => void;
	dispose?: () => void;
	isPlaying?: boolean;
	isPaused?: boolean;
}

export function attachScenePauseController(scene: ConstructableScene): void {
	const rawScene = scene as any;
	const originalPlay = typeof rawScene.play === 'function' ? rawScene.play.bind(rawScene) : null;
	const originalPause = typeof rawScene.pause === 'function' ? rawScene.pause.bind(rawScene) : null;
	const originalResume = typeof rawScene.resume === 'function' ? rawScene.resume.bind(rawScene) : null;
	const originalStop = typeof rawScene.stop === 'function' ? rawScene.stop.bind(rawScene) : null;
	const originalDispose = typeof rawScene.dispose === 'function' ? rawScene.dispose.bind(rawScene) : null;

	let isPaused = false;
	let isDisposed = false;
	const resumeWaiters: Array<() => void> = [];
	let cancelActiveWait: (() => void) | null = null;

	const waitForResume = (): Promise<void> => {
		if (!isPaused || isDisposed || rawScene._disposed) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			resumeWaiters.push(resolve);
		});
	};

	const triggerResume = (): void => {
		isPaused = false;
		const waiters = [...resumeWaiters];
		resumeWaiters.length = 0;
		for (const waiter of waiters) {
			try {
				waiter();
			} catch {
				// ignore
			}
		}
	};

	const sleepWithInterrupt = (ms: number): Promise<number> => {
		if (ms <= 0 || isDisposed || rawScene._disposed) {
			return Promise.resolve(0);
		}
		return new Promise<number>((resolve) => {
			const start = performance.now();
			let timerId: ReturnType<typeof setTimeout> | null = null;

			const onCancel = () => {
				if (timerId !== null) {
					clearTimeout(timerId);
					timerId = null;
				}
				cancelActiveWait = null;
				const elapsed = performance.now() - start;
				resolve(Math.max(0, ms - elapsed));
			};

			cancelActiveWait = onCancel;

			timerId = setTimeout(() => {
				timerId = null;
				cancelActiveWait = null;
				resolve(0);
			}, ms);
		});
	};

	const frameLoopWithInterrupt = (ms: number): Promise<number> => {
		if (ms <= 0 || isDisposed || rawScene._disposed) {
			return Promise.resolve(0);
		}
		return new Promise<number>((resolve) => {
			const start = performance.now();
			let lastTime = start;
			let rafId: number | null = null;

			const cleanup = () => {
				if (rafId !== null) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
				cancelActiveWait = null;
			};

			const onCancel = () => {
				cleanup();
				const elapsed = performance.now() - start;
				resolve(Math.max(0, ms - elapsed));
			};

			cancelActiveWait = onCancel;

			const tick = (now: number) => {
				const dt = (now - lastTime) / 1000;
				lastTime = now;
				if (rawScene._mobjects) {
					for (const m of rawScene._mobjects) {
						m.update?.(dt);
					}
				}
				if (typeof rawScene._render === 'function') {
					rawScene._render();
				}

				const elapsed = now - start;
				if (elapsed >= ms) {
					cleanup();
					resolve(0);
				} else {
					rafId = requestAnimationFrame(tick);
				}
			};

			rafId = requestAnimationFrame(tick);
		});
	};

	scene.pause = function(): void {
		if (isDisposed || rawScene._disposed || isPaused) {
			return;
		}
		isPaused = true;

		// 1. Interrupt any active wait countdown immediately
		if (cancelActiveWait) {
			cancelActiveWait();
			cancelActiveWait = null;
		}

		// 2. Pause timeline and audio
		if (originalPause) {
			try {
				originalPause();
			} catch {
				// ignore
			}
		}

		// 3. Stop render loops immediately to freeze canvas frame
		if (typeof rawScene._stopRenderLoop === 'function') {
			try {
				rawScene._stopRenderLoop();
			} catch {
				// ignore
			}
		}
	};

	scene.resume = function(): void {
		if (isDisposed || rawScene._disposed || !isPaused) {
			return;
		}
		isPaused = false;

		// 1. Resume timeline if playing animation
		const timeline = rawScene._timeline;
		if (timeline && typeof timeline.isFinished === 'function' && !timeline.isFinished()) {
			rawScene._isPlaying = true;
			try {
				timeline.play?.();
			} catch {
				// ignore
			}
			if (typeof rawScene._startRenderLoop === 'function') {
				try {
					rawScene._startRenderLoop();
				} catch {
					// ignore
				}
			}
			if (rawScene._audioManager) {
				try {
					rawScene._audioManager.play?.();
				} catch {
					// ignore
				}
			}
		}

		// 2. Resume any pending wait() or step
		triggerResume();
	};

	scene.stop = function(): void {
		isPaused = false;
		if (cancelActiveWait) {
			cancelActiveWait();
			cancelActiveWait = null;
		}
		triggerResume();
		if (originalStop) {
			try {
				originalStop();
			} catch {
				// ignore
			}
		}
	};

	scene.dispose = function(): void {
		if (isDisposed) {
			return;
		}
		isDisposed = true;
		isPaused = false;

		if (cancelActiveWait) {
			cancelActiveWait();
			cancelActiveWait = null;
		}
		triggerResume();

		if (originalDispose) {
			try {
				originalDispose();
			} catch {
				// ignore
			}
		}
	};

	if (Array.isArray(rawScene._waitCleanups)) {
		rawScene._waitCleanups.push(() => {
			isDisposed = true;
			if (cancelActiveWait) {
				cancelActiveWait();
				cancelActiveWait = null;
			}
			triggerResume();
		});
	}

	(scene as any).play = async function(...args: any[]): Promise<void> {
		if (isDisposed || rawScene._disposed) {
			return;
		}
		if (args.length === 0) {
			return;
		}

		if (isPaused) {
			await waitForResume();
			if (isDisposed || rawScene._disposed) {
				return;
			}
		}

		if (originalPlay) {
			await originalPlay(...args);
		}

		if (isPaused && !isDisposed && !rawScene._disposed) {
			await waitForResume();
		}
	};

	if (typeof rawScene.playAll === 'function') {
		(scene as any).playAll = async function(...args: any[]): Promise<void> {
			return (scene as any).play(...args);
		};
	}

	(scene as any).wait = async function(t = 1): Promise<void> {
		if (isDisposed || rawScene._disposed) {
			return;
		}
		if (t <= 0) {
			return;
		}

		if (isPaused) {
			await waitForResume();
			if (isDisposed || rawScene._disposed) {
				return;
			}
		}

		let remainingMs = t * 1000;

		while (remainingMs > 0 && !isDisposed && !rawScene._disposed) {
			if (isPaused) {
				await waitForResume();
				if (isDisposed || rawScene._disposed) {
					return;
				}
			}

			const needsPerFrame = typeof rawScene._needsPerFrameRendering === 'function' && rawScene._needsPerFrameRendering();

			if (!needsPerFrame) {
				if (typeof rawScene._render === 'function') {
					try {
						rawScene._render();
					} catch {
						// ignore
					}
				}
				remainingMs = await sleepWithInterrupt(remainingMs);
			} else {
				remainingMs = await frameLoopWithInterrupt(remainingMs);
			}
		}

		if (isPaused && !isDisposed && !rawScene._disposed) {
			await waitForResume();
		}
	};

	Object.defineProperty(scene, 'isPaused', {
		get: () => isPaused,
		configurable: true,
	});
}

export async function runManimSource(
	source: string,
	outputEl: HTMLElement,
	onSceneReady?: (scene: ConstructableScene) => void,
): Promise<ConstructableScene | null> {
	outputEl.empty();

	const viewport = outputEl.createDiv({ cls: 'manim-canvas-viewport' });
	const mount = viewport.createDiv({ cls: 'manim-canvas-mount' });

	const code = transpileToJavaScript(prepareCode(source));
	// Redirect `document.getElementById('container')` to this block's local mount.
	const documentProxy = createDocumentProxy(mount);
	const exports: { default?: unknown } = {};
	const executor = new Function(
		'container',
		'manimWeb',
		'document',
		'window',
		'self',
		'exports',
		`return (async () => {\n${code}\n})();`,
	);

	await executor(mount, manimWeb, documentProxy, window, window, exports);
	const SceneClass = exports.default as (new (container: HTMLElement) => ConstructableScene) | undefined;
	if (typeof SceneClass === 'function') {
		const scene = new SceneClass(mount);
		attachScenePauseController(scene);
		onSceneReady?.(scene);
		if (typeof scene.construct === 'function') {
			await scene.construct();
		}
		return scene;
	}
	return null;
}