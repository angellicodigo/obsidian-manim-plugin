import { describe, it, expect } from 'vitest';

import { CLOSING_FENCE, OPENING_FENCE } from '../src/manim/fences';

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
