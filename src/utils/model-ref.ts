/**
 * Parsing of a model reference as a user or an API caller writes it.
 *
 * Carried over from the router, where it earned its place: people write
 * "gemini-2.5-flash", "google/gemini-2.5-flash" and a priority list, and all
 * three have to mean something.
 */

export interface ModelRef {
  name: string;
  /** Present when the input was written as "provider/model". */
  provider?: string;
}

export interface ParsedModelInput {
  /** References in priority order. Empty means "no preference". */
  refs: ModelRef[];
  /** True when the caller allowed the policy to choose after the list runs out. */
  allowAuto: boolean;
}

const AUTO = 'auto';

function parseOne(input: string): ModelRef | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === AUTO) return null;

  const slash = trimmed.indexOf('/');
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), name: trimmed.slice(slash + 1) };
  }
  return { name: trimmed };
}

/**
 * Accepted shapes:
 * - `undefined` or `'auto'` — the policy chooses.
 * - `'model'` / `'provider/model'` — exactly this one.
 * - `['a', 'provider/b']` — a priority list.
 * - `['a', 'auto']` — a priority list, then whatever the policy likes.
 */
export function parseModelInput(input: string | string[] | undefined): ParsedModelInput {
  if (!input) return { refs: [], allowAuto: true };

  if (typeof input === 'string') {
    const ref = parseOne(input);
    return { refs: ref ? [ref] : [], allowAuto: ref === null };
  }

  const refs: ModelRef[] = [];
  let allowAuto = false;

  for (const item of input) {
    if (typeof item !== 'string') continue;
    if (item.trim().toLowerCase() === AUTO) {
      // "auto" terminates the list: anything written after "whatever you like"
      // cannot mean anything.
      allowAuto = true;
      break;
    }
    const ref = parseOne(item);
    if (ref) refs.push(ref);
  }

  return { refs, allowAuto };
}

/** Renders a reference back into "provider/model" or "model". */
export function formatModelRef(ref: ModelRef): string {
  return ref.provider ? `${ref.provider}/${ref.name}` : ref.name;
}
