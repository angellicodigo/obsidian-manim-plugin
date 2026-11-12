import * as manimWeb from 'manim-web';
import { prepareCode, transpileToJavaScript } from './codePrep';
import { attachScenePauseController } from './sceneController';
import { createPlayerProxy, attachPlayerInteractions, createPlayerSceneAdapter, resolveActivePlayer } from './playerAdapter';
import { safely } from './runtimeUtils';

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

/** Create a Document proxy that maps container lookups to our mount element. */
function createDocumentProxy(container: HTMLElement): Document {
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
			if (prop === 'getElementById') return getElementById;
			if (prop === 'querySelector') return querySelector;
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
	}) as Document;
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
			if (prop === 'Player') return playerProxy;
			return Reflect.get(target, prop, receiver);
		},
	});

	const exports: { default?: unknown } = {};
	const executor = new Function(
		'container', '__MANIM_CONTAINER__', '__MANIM_INTERNAL__',
		'document', 'window', 'self', 'exports',
		`return (async () => {\n${code}\n})();`,
	);

	try {
		await executor(mount, mount, manimWebProxy, documentProxy, window, window, exports);
	} catch (error) {
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
			if (typeof scene.construct === 'function') await scene.construct();
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


