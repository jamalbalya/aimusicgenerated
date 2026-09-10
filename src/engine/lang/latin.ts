/**
 * Letter-to-sound tables for the Latin-script languages.
 *
 * Each table is written the way a pronunciation guide is written — the
 * exceptions first, the plain letters last — because the rule engine tries the
 * longest and most constrained match first. Where a language has two accepted
 * pronunciations, the tables follow the variety with the most speakers
 * (Latin-American Spanish, Brazilian Portuguese), which is the one a listener
 * is most likely to recognise.
 */

import type { SoundRule, SyllableOptions } from '../voice/phonemes'
import type { LanguageProfile } from './types'
import { diphthongSet, FIVE_VOWELS, letters, when } from './rules'

/** Every language here allows at most a two-consonant onset unless it says otherwise. */
const DEFAULT_SYLLABLE: SyllableOptions = { maxOnset: 2 }

/** The rising and falling glides a five-vowel language writes as two letters. */
const FIVE_VOWEL_DIPHTHONGS = diphthongSet([
  ['IY', 'A'], ['IY', 'E'], ['IY', 'O'], ['IY', 'UW'],
  ['UW', 'A'], ['UW', 'E'], ['UW', 'IY'], ['UW', 'O'],
  ['A', 'IY'], ['E', 'IY'], ['O', 'IY'],
  ['A', 'UW'], ['E', 'UW'], ['O', 'UW'],
])

/* ------------------------------------------------------------- Indonesian --- */

// Written "e" is two different vowels and the spelling does not distinguish
// them. The schwa is the one that occurs in non-final syllables, which is what
// the lookahead for a later vowel tests for.
const INDONESIAN: SoundRule[] = [
  ...letters({
    ng: 'NG', ny: 'NY', sy: 'SH', kh: 'X', gh: 'GX',
    c: 'CH', j: 'JH', y: 'Y', r: 'DX', v: 'F', x: 'K S', q: 'K',
    ai: 'A IY', au: 'A UW', oi: 'O IY',
    ...FIVE_VOWELS,
    b: 'B', d: 'D', f: 'F', g: 'G', h: 'HH', k: 'K', l: 'L', m: 'M',
    n: 'N', p: 'P', s: 'S', t: 'T', w: 'W', z: 'Z',
  }),
  when('e', 'AX', { followedBy: /[aeiou]/ }),
  // A final k is a glottal stop, which is why "tidak" does not end like "tick".
  when('k', 'Q', { at: 'end' }),
  when('ng', 'NG', { at: 'end' }),
]

/* ---------------------------------------------------------------- Spanish --- */

const SPANISH: SoundRule[] = [
  ...letters({
    ch: 'CH', ll: 'Y', rr: 'RR', qu: 'K', gu: 'G', 'gü': 'G W',
    'ñ': 'NY', 'á': 'A', 'é': 'E', 'í': 'IY', 'ó': 'O', 'ú': 'UW', 'ü': 'UW',
    ...FIVE_VOWELS,
    b: 'B', v: 'B', d: 'D', f: 'F', h: '', j: 'X', k: 'K', l: 'L', m: 'M',
    n: 'N', p: 'P', s: 'S', t: 'T', w: 'W', x: 'K S', y: 'Y', z: 'S', c: 'K', g: 'G',
  }),
  when('c', 'S', { next: 'eéií' }),
  when('g', 'X', { next: 'eéií' }),
  when('gu', 'G', { next: 'eéií' }),
  // The trill is written double between vowels but single at the word's edge.
  when('r', 'RR', { at: 'start' }),
  when('r', 'RR', { prev: 'nls' }),
  when('r', 'DX', {}),
  when('y', 'IY', { at: 'end' }),
]

/* ---------------------------------------------------------------- Italian --- */

