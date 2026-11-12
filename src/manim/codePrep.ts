import { transform } from 'sucrase';

const manimNamedImportPattern = /import\s*\{([\s\S]*?)\}\s*from\s*['\"](?:manim-web|\.\.\/src\/index(?:\.ts)?)['\"]\s*;?/g;
const manimStarImportPattern = /import\s*\*\s*as\s+(\w+)\s*from\s*['\"](?:manim-web|\.\.\/src\/index(?:\.ts)?)['\"]\s*;?/g;

function toDestructureField(specifier: string): string {
	const clean = specifier.trim().replace(/\s+/g, ' ');
	if (!clean) return '';

	const aliasMatch = clean.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
	if (aliasMatch) return `${aliasMatch[1]}: ${aliasMatch[2]}`;

	if (/^[A-Za-z_$][\w$]*$/.test(clean)) return clean;

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
			if (field) fields.push(field);
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
			"Legacy destructuring `const { ... } = manimWeb;` is no longer supported. Please use `import { ... } from 'manim-web';` instead.",
		);
	}
}

/** Prepare user source for execution: strip manim-web imports, inject container alias, transpile TS. */
export function prepareCode(source: string): string {
	assertNoLegacyDestructuring(source);
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

/** Transpile TypeScript source to JavaScript using sucrase. */
export function transpileToJavaScript(source: string): string {
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
