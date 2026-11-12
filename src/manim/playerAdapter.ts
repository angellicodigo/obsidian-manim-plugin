import * as manimWeb from 'manim-web';
import type { ConstructableScene, SceneStateChange } from './runtime';
import { safely } from './runtimeUtils';

function extractPlayerOptions(config: unknown): Record<string, any> {
	if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
	const playerOptions = (config as Record<string, any>).PlayerOptions;
	if (playerOptions && typeof playerOptions === 'object' && !Array.isArray(playerOptions)) {
		return { ...playerOptions };
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
		return { container: firstArg, options: args[1] ?? {}, extraArgs: args.slice(2) };
	}
	if (firstArg && typeof firstArg === 'object') {
		return { container: fallbackMount, options: firstArg, extraArgs: args.slice(1) };
	}
	return { container: fallbackMount, options: args[1] ?? {}, extraArgs: args.slice(2) };
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

function patchPlayerSlidesNavigation(player: any): void {
	const originalSlidesModeNext = typeof player._slidesModeNext === 'function' ? player._slidesModeNext.bind(player) : null;
	const originalNextSlide = typeof player.nextSlide === 'function' ? player.nextSlide.bind(player) : null;

	if (originalSlidesModeNext) {
		player._slidesModeNext = function(): void {
			const slides = player._masterTimeline?.getSlides?.() ?? [];
			if (!slides.length) { originalSlidesModeNext(); return; }
			const currentTime = player._masterTimeline?.getCurrentTime?.() ?? 0;
			const duration = player._masterTimeline?.getDuration?.() ?? 0;
			const lastSlide = slides[slides.length - 1];
			if (currentTime >= lastSlide.endTime - 0.05 || currentTime >= duration - 0.05) {
				parkPlayerAtEnd(player, lastSlide.endTime, duration);
				return;
			}
			const isLoopingOnLastSlide = player._activeLoopSlideIndex !== null && player._activeLoopSlideIndex >= slides.length - 1;
			if (isLoopingOnLastSlide) { parkPlayerAtEnd(player, lastSlide.endTime, duration); return; }
			originalSlidesModeNext();
		};
	}

	if (originalNextSlide) {
		player.nextSlide = function(): void {
			if (player._slidesMode && typeof player._slidesModeNext === 'function') {
				player._slidesModeNext();
			} else { originalNextSlide(); }
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
		const tagName = (event.target as HTMLElement | null)?.tagName ?? '';
		if (tagName === 'INPUT' || tagName === 'TEXTAREA' || Boolean((event.target as HTMLElement | null)?.closest('.cm-editor'))) return;
		const isActive = isHovered || mount.contains(document.activeElement);
		if (!isActive) return;
		if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); event.stopPropagation(); player.nextSlide?.(); }
		else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); event.stopPropagation(); player.prevSlide?.(); }
		else if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); player.togglePlayPause?.(); }
		else if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); player.seek?.(0); }
	};
	window.addEventListener('keydown', onKeyDown, true);

	const onClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('[data-player-bar]')) return;
		if (player._slidesMode && !player._interactiveSlides && typeof player.nextSlide === 'function') player.nextSlide();
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
		const payload: SceneStateChange = { isRunning: isPlaying, isPaused, isFinished };
		for (const listener of stateListeners) safely(() => listener(payload));
	};

	const origPlay = typeof player.play === 'function' ? player.play.bind(player) : null;
	if (origPlay) player.play = function(...args: any[]) { origPlay(...args); notifyState(); };

	const origPause = typeof player.pause === 'function' ? player.pause.bind(player) : null;
	if (origPause) player.pause = function(...args: any[]) { origPause(...args); notifyState(); };

	if (player._ui && typeof player._ui.setPlaying === 'function') {
		const origSetPlaying = player._ui.setPlaying.bind(player._ui);
		player._ui.setPlaying = function(isPlaying: boolean, isFinished = false) { origSetPlaying(isPlaying, isFinished); notifyState(); };
	}

	return {
		get isPlaying() { return Boolean(player.isPlaying); },
		get isPaused() {
			const isPlaying = Boolean(player.isPlaying);
			const isFinished = Boolean(player._masterTimeline?.isFinished?.());
			return !isPlaying && !isFinished;
		},
		play: async () => { player.play?.(); notifyState(); },
		pause: () => { player.pause?.(); notifyState(); },
		resume: () => { player.play?.(); notifyState(); },
		stop: () => { player.pause?.(); player.seek?.(0); notifyState(); },
		dispose: () => { cleanupListeners(); stateListeners.clear(); safely(() => player.dispose?.()); },
		onStateChange: (listener: (state: SceneStateChange) => void) => {
			stateListeners.add(listener);
			notifyState();
			return () => { stateListeners.delete(listener); };
		},
	};
}

function resolveActivePlayer(capturedPlayer: any, exports: { default?: unknown }): any {
	if (capturedPlayer) return capturedPlayer;
	if (exports.default && typeof (exports.default as any).sequence === 'function') return exports.default;
	return null;
}

export { createPlayerProxy, attachPlayerInteractions, createPlayerSceneAdapter, resolveActivePlayer };
