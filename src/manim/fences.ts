/** Opening line of a manim code fence, e.g. "```manim" or "~~~manim". */
export const OPENING_FENCE = /^\s*(`{3,}|~{3,})\s*manim\b/;

/** A bare closing fence line, e.g. "```". */
export const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