const ITALIAN: SoundRule[] = [
  ...letters({
    sci: 'SH IY', sce: 'SH E', sch: 'S K',
    chi: 'K IY', che: 'K E', ghi: 'G IY', ghe: 'G E',
    gli: 'LY IY', gn: 'NY', gi: 'JH IY', ge: 'JH E', ci: 'CH IY', ce: 'CH E',
    qu: 'K W', zz: 'TS', z: 'TS', rr: 'RR',
    'à': 'A', 'è': 'EH', 'é': 'E', 'ì': 'IY', 'ò': 'AO', 'ó': 'O', 'ù': 'UW',
    ...FIVE_VOWELS,
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: '', l: 'L', m: 'M', n: 'N',
    p: 'P', r: 'DX', s: 'S', t: 'T', v: 'V', j: 'Y', k: 'K', w: 'V', x: 'K S', y: 'IY',
  }),
  // Between vowels an s is voiced in the standard northern pronunciation.
  when('s', 'Z', { prev: 'aeiou', next: 'aeiou' }),
]

/* ------------------------------------------------------------- Portuguese --- */

// Brazilian Portuguese: unstressed final vowels raise, t and d palatalise
// before an i sound, and the r at the start of a word is a breath, not a trill.
const PORTUGUESE: SoundRule[] = [
  ...letters({
    'ão': 'AN', 'ãe': 'EN', 'õe': 'ON', 'ã': 'AN', 'õ': 'ON',
    lh: 'LY', nh: 'NY', ch: 'SH', rr: 'HH', ss: 'S', 'ç': 'S',
    qu: 'K', gu: 'G', 'á': 'A', 'â': 'A', 'é': 'EH', 'ê': 'E',
    'í': 'IY', 'ó': 'AO', 'ô': 'O', 'ú': 'UW', 'à': 'A',
    ...FIVE_VOWELS,
    b: 'B', d: 'D', f: 'F', g: 'G', h: '', j: 'ZH', k: 'K', l: 'L', m: 'M',
    n: 'N', p: 'P', t: 'T', v: 'V', w: 'V', x: 'SH', y: 'IY', z: 'Z', c: 'K', r: 'DX', s: 'S',
  }),
  when('c', 'S', { next: 'eéêií' }),
  when('g', 'ZH', { next: 'eéêií' }),
  when('r', 'HH', { at: 'start' }),
  when('s', 'Z', { prev: 'aeiouáâãéêíóôõú', next: 'aeiouáâãéêíóôõú' }),
  when('z', 'S', { at: 'end' }),
  // A vowel before a syllable-final m or n is nasalised and the nasal is not
  // itself pronounced: "bem" rhymes with the French "bain", not with "hem".
  when('am', 'AN', { at: 'end' }),
  when('em', 'EN', { at: 'end' }),
  when('im', 'EN', { at: 'end' }),
  when('om', 'ON', { at: 'end' }),
  when('um', 'UN', { at: 'end' }),
  when('an', 'AN', { notNext: 'aeiouáâãéêíóôõún' }),
  when('en', 'EN', { notNext: 'aeiouáâãéêíóôõún' }),
  when('in', 'EN', { notNext: 'aeiouáâãéêíóôõún' }),
  when('on', 'ON', { notNext: 'aeiouáâãéêíóôõún' }),
  when('un', 'UN', { notNext: 'aeiouáâãéêíóôõún' }),
  when('ti', 'CH IY', { at: 'end' }),
  when('di', 'JH IY', { at: 'end' }),
  when('te', 'CH IY', { at: 'end' }),
  when('de', 'JH IY', { at: 'end' }),
  when('o', 'UW', { at: 'end' }),
  when('e', 'IY', { at: 'end' }),
  when('os', 'UW S', { at: 'end' }),
  when('es', 'IY S', { at: 'end' }),
]

/* ----------------------------------------------------------------- French --- */

const FRENCH_VOWEL_LETTERS = 'aeiouyàâäéèêëîïôöùûü'

