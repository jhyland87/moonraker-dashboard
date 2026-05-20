/**
 * Map common ASCII characters to their Unicode subscript / superscript
 * counterparts. Mirrors the `char_set` tables in
 * `moonraker-cli/includes/awk/variables.awk` so visuals match the bash
 * version.
 *
 * Unknown characters pass through unchanged.
 */

const SUBSCRIPT_MAP: Readonly<Record<string, string>> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '-': '₋',
  '+': '₊',
  // U+2024 ONE DOT LEADER renders as a small period at baseline height —
  // matches what the bash subset table uses for `.`.
  '.': '․',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  ' ': ' ',
};

const SUPERSCRIPT_MAP: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '-': '⁻',
  '+': '⁺',
  '.': '·',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  ' ': ' ',
};

const mapChars = (s: string, table: Readonly<Record<string, string>>): string => {
  // `Array.from` splits by code point — safer than `s.split('')` for any
  // non-BMP chars callers might pass.
  return Array.from(s, (c) => table[c] ?? c).join('');
};

/**
 * Convert digits and a few symbols in `s` to their Unicode subscript form.
 * Useful for axis labels and other tertiary information.
 */
export const toSubscript = (s: string): string => mapChars(s, SUBSCRIPT_MAP);

/**
 * Convert digits and a few symbols in `s` to their Unicode superscript form.
 */
export const toSuperscript = (s: string): string => mapChars(s, SUPERSCRIPT_MAP);
