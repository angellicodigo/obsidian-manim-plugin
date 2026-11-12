import { describe, it, expect } from 'vitest';
import { buildFontStack } from '../src/manim/editorStyle';
import type { ManimEditorFont } from '../src/settings';

describe('buildFontStack', () => {
	it('quotes non-monospace fonts with var(--font-monospace) fallback', () => {
		expect(buildFontStack('JetBrains Mono')).toBe("'JetBrains Mono', var(--font-monospace)");
		expect(buildFontStack('Fira Code')).toBe("'Fira Code', var(--font-monospace)");
		expect(buildFontStack('Lucida Console')).toBe("'Lucida Console', var(--font-monospace)");
		expect(buildFontStack('Consolas')).toBe("'Consolas', var(--font-monospace)");
	});

	it('does not quote monospace (generic keyword)', () => {
		expect(buildFontStack('Monospace')).toBe('monospace, var(--font-monospace)');
	});

	it('handles all font options from the settings type', () => {
		const fonts: ManimEditorFont[] = ['JetBrains Mono', 'Monospace', 'Fira Code', 'Lucida Console', 'Consolas'];
		for (const font of fonts) {
			const stack = buildFontStack(font);
			expect(stack).toContain('var(--font-monospace)');
		}
	});
});