const FRENCH: SoundRule[] = [
  ...letters({
    eau: 'O', eaux: 'O', 'œu': 'OE', oeu: 'OE', ill: 'Y', ail: 'A Y', eil: 'E Y',
    ain: 'EN', aim: 'EN', ein: 'EN', oin: 'W EN',
    an: 'AN', am: 'AN', en: 'AN', em: 'AN', in: 'EN', im: 'EN',
    on: 'ON', om: 'ON', un: 'UN', um: 'UN',
    ou: 'UW', oi: 'W A', au: 'O', ai: 'EH', ei: 'EH', eu: 'OE',
    'ç': 'S', ch: 'SH', gn: 'NY', ph: 'F', th: 'T', qu: 'K',
    'é': 'E', 'è': 'EH', 'ê': 'EH', 'ë': 'EH', 'à': 'A', 'â': 'A',
    'î': 'IY', 'ï': 'IY', 'ô': 'O', 'ö': 'OE', 'ù': 'UW', 'û': 'UW', 'ü': 'UE',
    a: 'A', e: 'AX', i: 'IY', o: 'O', u: 'UE', y: 'IY',
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: '', j: 'ZH', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', r: 'RU', s: 'S', t: 'T', v: 'V', w: 'W', x: 'K S', z: 'Z',
  }),
  // A nasal spelling is only nasal when nothing follows it — "bon" is nasal,
  // "bonne" is not. Before a vowel the n is a consonant of its own; before a
  // second n it is that second n that gets said, so the vowel is all this rule
  // has to produce.
  when('an', 'A N', { next: FRENCH_VOWEL_LETTERS }),
  when('en', 'AX N', { next: FRENCH_VOWEL_LETTERS }),
  when('in', 'IY N', { next: FRENCH_VOWEL_LETTERS }),
  when('on', 'O N', { next: FRENCH_VOWEL_LETTERS }),
  when('un', 'UE N', { next: FRENCH_VOWEL_LETTERS }),
  when('am', 'A M', { next: FRENCH_VOWEL_LETTERS }),
  when('om', 'O M', { next: FRENCH_VOWEL_LETTERS }),
  when('an', 'A', { next: 'n' }),
  when('en', 'AX', { next: 'n' }),
  when('in', 'IY', { next: 'n' }),
  when('on', 'O', { next: 'n' }),
  when('un', 'UE', { next: 'n' }),
  when('am', 'A', { next: 'm' }),
  when('om', 'O', { next: 'm' }),
  when('c', 'S', { next: 'eéèêiïy' }),
  when('g', 'ZH', { next: 'eéèêiïy' }),
  when('s', 'Z', { prev: FRENCH_VOWEL_LETTERS, next: FRENCH_VOWEL_LETTERS }),
  when('er', 'E', { at: 'end' }),
  when('ez', 'E', { at: 'end' }),
  when('et', 'EH', { at: 'end' }),
  // Most word-final consonants are written but not said.
  when('e', '', { at: 'end' }),
  when('es', '', { at: 'end' }),
  when('s', '', { at: 'end' }),
  when('t', '', { at: 'end' }),
  when('d', '', { at: 'end' }),
  when('x', '', { at: 'end' }),
  when('z', '', { at: 'end' }),
  when('p', '', { at: 'end' }),
]

/**
 * The very common French words the rules cannot get right.
 *
 * "les" and "elles" both end in -es, but only one of them says it. The
 * difference is grammatical rather than phonetic, so it belongs in a list.
 */
const FRENCH_EXCEPTIONS: Record<string, string> = {
  le: 'L AX', la: 'L A', les: 'L E', de: 'D AX', des: 'D E', du: 'D UE',
  un: 'UN', une: 'UE N', et: 'E', est: 'E', es: 'E', ai: 'E',
  je: 'ZH AX', me: 'M AX', te: 'T AX', se: 'S AX', ce: 'S AX', ne: 'N AX',
  que: 'K AX', qui: 'K IY', quoi: 'K W A', oui: 'W IY',
  mes: 'M E', tes: 'T E', ses: 'S E', ces: 'S E',
  nous: 'N UW', vous: 'V UW', tout: 'T UW', tous: 'T UW',
  plus: 'P L UE', temps: 'T AN', femme: 'F A M', monsieur: 'M AX SH OE',
  fils: 'F IY S', 'où': 'UW', 'à': 'A', 'a': 'A', y: 'IY',
  toi: 'T W A', moi: 'M W A', 'très': 'T RU EH', 'après': 'A P RU EH',
  coeur: 'K OE RU', 'cœur': 'K OE RU', amour: 'A M UW RU', jamais: 'ZH A M EH',
  beaucoup: 'B O K UW', aussi: 'O S IY',
}

