import { safely } from './runtimeUtils';
import type { ConstructableScene, SceneStateChange } from './runtime';

/** Attach pause/resume/stop/dispose lifecycle hooks to a scene instance. */
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
		if (!isPaused || isDisposed || rawScene._disposed) return Promise.resolve();
		return new Promise<void>((resolve) => {
			resumeWaiters.push(resolve);
		});
	};

	const triggerResume = (): void => {
		isPaused = false;
		const waiters = [...resumeWaiters];
		resumeWaiters.length = 0;
		for (const waiter of waiters) safely(() => waiter());
	};

	const sleepWithInterrupt = (ms: number): Promise<number> => {
		if (ms <= 0 || isDisposed || rawScene._disposed) return Promise.resolve(0);
		return new Promise<number>((resolve) => {
			const start = performance.now();
			let timerId: ReturnType<typeof setTimeout> | null = null;

			const onCancel = () => {
				if (timerId !== null) { clearTimeout(timerId); timerId = null; }
				cancelActiveWait = null;
				resolve(Math.max(0, performance.now() - start));
			};

			cancelActiveWait = onCancel;
			timerId = setTimeout(() => { timerId = null; cancelActiveWait = null; resolve(0); }, ms);
		});
	};

	const frameLoopWithInterrupt = (ms: number): Promise<number> => {
		if (ms <= 0 || isDisposed || rawScene._disposed) return Promise.resolve(0);
		return new Promise<number>((resolve) => {
			const start = performance.now();
			let lastTime = start;
			let rafId: number | null = null;

			const cleanup = () => {
				if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
				cancelActiveWait = null;
			};

			const onCancel = () => {
				cleanup();
				resolve(Math.max(0, performance.now() - start));
			};

			cancelActiveWait = onCancel;

			const tick = (now: number) => {
				const dt = (now - lastTime) / 1000;
				lastTime = now;
				if (rawScene._mobjects) {
					for (const m of rawScene._mobjects) m.update?.(dt);
				}
				if (typeof rawScene._render === 'function') rawScene._render();
				const elapsed = now - start;
				if (elapsed >= ms) { cleanup(); resolve(0); }
				else rafId = requestAnimationFrame(tick);
			};

			rafId = requestAnimationFrame(tick);
		});
	};

	scene.pause = function(): void {
		if (isDisposed || rawScene._disposed || isPaused) return;
		isPaused = true;
		if (cancelActiveWait) { cancelActiveWait(); cancelActiveWait = null; }
		safely(() => originalPause?.());
		if (typeof rawScene._stopRenderLoop === 'function') safely(() => rawScene._stopRenderLoop());
	};

	scene.resume = function(): void {
		if (isDisposed || rawScene._disposed || !isPaused) return;
		isPaused = false;
		const timeline = rawScene._timeline;
		if (timeline && typeof timeline.isFinished === 'function' && !timeline.isFinished()) {
			rawScene._isPlaying = true;
			safely(() => timeline.play?.());
			if (typeof rawScene._startRenderLoop === 'function') safely(() => rawScene._startRenderLoop());
			if (rawScene._audioManager) safely(() => rawScene._audioManager.play?.());
		}
		triggerResume();
	};

	scene.stop = function(): void {
		isPaused = false;
		if (cancelActiveWait) { cancelActiveWait(); cancelActiveWait = null; }
		triggerResume();
		safely(() => originalStop?.());
	};

	scene.dispose = function(): void {
		if (isDisposed) return;
		isDisposed = true;
		isPaused = false;
		if (cancelActiveWait) { cancelActiveWait(); cancelActiveWait = null; }
		triggerResume();
		safely(() => originalDispose?.());
	};

	if (Array.isArray(rawScene._waitCleanups)) {
		rawScene._waitCleanups.push(() => {
			isDisposed = true;
			if (cancelActiveWait) { cancelActiveWait(); cancelActiveWait = null; }
			triggerResume();
		});
	}

	(scene as any).play = async function(...args: any[]): Promise<void> {
		if (isDisposed || rawScene._disposed) return;
		if (args.length === 0) return;
		if (isPaused) { await waitForResume(); if (isDisposed || rawScene._disposed) return; }
		if (originalPlay) await originalPlay(...args);
		if (isPaused && !isDisposed && !rawScene._disposed) await waitForResume();
	};

	if (typeof rawScene.playAll === 'function') {
		(scene as any).playAll = async function(...args: any[]): Promise<void> {
			return (scene as any).play(...args);
		};
	}

	(scene as any).wait = async function(t = 1): Promise<void> {
		if (isDisposed || rawScene._disposed) return;
		if (t <= 0) return;
		if (isPaused) { await waitForResume(); if (isDisposed || rawScene._disposed) return; }
		let remainingMs = t * 1000;
		while (remainingMs > 0 && !isDisposed && !rawScene._disposed) {
			if (isPaused) { await waitForResume(); if (isDisposed || rawScene._disposed) return; }
			const needsPerFrame = typeof rawScene._needsPerFrameRendering === 'function' && rawScene._needsPerFrameRendering();
			if (!needsPerFrame) {
				if (typeof rawScene._render === 'function') safely(() => rawScene._render());
				remainingMs = await sleepWithInterrupt(remainingMs);
			} else {
				remainingMs = await frameLoopWithInterrupt(remainingMs);
			}
		}
		if (isPaused && !isDisposed && !rawScene._disposed) await waitForResume();
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
					if (isEditableElement(e.target as HTMLElement | null)) return;
					if (['Space', 'ArrowRight', 'Enter', 'PageDown'].includes(e.code)) {
						e.preventDefault(); cleanup(); resolve();
					}
				};
				const onClick = (e: MouseEvent) => {
					if ((e.target as HTMLElement)?.closest('.manim-block-header')) return;
					cleanup(); resolve();
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
	if (!element) return false;
	const tagName = element.tagName;
	return tagName === 'INPUT' || tagName === 'TEXTAREA' || Boolean(element.closest('.cm-editor'));
}
