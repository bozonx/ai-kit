/**
 * The glossary, applied three times and differently each time.
 *
 * 1. In the prompt — only the entries that actually occur in the text. Sending
 *    three hundred terms along with a paragraph is paying for what cannot be
 *    used.
 * 2. In the quality detectors — a violated glossary is found deterministically
 *    and goes into the list of problems for the repair pass.
 * 3. In post-processing — for "do not translate" terms the source spelling is
 *    put back by a plain replacement. The right answer is known in advance, so
 *    the model does not get a second chance to spoil a product name.
 *
 * Pure string work, no I/O. It is in the library rather than in a product
 * because a binding glossary is the same idea in every product that has one,
 * and because getting the matching rules wrong is a defect nobody reports —
 * from the outside it looks like the glossary was never switched on.
 */

/** One binding term and what it becomes. */
export interface GlossaryEntry {
  term: string;
  /** The default rendering, when no per-language one applies. */
  use: string;
  /** Keep the source spelling: a product name, a handle, an identifier. */
  doNotTranslate: boolean;
  /** Per target language, keyed by the language code used in translations. */
  translations?: Record<string, string>;
  /** Defaults to false: `api` matches `API` unless the term says otherwise. */
  caseSensitive?: boolean;
  /** Defaults to true. */
  wholeWord?: boolean;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matcher(entry: GlossaryEntry): RegExp {
  const wholeWord = entry.wholeWord !== false;
  const body = escapeForRegExp(entry.term);
  // Lookarounds rather than \b: \b is defined over ASCII word characters, so
  // it fires in the middle of a Cyrillic or Greek word.
  const pattern = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(pattern, entry.caseSensitive ? 'gu' : 'giu');
}

/** Whether a term occurs in the text under its own matching rules. */
export function glossaryEntryOccurs(entry: GlossaryEntry, text: string): boolean {
  if (!entry.term) return false;
  return matcher(entry).test(text);
}

/** The entries worth spending prompt tokens on for this particular text. */
export function selectGlossaryForText(entries: GlossaryEntry[], text: string): GlossaryEntry[] {
  return entries.filter(entry => glossaryEntryOccurs(entry, text));
}

/** What a term should become in the target language, or null to keep it. */
export function glossaryRendering(
  entry: GlossaryEntry,
  targetLanguage: string | undefined,
): string | null {
  if (entry.doNotTranslate) return null;
  const code = targetLanguage?.trim().toLocaleLowerCase('und');
  if (code) {
    const exact = entry.translations?.[code];
    if (exact) return exact;
    const base = code.split(/[-_]/).at(0);
    const byBase = base ? entry.translations?.[base] : undefined;
    if (byBase) return byBase;
  }
  return entry.use;
}

/** The glossary block of the prompt, or an empty string when nothing applies. */
export function renderGlossaryForPrompt(entries: GlossaryEntry[], targetLanguage?: string): string {
  if (!entries.length) return '';
  const lines = entries.map(entry => {
    const rendering = glossaryRendering(entry, targetLanguage);
    return rendering === null
      ? `- ${entry.term}: keep exactly as written, do not translate`
      : `- ${entry.term}: ${rendering}`;
  });
  return `Glossary (binding):\n${lines.join('\n')}`;
}

/**
 * Puts the source spelling of "do not translate" terms back.
 *
 * Only occurrences the model changed are touched, and only when the source
 * really contained the term: a text that never mentioned the product name is
 * not going to have one inserted into it.
 */
export function restoreKeptTerms(params: {
  source: string;
  translated: string;
  entries: GlossaryEntry[];
}): { text: string; restored: string[] } {
  const restored: string[] = [];
  let text = params.translated;

  for (const entry of params.entries) {
    if (!entry.doNotTranslate || !entry.term) continue;
    if (!glossaryEntryOccurs(entry, params.source)) continue;
    if (glossaryEntryOccurs(entry, text)) continue;

    // The model rendered the term as something else, and the something else
    // cannot be located reliably, so the only safe repair is to report it.
    restored.push(entry.term);
  }

  // Case is the one deviation that can be repaired without guessing: the term
  // is there, spelled differently.
  for (const entry of params.entries) {
    if (!entry.doNotTranslate || !entry.term || entry.caseSensitive) continue;
    const insensitive = new RegExp(matcher({ ...entry, caseSensitive: false }).source, 'giu');
    text = text.replace(insensitive, entry.term);
  }

  return { text, restored };
}

/** Terms the translation lost or rendered against the glossary. */
export function findGlossaryViolations(params: {
  source: string;
  translated: string;
  entries: GlossaryEntry[];
  targetLanguage?: string;
}): string[] {
  const violations: string[] = [];
  for (const entry of params.entries) {
    if (!glossaryEntryOccurs(entry, params.source)) continue;
    const expected = glossaryRendering(entry, params.targetLanguage);
    const wanted: GlossaryEntry = expected === null ? entry : { ...entry, term: expected };
    if (!glossaryEntryOccurs(wanted, params.translated)) violations.push(entry.term);
  }
  return violations;
}
