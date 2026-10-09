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

export async function runManimSource(source: string, outputEl: HTMLElement): Promise<void> {
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
	const SceneClass = exports.default as (new (container: HTMLElement) => any) | undefined;
	if (typeof SceneClass === 'function') {
		const scene = new SceneClass(mount);
		if (typeof scene.construct === 'function') {
			await scene.construct();
		}
	}
}