/* ----------------------------------------------------------------- German --- */

const GERMAN: SoundRule[] = [
  ...letters({
    tsch: 'CH', sch: 'SH', chs: 'K S', ch: 'CX',
    ie: 'IY', ei: 'AY', ai: 'AY', eu: 'OY', 'äu': 'OY', au: 'AW',
    'ß': 'S', pf: 'PF', tz: 'TS', ng: 'NG', qu: 'K V',
    ah: 'A', eh: 'E', ih: 'IY', oh: 'O', uh: 'UW', 'äh': 'EH', 'öh': 'OE', 'üh': 'UE',
    aa: 'A', ee: 'E', oo: 'O',
    'ä': 'EH', 'ö': 'OE', 'ü': 'UE',
    a: 'A', e: 'E', i: 'IH', o: 'O', u: 'UW', y: 'UE',
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', r: 'RU', s: 'S', t: 'T', v: 'F', w: 'V', x: 'K S', z: 'TS',
  }),
  // ch is a back sound after a back vowel and a front one everywhere else.
  when('ch', 'X', { prev: 'aou' }),
  when('sp', 'SH P', { at: 'start' }),
  when('st', 'SH T', { at: 'start' }),
  when('s', 'Z', { next: 'aeiouäöü' }),
  // The r after a vowel is not a consonant at all; it colours the vowel.
  when('er', 'AX', { at: 'end' }),
  when('e', 'AX', { at: 'end' }),
  when('en', 'AX N', { at: 'end' }),
  // Final obstruents devoice: "Tag" ends like "tack".
  when('b', 'P', { at: 'end' }),
  when('d', 'T', { at: 'end' }),
  when('g', 'K', { at: 'end' }),
]

/* ------------------------------------------------------------------ Dutch --- */

const DUTCH: SoundRule[] = [
  ...letters({
    sch: 'S X', ch: 'X', ng: 'NG', nj: 'NY', tj: 'CH',
    aa: 'A', ee: 'E', oo: 'O', uu: 'UE', ie: 'IY', oe: 'UW',
    eu: 'OE', ui: 'OE Y', ij: 'AY', ei: 'AY', ou: 'AW', au: 'AW', aai: 'A Y',
    a: 'A', e: 'EH', i: 'IH', o: 'O', u: 'UE', y: 'IY',
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'X', h: 'HH', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'V',
    x: 'K S', z: 'Z',
  }),
  when('e', 'AX', { at: 'end' }),
  when('b', 'P', { at: 'end' }),
  when('d', 'T', { at: 'end' }),
]

/* ---------------------------------------------------------------- Turkish --- */

// Turkish spelling is exactly phonemic: one letter, one sound, no exceptions,
// no consonant clusters at the start of a native word.
const TURKISH: SoundRule[] = letters({
  a: 'A', e: 'EH', 'ı': 'IX', i: 'IY', o: 'O', 'ö': 'OE', u: 'UW', 'ü': 'UE',
  b: 'B', c: 'JH', 'ç': 'CH', d: 'D', f: 'F', g: 'G', 'ğ': '', h: 'HH',
  j: 'ZH', k: 'K', l: 'L', m: 'M', n: 'N', p: 'P', r: 'DX', s: 'S',
  'ş': 'SH', t: 'T', v: 'V', y: 'Y', z: 'Z', q: 'K', w: 'V', x: 'K S',
})

/* ----------------------------------------------------------------- Polish --- */

