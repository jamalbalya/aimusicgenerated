/** Regular English inflection for the curated lyric verb list. */

const VOWELS = 'aeiou'

function endsWithCvc(word: string): boolean {
  if (word.length < 3) return false
  const [c1, v, c2] = [word[word.length - 3]!, word[word.length - 2]!, word[word.length - 1]!]
  return !VOWELS.includes(c1) && VOWELS.includes(v) && !VOWELS.includes(c2) && !'wxy'.includes(c2)
}

const IRREGULAR_ING: Record<string, string> = {
  be: 'being', see: 'seeing', flee: 'fleeing', lie: 'lying', die: 'dying', tie: 'tying',
  'let go': 'letting go', 'move on': 'moving on', 'hold on': 'holding on', 'give up': 'giving up',
  // Final-stress verbs double their consonant even though they are polysyllabic,
  // and -l doubles in British spelling, which the rest of the copy follows.
  begin: 'beginning', forget: 'forgetting', admit: 'admitting', occur: 'occurring',
  prefer: 'preferring', refer: 'referring', permit: 'permitting', submit: 'submitting',
  regret: 'regretting', commit: 'committing', compel: 'compelling', control: 'controlling',
  travel: 'travelling', cancel: 'cancelling', signal: 'signalling', unravel: 'unravelling',
}

const IRREGULAR_S: Record<string, string> = {
  be: 'is', have: 'has', do: 'does', go: 'goes',
  'let go': 'lets go', 'move on': 'moves on', 'hold on': 'holds on', 'give up': 'gives up',
}

/** Present participle: run -> running, make -> making, carry -> carrying. */
export function gerund(verb: string): string {
  const known = IRREGULAR_ING[verb]
  if (known) return known
  if (verb.includes(' ')) {
    const [head, ...rest] = verb.split(' ')
    return [gerund(head!), ...rest].join(' ')
  }
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`
  if (verb.endsWith('e') && !verb.endsWith('ee') && !verb.endsWith('ye') && !verb.endsWith('oe')) {
    return `${verb.slice(0, -1)}ing`
  }
  // Only single-syllable CVC verbs double the final consonant.
  const vowelGroups = verb.replace(/[^aeiou]+/g, ' ').trim().split(/\s+/).filter(Boolean).length
  if (vowelGroups === 1 && endsWithCvc(verb)) return `${verb}${verb[verb.length - 1]}ing`
  return `${verb}ing`
}

/** Third person singular: run -> runs, watch -> watches, carry -> carries. */
export function thirdPerson(verb: string): string {
  const known = IRREGULAR_S[verb]
  if (known) return known
  if (verb.includes(' ')) {
    const [head, ...rest] = verb.split(' ')
    return [thirdPerson(head!), ...rest].join(' ')
  }
  if (/(s|x|z|ch|sh)$/.test(verb)) return `${verb}es`
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ies`
  return `${verb}s`
}

/** Mass nouns that must never be pluralised. */
export const UNCOUNTABLE = new Set([
  'lightning', 'thunder', 'rain', 'smoke', 'silence', 'gold', 'water', 'weather',
  'daylight', 'darkness', 'sleep', 'static', 'code', 'gravity', 'music', 'snowfall',
  'traffic', 'salt', 'heat', 'money', 'love', 'truth', 'childhood', 'jewellery',
  'neon', 'concrete', 'furniture', 'advice', 'news', 'homework', 'luggage',
])

export function isCountable(noun: string): boolean {
  return !UNCOUNTABLE.has(noun.toLowerCase())
}

/** Plural of a countable noun. */
export function pluralize(noun: string): string {
  if (noun.includes(' ')) {
    const parts = noun.split(' ')
    parts[parts.length - 1] = pluralize(parts[parts.length - 1]!)
    return parts.join(' ')
  }
  const irregular: Record<string, string> = {
    person: 'people', child: 'children', man: 'men', woman: 'women',
    foot: 'feet', tooth: 'teeth', life: 'lives', knife: 'knives', leaf: 'leaves',
  }
  if (irregular[noun]) return irregular[noun]!
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

/** Chooses "a" or "an" for the following word. */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}
