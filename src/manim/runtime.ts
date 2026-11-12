import * as manimWeb from 'manim-web';
import { transform } from 'sucrase';

const manimNamedImportPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['\"](?:manim-web|\.\.\/src\/index(?:\.ts)?)['\"]\s*;?/g;
const manimStarImportPattern = /import\s*\*\s*as\s+(\w+)\s*from\s*['\"](?:manim-web|\.\.\/src\/index(?:\.ts)?)['\"]\s*;?/g;

/** Runs `action`, swallowing any error (used for best-effort cleanup and optional scene hooks). */
function safely(action: () => unknown): void {
	try {
		action();
	} catch {
		// ignore
	}
}

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
	return source
		.replace(/document\.getElementById\((['"])[^'"]*(?:container|presentation|canvas|mount)[^'"]*\1\)(\s*!)?/gi, '__MANIM_CONTAINER__')
		.replace(/document\.querySelector\((['"])[^'"]*(?:container|presentation|canvas|mount)[^'"]*\1\)(\s*!)?/gi, '__MANIM_CONTAINER__')
		.replace(/document\.getElementById\((['"])container\1\)(\s*!)?/g, '__MANIM_CONTAINER__');
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
	return source
		.replace(manimNamedImportPattern, '')
		.replace(manimStarImportPattern, '');
}

function assertNoLegacyDestructuring(source: string): void {
	const legacyPattern = /\b(?:const|let|var)\s*\{[\s\S]*?\}\s*(?:=|from)\s*['"]?manimWeb['"]?\s*;?/;
	if (legacyPattern.test(source)) {
		throw new Error(
			"Legacy destructuring `const { ... } = manimWeb;` is no longer supported. Please use `import { ... } from 'manim-web';` instead."
		);
	}
}

function prepareCode(source: string): string {
	assertNoLegacyDestructuring(source);
	// Map `import { ... } from 'manim-web'` to runtime-bound symbols.
	const manimImportFields = collectManimImportFields(source);
	const withoutManimImport = stripManimWebImports(source);
	const withContainerAlias = replaceContainerLookup(withoutManimImport);
	assertNoUnsupportedImports(withContainerAlias);

	const lines: string[] = [];
	if (manimImportFields.length > 0) {
		lines.push(`const { ${manimImportFields.join(', ')} } = __MANIM_INTERNAL__;`);
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
	// Scene code looks up its mount point by id/selector; anything that can't be found maps to our container.
	const getElementById = (id: string) =>
		id === 'container' || id === 'presentation-container'
			? container
			: (document.getElementById(id) ?? container);

	const querySelector = (selector: string) =>
		selector === '#container' || selector === '#presentation-container'
			? container
			: (document.querySelector(selector) ?? container);

	return new Proxy(document, {
		get(target, prop) {
			if (prop === 'getElementById') {
				return getElementById;
			}
			if (prop === 'querySelector') {
				return querySelector;
			}
			// Native DOM methods/getters throw "Illegal invocation" when `this` is the proxy, so bind to the real document.
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	}) as Document;
}

export interface SceneStateChange {
	isRunning: boolean;
	isPaused: boolean;
	isFinished?: boolean;
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
	onStateChange?: (listener: (state: SceneStateChange) => void) => () => void;
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
			safely(() => waiter());
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
			safely(() => originalPause());
		}

		// 3. Stop render loops immediately to freeze canvas frame
		if (typeof rawScene._stopRenderLoop === 'function') {
			safely(() => rawScene._stopRenderLoop());
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
			safely(() => timeline.play?.());
			if (typeof rawScene._startRenderLoop === 'function') {
				safely(() => rawScene._startRenderLoop());
			}
			if (rawScene._audioManager) {
				safely(() => rawScene._audioManager.play?.());
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
			safely(() => originalStop());
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
			safely(() => originalDispose());
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
					safely(() => rawScene._render());
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

	if (typeof (scene as any).nextSlide !== 'function') {
		(scene as any).nextSlide = async function(opts: any = {}): Promise<void> {
			if (opts && opts.autoNext) return;
			return new Promise<void>((resolve) => {
				const onKeyDown = (e: KeyboardEvent) => {
					if (isEditableElement(e.target as HTMLElement | null)) {
						return;
					}
					if (['Space', 'ArrowRight', 'Enter', 'PageDown'].includes(e.code)) {
						e.preventDefault();
						cleanup();
						resolve();
					}
				};
				const onClick = (e: MouseEvent) => {
					if ((e.target as HTMLElement)?.closest('.manim-block-header')) return;
					cleanup();
					resolve();
				};
				const cleanup = () => {
					window.removeEventListener('keydown', onKeyDown, true);
					window.removeEventListener('click', onClick, true);
				};
				window.addEventListener('keydown', onKeyDown, true);
				window.addEventListener('click', onClick, true);
			});
		};
		(scene as any).next_slide = (scene as any).nextSlide;
	}
}

function isEditableElement(element: HTMLElement | null): boolean {
	if (!element) {
		return false;
	}
	const tagName = element.tagName;
	return tagName === 'INPUT' || tagName === 'TEXTAREA' || Boolean(element.closest('.cm-editor'));
}

function isAtPresentationEnd(currentTime: number, endTime: number, duration: number): boolean {
	return currentTime >= endTime - 0.05 || currentTime >= duration - 0.05;
}

function parkPlayerAtEnd(player: any, targetTime: number, duration: number): void {
	player._activeLoopSlideIndex = null;
	player._slidesTargetSlideIndex = -1;
	player._isPlaying = false;
	player._masterTimeline?.pause?.();
	player._masterTimeline?.seek?.(targetTime);
	player._stopLoop?.();
	player._ui?.setPlaying?.(false);
	player._ui?.updateTime?.(targetTime, duration);
	player._scene?.render?.();
}

function patchPlayerSlidesNavigation(player: any): void {
	const originalSlidesModeNext = typeof player._slidesModeNext === 'function'
		? player._slidesModeNext.bind(player)
		: null;
	const originalNextSlide = typeof player.nextSlide === 'function'
		? player.nextSlide.bind(player)
		: null;

	if (originalSlidesModeNext) {
		player._slidesModeNext = function(): void {
			const slides = player._masterTimeline?.getSlides?.() ?? [];
			if (!slides.length) {
				originalSlidesModeNext();
				return;
			}

			const currentTime = player._masterTimeline?.getCurrentTime?.() ?? 0;
			const duration = player._masterTimeline?.getDuration?.() ?? 0;
			const lastSlide = slides[slides.length - 1];

			if (isAtPresentationEnd(currentTime, lastSlide.endTime, duration)) {
				parkPlayerAtEnd(player, lastSlide.endTime, duration);
				return;
			}

			const isLoopingOnLastSlide = player._activeLoopSlideIndex !== null && player._activeLoopSlideIndex >= slides.length - 1;
			if (isLoopingOnLastSlide) {
				parkPlayerAtEnd(player, lastSlide.endTime, duration);
				return;
			}

			originalSlidesModeNext();
		};
	}

	if (originalNextSlide) {
		player.nextSlide = function(): void {
			if (player._slidesMode && typeof player._slidesModeNext === 'function') {
				player._slidesModeNext();
			} else {
				originalNextSlide();
			}
		};
	}
}

function patchPlayerSequence(player: any): void {
	const originalSequence = typeof player.sequence === 'function' ? player.sequence.bind(player) : null;
	if (!originalSequence) return;

	player.sequence = async function(builder: (scene: any) => Promise<void>): Promise<void> {
		return originalSequence(async (recScene: any) => {
			const sceneProxy = new Proxy(recScene, {
				get(target, prop, receiver) {
					if (prop in target) {
						const val = Reflect.get(target, prop, receiver);
						return typeof val === 'function' ? val.bind(target) : val;
					}
					if (player._scene && prop in player._scene) {
						const val = Reflect.get(player._scene, prop, player._scene);
						return typeof val === 'function' ? val.bind(player._scene) : val;
					}
					return Reflect.get(target, prop, receiver);
				},
			});
			return builder(sceneProxy);
		});
	};
}

function extractPlayerOptions(config: unknown): Record<string, any> {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return {};
	}

	const playerOptions = (config as Record<string, any>).PlayerOptions;
	if (playerOptions && typeof playerOptions === 'object' && !Array.isArray(playerOptions)) {
		return { ...(playerOptions as Record<string, any>) };
	}

	return {};
}

interface ExtractedPlayerArgs {
	container: HTMLElement;
	options: unknown;
	extraArgs: any[];
}

function resolvePlayerArgs(args: any[], fallbackMount: HTMLElement): ExtractedPlayerArgs {
	const firstArg = args[0];
	if (firstArg instanceof HTMLElement) {
		return {
			container: firstArg,
			options: args[1] ?? {},
			extraArgs: args.slice(2),
		};
	}
	if (firstArg && typeof firstArg === 'object') {
		return {
			container: fallbackMount,
			options: firstArg,
			extraArgs: args.slice(1),
		};
	}
	return {
		container: fallbackMount,
		options: args[1] ?? {},
		extraArgs: args.slice(2),
	};
}

function createPlayerProxy(
	originalPlayer: typeof manimWeb.Player,
	mount: HTMLElement,
	onCapture: (instance: any) => void,
): typeof manimWeb.Player {
	return new Proxy(originalPlayer, {
		construct(target, args, newTarget) {
			const { container, options, extraArgs } = resolvePlayerArgs(args, mount);
			if (container.setAttribute && !container.hasAttribute('tabindex')) {
				container.setAttribute('tabindex', '0');
			}
			const normalizedOptions = extractPlayerOptions(options);
			const effectiveArgs = [container, normalizedOptions, ...extraArgs];
			const instance = Reflect.construct(target, effectiveArgs, newTarget);
			patchPlayerSlidesNavigation(instance);
			patchPlayerSequence(instance);
			onCapture(instance);
			return instance;
		},
	});
}

function attachPlayerInteractions(
	player: any,
	viewport: HTMLElement,
	mount: HTMLElement,
): () => void {
	let isHovered = false;
	const onMouseEnter = () => { isHovered = true; };
	const onMouseLeave = () => { isHovered = false; };
	viewport.addEventListener('mouseenter', onMouseEnter);
	viewport.addEventListener('mouseleave', onMouseLeave);

	const onKeyDown = (event: KeyboardEvent) => {
		if (isEditableElement(event.target as HTMLElement | null)) {
			return;
		}
		const isActive = isHovered || mount.contains(document.activeElement);
		if (!isActive) {
			return;
		}

		if (event.key === 'ArrowRight' || event.key === 'PageDown') {
			event.preventDefault();
			event.stopPropagation();
			player.nextSlide?.();
		} else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
			event.preventDefault();
			event.stopPropagation();
			player.prevSlide?.();
		} else if (event.key === ' ' || event.key.toLowerCase() === 'k') {
			event.preventDefault();
			event.stopPropagation();
			player.togglePlayPause?.();
		} else if (event.key === 'Home') {
			event.preventDefault();
			event.stopPropagation();
			player.seek?.(0);
		}
	};

	window.addEventListener('keydown', onKeyDown, true);

	const onClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('[data-player-bar]')) {
			return;
		}
		if (player._slidesMode && !player._interactiveSlides && typeof player.nextSlide === 'function') {
			player.nextSlide();
		}
	};

	mount.addEventListener('click', onClick);

	return () => {
		viewport.removeEventListener('mouseenter', onMouseEnter);
		viewport.removeEventListener('mouseleave', onMouseLeave);
		window.removeEventListener('keydown', onKeyDown, true);
		mount.removeEventListener('click', onClick);
	};
}

function createPlayerSceneAdapter(
	player: any,
	cleanupListeners: () => void,
): ConstructableScene {
	const stateListeners = new Set<(state: SceneStateChange) => void>();

	const notifyState = () => {
		const isPlaying = Boolean(player.isPlaying);
		const isFinished = Boolean(player._masterTimeline?.isFinished?.());
		const currentTime = player._masterTimeline?.getCurrentTime?.() ?? 0;
		const isPaused = !isPlaying && !isFinished && currentTime > 0;
		const payload: SceneStateChange = {
			isRunning: isPlaying,
			isPaused,
			isFinished,
		};
		for (const listener of stateListeners) {
			safely(() => listener(payload));
		}
	};

	const origPlay = typeof player.play === 'function' ? player.play.bind(player) : null;
	if (origPlay) {
		player.play = function(...args: any[]) {
			origPlay(...args);
			notifyState();
		};
	}

	const origPause = typeof player.pause === 'function' ? player.pause.bind(player) : null;
	if (origPause) {
		player.pause = function(...args: any[]) {
			origPause(...args);
			notifyState();
		};
	}

	if (player._ui && typeof player._ui.setPlaying === 'function') {
		const origSetPlaying = player._ui.setPlaying.bind(player._ui);
		player._ui.setPlaying = function(isPlaying: boolean, isFinished = false) {
			origSetPlaying(isPlaying, isFinished);
			notifyState();
		};
	}

	return {
		get isPlaying() {
			return Boolean(player.isPlaying);
		},
		get isPaused() {
			const isPlaying = Boolean(player.isPlaying);
			const isFinished = Boolean(player._masterTimeline?.isFinished?.());
			return !isPlaying && !isFinished;
		},
		play: async () => {
			player.play?.();
			notifyState();
		},
		pause: () => {
			player.pause?.();
			notifyState();
		},
		resume: () => {
			player.play?.();
			notifyState();
		},
		stop: () => {
			player.pause?.();
			player.seek?.(0);
			notifyState();
		},
		dispose: () => {
			cleanupListeners();
			stateListeners.clear();
			safely(() => player.dispose?.());
		},
		onStateChange: (listener: (state: SceneStateChange) => void) => {
			stateListeners.add(listener);
			notifyState();
			return () => {
				stateListeners.delete(listener);
			};
		},
	};
}

function resolveActivePlayer(capturedPlayer: any, exports: { default?: unknown }): any {
	if (capturedPlayer) {
		return capturedPlayer;
	}
	if (exports.default && typeof (exports.default as any).sequence === 'function') {
		return exports.default;
	}
	return null;
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
	const documentProxy = createDocumentProxy(mount);

	let capturedPlayer: any = null;
	const playerProxy = createPlayerProxy(manimWeb.Player, mount, (instance) => {
		capturedPlayer = instance;
	});

	const manimWebProxy = new Proxy(manimWeb, {
		get(target, prop, receiver) {
			if (prop === 'Player') {
				return playerProxy;
			}
			return Reflect.get(target, prop, receiver);
		},
	});

	const exports: { default?: unknown } = {};
	const executor = new Function(
		'container',
		'__MANIM_CONTAINER__',
		'__MANIM_INTERNAL__',
		'document',
		'window',
		'self',
		'exports',
		`return (async () => {\n${code}\n})();`,
	);

	try {
		await executor(mount, mount, manimWebProxy, documentProxy, window, window, exports);
	} catch (error) {
		// A player created before the script threw is never handed to the caller; dispose it so its
		// listeners and render loop don't leak.
		safely(() => capturedPlayer?.dispose?.());
		throw error;
	}

	const activePlayer = resolveActivePlayer(capturedPlayer, exports);
	if (activePlayer) {
		const cleanupListeners = attachPlayerInteractions(activePlayer, viewport, mount);
		const playerAdapter = createPlayerSceneAdapter(activePlayer, cleanupListeners);
		onSceneReady?.(playerAdapter);

		return playerAdapter;
	}

	const candidate = (typeof exports.default === 'function')
		? exports.default
		: Object.values(exports).find((val): val is Function => typeof val === 'function');

	if (typeof candidate === 'function') {
		const isSceneClass = Boolean(
			(candidate.prototype && typeof candidate.prototype.construct === 'function') ||
			/^class\s/.test(Function.prototype.toString.call(candidate)),
		);

		if (isSceneClass) {
			const SceneClass = candidate as new (container: HTMLElement) => ConstructableScene;
			const scene = new SceneClass(mount);
			attachScenePauseController(scene);
			onSceneReady?.(scene);
			if (typeof scene.construct === 'function') {
				await scene.construct();
			}
			return scene;
		} else {
			const scene = new (manimWeb.Scene as any)(mount) as ConstructableScene;
			attachScenePauseController(scene);
			onSceneReady?.(scene);
			await (candidate as (scene: ConstructableScene) => Promise<void> | void)(scene);
			return scene;
		}
	}
	return null;
}