const POLISH: SoundRule[] = [
  ...letters({
    cz: 'CH', 'dź': 'JH', 'dż': 'JH', dz: 'DZ', ch: 'X', sz: 'SH', rz: 'ZH',
    'ą': 'ON', 'ę': 'EN', 'ó': 'UW', 'ć': 'CH', 'ń': 'NY', 'ś': 'SH',
    'ź': 'ZH', 'ż': 'ZH', 'ł': 'W',
    a: 'A', e: 'EH', i: 'IY', o: 'O', u: 'UW', y: 'IX',
    b: 'B', c: 'TS', d: 'D', f: 'F', g: 'G', h: 'X', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', r: 'DX', s: 'S', t: 'T', w: 'V', z: 'Z', v: 'V', x: 'K S',
  }),
  // A soft consonant written with a following i palatalises rather than adding
  // a vowel of its own.
  when('si', 'SH', { next: 'aeouą' }),
  when('zi', 'ZH', { next: 'aeouą' }),
  when('ci', 'CH', { next: 'aeouą' }),
  when('ni', 'NY', { next: 'aeouą' }),
]

/* --------------------------------------------------------------- Romanian --- */

const ROMANIAN: SoundRule[] = [
  ...letters({
    che: 'K E', chi: 'K IY', ghe: 'G E', ghi: 'G IY',
    ce: 'CH E', ci: 'CH IY', ge: 'JH E', gi: 'JH IY',
    'ă': 'AX', 'â': 'IX', 'î': 'IX', 'ș': 'SH', 'ş': 'SH', 'ț': 'TS', 'ţ': 'TS',
    ...FIVE_VOWELS,
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'ZH', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', r: 'DX', s: 'S', t: 'T', v: 'V', x: 'K S', z: 'Z', y: 'IY', w: 'V',
  }),
]

/* ------------------------------------------------------------------ Czech --- */

const CZECH: SoundRule[] = [
  ...letters({
    ch: 'X', 'č': 'CH', 'ď': 'JH', 'ě': 'Y EH', 'ň': 'NY', 'ř': 'ZH',
    'š': 'SH', 'ť': 'CH', 'ž': 'ZH', 'á': 'A', 'é': 'EH', 'í': 'IY',
    'ó': 'O', 'ú': 'UW', 'ů': 'UW', 'ý': 'IY',
    a: 'A', e: 'EH', i: 'IY', o: 'O', u: 'UW', y: 'IY',
    b: 'B', c: 'TS', d: 'D', f: 'F', g: 'G', h: 'GX', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'V', x: 'K S', z: 'Z',
  }),
]

/* ---------------------------------------------------------------- Swedish --- */

const SWEDISH: SoundRule[] = [
  ...letters({
    stj: 'CX', skj: 'CX', sj: 'CX', tj: 'CX', kj: 'CX', ng: 'NG',
    'å': 'O', 'ä': 'EH', 'ö': 'OE',
    a: 'A', e: 'E', i: 'IY', o: 'UW', u: 'UE', y: 'UE',
    b: 'B', c: 'S', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'V',
    x: 'K S', z: 'S',
  }),
  when('sk', 'CX', { next: 'eiyäö' }),
  when('k', 'CX', { next: 'eiyäö' }),
  when('g', 'Y', { next: 'eiyäö' }),
  when('rs', 'SH', {}),
]

/* ---------------------------------------------------------------- Finnish --- */

// Doubled letters are long rather than different, so the table needs no entries
// for them: the same phoneme twice is exactly what a long sound is.
const FINNISH: SoundRule[] = [
  ...letters({
    ng: 'NG',
    'ä': 'EH', 'ö': 'OE',
    a: 'A', e: 'E', i: 'IY', o: 'O', u: 'UW', y: 'UE',
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'V',
    x: 'K S', z: 'TS',
  }),
]

