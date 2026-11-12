import { describe, it, expect } from 'vitest';
import { prepareCode } from '../src/manim/codePrep';

describe('prepareCode', () => {
	it('strips named manim-web imports and injects them as destructuring', () => {
		const source = `import { Circle, BLUE } from 'manim-web';\nconst c = new Circle({ color: BLUE });`;
		const result = prepareCode(source);
		expect(result).toContain('const { Circle, BLUE } = __MANIM_INTERNAL__;');
		expect(result).not.toContain("from 'manim-web'");
		expect(result).toContain('const c = new Circle({ color: BLUE });');
	});

	it('strips star imports', () => {
		const source = `import * as m from 'manim-web';\nconst c = new m.Circle();`;
		const result = prepareCode(source);
		expect(result).not.toContain("from 'manim-web'");
		expect(result).toContain('const c = new m.Circle();');
	});

	it('replaces document.getElementById lookups with container alias', () => {
		const source = `const el = document.getElementById('container');`;
		const result = prepareCode(source);
		expect(result).toContain('__MANIM_CONTAINER__');
		expect(result).not.toContain('getElementById');
	});

	it('rejects legacy destructuring', () => {
		expect(() => prepareCode(`const { Circle } = manimWeb;\n`)).toThrow(/Legacy destructuring/);
	});

	it('rejects non-manim-web imports', () => {
		expect(() => prepareCode(`import { foo } from 'bar';\n`)).toThrow(/Only imports from manim-web/);
	});

	it('handles source with no imports', () => {
		const source = `const x = 1 + 2;\n`;
		const result = prepareCode(source);
		expect(result).toBe(source);
	});
});
