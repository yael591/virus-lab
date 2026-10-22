// Robust parsing of the model's reply, including recovery from a truncated JSON.

export interface ParseResult<T> {
  value: T | null;
  repaired: boolean;
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

/**
 * Close a truncated JSON object: keep everything up to the last fully closed
 * object/array, drop a dangling comma, then close whatever is still open.
 */
export function repairTruncated(input: string): unknown | null {
  const start = input.indexOf('{');
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let cut = -1;
  let openAtCut: string[] = [];
  for (let i = start; i < input.length; i++) {
    const c = input[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      cut = i;
      openAtCut = [...stack];
      if (stack.length === 0) break;
    }
  }
  if (cut < 0) return null;
  let text = input.slice(start, cut + 1).replace(/,\s*$/, '');
  for (let k = openAtCut.length - 1; k >= 0; k--) text += openAtCut[k] === '{' ? '}' : ']';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseModelJson<T = unknown>(reply: string): ParseResult<T> {
  const s = stripFences(reply ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return { value: JSON.parse(s.slice(a, b + 1)) as T, repaired: false };
    } catch {
      /* fall through */
    }
  }
  const r = repairTruncated(s);
  return r ? { value: r as T, repaired: true } : { value: null, repaired: false };
}