const FINNISH_DIPHTHONGS = diphthongSet([
  ['A', 'IY'], ['E', 'IY'], ['O', 'IY'], ['UW', 'IY'], ['UE', 'IY'],
  ['EH', 'IY'], ['OE', 'IY'], ['A', 'UW'], ['E', 'UW'], ['O', 'UW'],
  ['IY', 'UW'], ['E', 'UE'], ['EH', 'UE'], ['OE', 'UE'],
  ['IY', 'E'], ['UW', 'O'], ['UE', 'OE'],
])

/* ------------------------------------------------------------- Vietnamese --- */

const VIETNAMESE: SoundRule[] = [
  ...letters({
    ngh: 'NG', ng: 'NG', nh: 'NY', ch: 'CH', gh: 'G', gi: 'Z', kh: 'X',
    ph: 'F', th: 'T', tr: 'CH', qu: 'K W',
    'ă': 'A', 'â': 'AX', 'ê': 'E', 'ô': 'O', 'ơ': 'ER', 'ư': 'IX', 'đ': 'D',
    a: 'A', e: 'EH', i: 'IY', o: 'AO', u: 'UW', y: 'IY',
    b: 'B', c: 'K', d: 'Z', g: 'G', h: 'HH', k: 'K', l: 'L', m: 'M', n: 'N',
    p: 'P', r: 'DX', s: 'SH', t: 'T', v: 'V', x: 'S',
  }),
  // A word-initial y before another vowel is the consonant, not the vowel.
  when('y', 'Y', { at: 'start', next: 'aăâeêioôơuư' }),
]

/* ---------------------------------------------------------------- Tagalog --- */

const TAGALOG: SoundRule[] = [
  ...letters({
    ng: 'NG',
    ...FIVE_VOWELS,
    b: 'B', c: 'K', d: 'D', f: 'P', g: 'G', h: 'HH', j: 'HH', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'B', w: 'W',
    x: 'K S', y: 'Y', z: 'S',
  }),
]

/* ---------------------------------------------------------------- Swahili --- */

const SWAHILI: SoundRule[] = [
  ...letters({
    "ng'": 'NG', ng: 'NG', ny: 'NY', ch: 'CH', dh: 'DH', gh: 'GX', sh: 'SH', th: 'TH',
    ...FIVE_VOWELS,
    b: 'B', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'JH', k: 'K', l: 'L', m: 'M',
    n: 'N', p: 'P', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'W', y: 'Y', z: 'Z',
  }),
]

/* ------------------------------------------------------- generic fallback --- */

// Read the letters at face value with the five-vowel values that the large
// majority of the world's Latin orthographies use. It will not be right for
// every language, but it is never absurd, which is more than reading an
// unknown language as English manages.
const GENERIC_LATIN: SoundRule[] = [
  ...letters({
    ng: 'NG', ny: 'NY', ch: 'CH', sh: 'SH', th: 'TH', ph: 'F',
    ...FIVE_VOWELS,
    'á': 'A', 'à': 'A', 'â': 'A', 'ä': 'A', 'ã': 'A', 'å': 'O',
    'é': 'E', 'è': 'E', 'ê': 'E', 'ë': 'E',
    'í': 'IY', 'ì': 'IY', 'î': 'IY', 'ï': 'IY',
    'ó': 'O', 'ò': 'O', 'ô': 'O', 'ö': 'OE', 'õ': 'O',
    'ú': 'UW', 'ù': 'UW', 'û': 'UW', 'ü': 'UE', 'ñ': 'NY', 'ç': 'S',
    b: 'B', c: 'K', d: 'D', f: 'F', g: 'G', h: 'HH', j: 'Y', k: 'K', l: 'L',
    m: 'M', n: 'N', p: 'P', q: 'K', r: 'DX', s: 'S', t: 'T', v: 'V', w: 'W',
    x: 'K S', y: 'Y', z: 'Z',
  }),
  when('y', 'IY', { notNext: 'aeiou' }),
]

/* ---------------------------------------------------------------- profiles --- */

