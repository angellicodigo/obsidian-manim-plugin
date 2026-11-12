import { describe, it, expect } from 'vitest';

const OPENING_FENCE = /^\s*(`{3,}|~{3,})\s*manim\b/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

describe('fence regexes', () => {
	it('matches opening fences', () => {
		expect(OPENING_FENCE.test('```manim')).toBe(true);
		expect(OPENING_FENCE.test('~~~manim')).toBe(true);
		expect(OPENING_FENCE.test('```manim some-options')).toBe(true);
		expect(OPENING_FENCE.test('  ```manim')).toBe(true);
	});

	it('rejects non-manim opening fences', () => {
		expect(OPENING_FENCE.test('```ts')).toBe(false);
		expect(OPENING_FENCE.test('```python')).toBe(false);
		expect(OPENING_FENCE.test('```')).toBe(false);
	});

	it('matches closing fences', () => {
		expect(CLOSING_FENCE.test('```')).toBe(true);
		expect(CLOSING_FENCE.test('~~~')).toBe(true);
		expect(CLOSING_FENCE.test('  ```  ')).toBe(true);
	});

	it('rejects non-fence closing lines', () => {
		expect(CLOSING_FENCE.test('```manim')).toBe(false);
		expect(CLOSING_FENCE.test('some code')).toBe(false);
	});
});
