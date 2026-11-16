/**
 * Generate manim-web autocomplete data from its type declarations.
 *
 * Reads node_modules/manim-web/dist/index.d.ts, resolves each re-export
 * to its source .d.ts file, classifies each symbol (class/function/const/type),
 * and writes src/manim/generated-completions.ts.
 *
 * Run:  node scripts/generate-completions.mjs
 */

import { createSourceFile, ScriptTarget, ScriptKind, SyntaxKind, isExportDeclaration, isNamedExports } from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const MANIM_DTS = path.resolve('node_modules/manim-web/dist/index.d.ts');
const MANIM_DIST = path.resolve('node_modules/manim-web/dist');
const OUT_FILE = path.resolve('src/manim/generated-completions.ts');

if (!fs.existsSync(MANIM_DTS)) {
	console.error('manim-web types not found at ' + MANIM_DTS);
	process.exit(1);
}

const dts = fs.readFileSync(MANIM_DTS, 'utf8');
const sourceFile = createSourceFile('index.d.ts', dts, ScriptTarget.Latest, true, ScriptKind.TS);
const indexDir = path.dirname(MANIM_DTS);

// Cache for resolved .d.ts file contents
const fileCache = new Map();

function readDts(relativePath) {
	const candidates = [
		path.join(indexDir, relativePath + '.d.ts'),
		path.join(indexDir, relativePath, 'index.d.ts'),
		path.resolve(indexDir, relativePath + '.d.ts'),
		path.resolve(indexDir, relativePath, 'index.d.ts'),
	];

	for (const c of candidates) {
		if (fs.existsSync(c)) {
			if (!fileCache.has(c)) {
				fileCache.set(c, fs.readFileSync(c, 'utf8'));
			}
			return fileCache.get(c);
		}
	}
	return null;
}

// Build type map by resolving re-exports to their source declarations
const typeMap = new Map();

function scanSourceForLabel(sourceText, label) {
	const lines = sourceText.split('\n');
	const patterns = [
		[new RegExp('(?:export\\s+(?:abstract\\s+)?)class\\s+' + label + '\\b'), 'class'],
		[new RegExp('(?:export\\s+)function\\s+' + label + '\\b'), 'function'],
		[new RegExp('(?:export\\s+(?:declare\\s+)?)?(?:const|let|var)\\s+' + label + '\\b'), 'const'],
		[new RegExp('(?:export\\s+)type\\s+' + label + '\\b'), 'type'],
		[new RegExp('(?:export\\s+)interface\\s+' + label + '\\b'), 'type'],
		[new RegExp('(?:export\\s+)enum\\s+' + label + '\\b'), 'const'],
	];

	for (const line of lines) {
		for (const [regex, kind] of patterns) {
			if (regex.test(line)) return kind;
		}
	}
	return null;
}

// Collect exports with their source module
const exportsWithSource = [];

function visit(node) {
	if (node.kind === SyntaxKind.ExportDeclaration) {
		const decl = node;
		const moduleSpec = decl.moduleSpecifier && decl.moduleSpecifier.text;

		if (decl.exportClause && decl.exportClause.elements) {
			// Named re-export: export { X, Y } from './path'
			for (const el of decl.exportClause.elements) {
				exportsWithSource.push({
					label: el.name.text,
					moduleSpec,
				});
			}
		} else if (moduleSpec) {
			// Namespace re-export: export * from './path'
			exportsWithSource.push({
				label: '__NAMESPACE_EXPORT__',
				moduleSpec,
				isNamespaceExport: true,
			});
		}
	}
	node.forEachChild(visit);
}
visit(sourceFile);

// Resolve each export
const resolved = [];

for (const exp of exportsWithSource) {
	// Handle namespace exports: expand all symbols from the target file
	if (exp.isNamespaceExport) {
		const sourceText = readDts(exp.moduleSpec);
		if (sourceText) {
			const nsSourceFile = createSourceFile('namespace.d.ts', sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
			function collectNs(n) {
				if (n.name && n.name.text) {
					let kind;
					switch (n.kind) {
						case SyntaxKind.ClassDeclaration: kind = 'class'; break;
						case SyntaxKind.FunctionDeclaration: kind = 'function'; break;
						case SyntaxKind.TypeAliasDeclaration:
						case SyntaxKind.InterfaceDeclaration: kind = 'type'; break;
						case SyntaxKind.EnumDeclaration: kind = 'const'; break;
						case SyntaxKind.VariableDeclaration: kind = 'const'; break;
						default: kind = null;
					}
					if (kind) {
						resolved.push({ label: n.name.text, type: kind });
					}
				}
				n.forEachChild(collectNs);
			}
			collectNs(nsSourceFile);
		}
		continue;
	}

	let type = null;

	if (exp.moduleSpec) {
		const sourceText = readDts(exp.moduleSpec);
		if (sourceText) {
			type = scanSourceForLabel(sourceText, exp.label);
		}
	}

	// Fallback to naming heuristics
	if (!type) {
		if (/^[A-Z_][A-Z0-9_]*$/.test(exp.label)) {
			type = 'const';
		} else if (/^[A-Z][a-zA-Z0-9]*$/.test(exp.label)) {
			if (/Options$/.test(exp.label) || /Props$/.test(exp.label) || /Config$/.test(exp.label)) type = 'type';
			else type = 'class';
		} else if (/^[a-z]/.test(exp.label)) {
			type = 'function';
		} else {
			type = 'const';
		}
	}

	resolved.push({ label: exp.label, type });
}

// Deduplicate
const seen = new Set();
const unique = [];
for (const item of resolved) {
	if (!seen.has(item.label)) {
		seen.add(item.label);
		unique.push(item);
	}
}

// Sort: classes first, then functions, then consts, then types
const orderMap = { class: 0, function: 1, const: 2, type: 3 };
unique.sort((a, b) => {
	const aOrder = orderMap[a.type] ?? 99;
	const bOrder = orderMap[b.type] ?? 99;
	if (aOrder !== bOrder) return aOrder - bOrder;
	return a.label.localeCompare(b.label);
});

// Build detail strings
function buildDetail(label, type) {
	if (type !== 'class' && type !== 'function') return undefined;

	for (const [filePath, sourceText] of fileCache) {
		const lines = sourceText.split('\n');
		const regex = new RegExp('(?:export\\s+(?:declare\\s+)?)(?:class|function)\\s+' + label + '\\s*\\(([^)]*)\\)');
		for (const line of lines) {
			const m = line.match(regex);
			if (m) return '(' + m[1] + ')';
		}
	}
	return undefined;
}

const completionItems = unique.map((item) => {
	const detail = buildDetail(item.label, item.type);
	return '\t{ label: ' + JSON.stringify(item.label) + ', type: ' + JSON.stringify(item.type) + ', detail: ' + (detail ? JSON.stringify(detail) : 'undefined') + ' },';
});

const header = '// AUTO-GENERATED by scripts/generate-completions.mjs — DO NOT EDIT BY HAND.\n// Regenerate with: node scripts/generate-completions.mjs\nimport type { Completion } from \'@codemirror/autocomplete\';\n\nexport const manimWebCompletions: readonly Completion[] = [\n';

const footer = '];\n';

fs.writeFileSync(OUT_FILE, header + completionItems.join('\n') + '\n' + footer, 'utf8');

console.log('Generated ' + completionItems.length + ' completions → ' + OUT_FILE);
const sample = unique.slice(0, 15);
for (const s of sample) {
	console.log('  ' + s.label + ' (' + s.type + ')');
}