export const LATIN_PROFILES: LanguageProfile[] = [
  {
    id: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', script: 'latin',
    voiceTags: ['id-ID', 'id'], rules: INDONESIAN,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'ms', label: 'Malay', native: 'Bahasa Melayu', script: 'latin',
    voiceTags: ['ms-MY', 'ms', 'id-ID'], rules: INDONESIAN,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'es', label: 'Spanish', native: 'Español', script: 'latin',
    voiceTags: ['es-ES', 'es-MX', 'es'], rules: SPANISH,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'it', label: 'Italian', native: 'Italiano', script: 'latin',
    voiceTags: ['it-IT', 'it'], rules: ITALIAN,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'pt', label: 'Portuguese', native: 'Português', script: 'latin',
    voiceTags: ['pt-BR', 'pt-PT', 'pt'], rules: PORTUGUESE,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'fr', label: 'French', native: 'Français', script: 'latin',
    voiceTags: ['fr-FR', 'fr-CA', 'fr'], rules: FRENCH, exceptions: FRENCH_EXCEPTIONS,
    syllable: DEFAULT_SYLLABLE,
  },
  {
    id: 'de', label: 'German', native: 'Deutsch', script: 'latin',
    voiceTags: ['de-DE', 'de'], rules: GERMAN, syllable: { maxOnset: 3 },
  },
  {
    id: 'nl', label: 'Dutch', native: 'Nederlands', script: 'latin',
    voiceTags: ['nl-NL', 'nl'], rules: DUTCH, syllable: { maxOnset: 3 },
  },
  {
    id: 'tr', label: 'Turkish', native: 'Türkçe', script: 'latin',
    voiceTags: ['tr-TR', 'tr'], rules: TURKISH, syllable: { maxOnset: 1, hiatus: true },
  },
  {
    id: 'pl', label: 'Polish', native: 'Polski', script: 'latin',
    voiceTags: ['pl-PL', 'pl'], rules: POLISH, syllable: { maxOnset: 3, hiatus: true },
  },
  {
    id: 'ro', label: 'Romanian', native: 'Română', script: 'latin',
    voiceTags: ['ro-RO', 'ro'], rules: ROMANIAN,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'cs', label: 'Czech', native: 'Čeština', script: 'latin',
    voiceTags: ['cs-CZ', 'cs'], rules: CZECH, syllable: { maxOnset: 3, hiatus: true },
  },
  {
    id: 'sv', label: 'Swedish', native: 'Svenska', script: 'latin',
    voiceTags: ['sv-SE', 'sv'], rules: SWEDISH, syllable: { maxOnset: 3 },
  },
  {
    id: 'fi', label: 'Finnish', native: 'Suomi', script: 'latin',
    voiceTags: ['fi-FI', 'fi'], rules: FINNISH,
    syllable: { maxOnset: 1, diphthongs: FINNISH_DIPHTHONGS },
  },
  {
    id: 'vi', label: 'Vietnamese', native: 'Tiếng Việt', script: 'latin',
    voiceTags: ['vi-VN', 'vi'], rules: VIETNAMESE,
    oneSyllable: true,
    // Tone marks are stripped; the vowel letters they sit on are not.
    normalize: (word) => word.normalize('NFD').replace(/[̣̀́̃̉]/g, '').normalize('NFC'),
  },
  {
    id: 'tl', label: 'Tagalog', native: 'Tagalog', script: 'latin',
    voiceTags: ['fil-PH', 'tl-PH', 'tl'], rules: TAGALOG,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
  {
    id: 'sw', label: 'Swahili', native: 'Kiswahili', script: 'latin',
    voiceTags: ['sw-KE', 'sw-TZ', 'sw'], rules: SWAHILI,
    syllable: { maxOnset: 2, hiatus: true },
  },
  {
    id: 'latn', label: 'Other (Latin script)', native: 'Latin', script: 'latin',
    voiceTags: [], rules: GENERIC_LATIN,
    syllable: { maxOnset: 2, diphthongs: FIVE_VOWEL_DIPHTHONGS },
  },
]
