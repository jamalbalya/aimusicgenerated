/**
 * Lyric vocabulary and line templates.
 *
 * Every slot is typed, and every line's final word carries a part-of-speech
 * tag that must match the template's ending. That is what keeps generated
 * lines grammatical: the rhyme is chosen first, then a template that can
 * actually end on that kind of word.
 */

export type ImageFamily =
  | 'night' | 'city' | 'ocean' | 'fire' | 'road' | 'heart' | 'light'
  | 'storm' | 'home' | 'gold' | 'ghost' | 'season' | 'sky' | 'machine'

export interface WordBank {
  /** Singular countable nouns, usable after "the" or "a". */
  nouns: string[]
  /** Bare-form intransitive verbs of motion or change. */
  motionVerbs: string[]
  /** Bare-form verbs of feeling or thought, transitive-friendly. */
  feelVerbs: string[]
  /** Attributive adjectives — must read correctly before a noun. */
  adjectives: string[]
  /** Bare noun phrases used after "the"/"this"; no article of their own. */
  places: string[]
}

export const FAMILY_WORDS: Record<ImageFamily, WordBank> = {
  night: {
    nouns: ['midnight', 'shadow', 'moon', 'silence', 'dream', 'candle', 'whisper', 'star', 'streetlight'],
    motionVerbs: ['fade', 'drift', 'wander', 'linger', 'sink', 'disappear'],
    feelVerbs: ['dream', 'remember', 'forget', 'imagine', 'miss'],
    adjectives: ['quiet', 'restless', 'endless', 'silver', 'sleepless', 'faded', 'hollow'],
    places: ['dark', 'rooftop', 'empty room', 'back seat', 'quiet hours'],
  },
  city: {
    nouns: ['neon', 'sidewalk', 'skyline', 'stranger', 'window', 'siren', 'corner', 'crowd', 'taxi'],
    motionVerbs: ['run', 'chase', 'escape', 'circle', 'climb', 'leave', 'arrive'],
    feelVerbs: ['notice', 'follow', 'trust', 'recognise', 'want'],
    adjectives: ['crowded', 'restless', 'electric', 'cold', 'bright', 'wired', 'sleepless'],
    places: ['avenue', 'city lights', 'last train', 'seventh floor', 'subway'],
  },
  ocean: {
    nouns: ['ocean', 'tide', 'harbour', 'anchor', 'current', 'shoreline', 'wave', 'horizon', 'lighthouse'],
    motionVerbs: ['drown', 'float', 'sink', 'swim', 'drift', 'break'],
    feelVerbs: ['carry', 'hold', 'need', 'reach', 'forget'],
    adjectives: ['deep', 'endless', 'restless', 'heavy', 'distant', 'open', 'salt'],
    places: ['shoreline', 'harbour', 'open water', 'far side', 'deep end'],
  },
  fire: {
    nouns: ['fire', 'ember', 'smoke', 'flame', 'spark', 'thunder', 'fever', 'lightning', 'match'],
    motionVerbs: ['burn', 'ignite', 'blaze', 'rise', 'explode', 'flicker'],
    feelVerbs: ['consume', 'want', 'crave', 'need', 'destroy'],
    adjectives: ['burning', 'reckless', 'wild', 'blinding', 'furious', 'golden', 'raw'],
    places: ['wildfire', 'burning field', 'ashes', 'middle of the storm'],
  },
  road: {
    nouns: ['highway', 'engine', 'mile', 'suitcase', 'headlight', 'crossroad', 'distance', 'journey'],
    motionVerbs: ['drive', 'leave', 'return', 'travel', 'wander', 'arrive', 'run'],
    feelVerbs: ['follow', 'outrun', 'remember', 'chase', 'lose'],
    adjectives: ['open', 'lonely', 'winding', 'restless', 'dusty', 'endless'],
    places: ['open road', 'county line', 'last exit', 'other side', 'interstate'],
  },
  heart: {
    nouns: ['heart', 'promise', 'lover', 'letter', 'memory', 'reason', 'apology', 'chance', 'name'],
    motionVerbs: ['break', 'fall', 'return', 'stay', 'leave'],
    feelVerbs: ['hold', 'forgive', 'remember', 'need', 'lose', 'keep', 'believe', 'miss'],
    adjectives: ['honest', 'broken', 'tender', 'foolish', 'certain', 'quiet', 'careless'],
    places: ['kitchen floor', 'doorway', 'space between us', 'other room'],
  },
  light: {
    nouns: ['sunrise', 'morning', 'colour', 'daylight', 'reflection', 'window', 'mirror', 'dawn'],
    motionVerbs: ['shine', 'rise', 'glow', 'wake', 'open', 'begin', 'return'],
    feelVerbs: ['reveal', 'lift', 'promise', 'remember', 'forgive'],
    adjectives: ['golden', 'bright', 'clear', 'warm', 'gentle', 'soft'],
    places: ['morning', 'front porch', 'open window', 'first light'],
  },
  storm: {
    nouns: ['storm', 'thunder', 'rain', 'hurricane', 'warning', 'weather', 'flood', 'wind', 'cloud'],
    motionVerbs: ['break', 'crash', 'gather', 'shake', 'fall', 'roll'],
    feelVerbs: ['survive', 'weather', 'hold', 'brace', 'fear'],
    adjectives: ['heavy', 'violent', 'grey', 'relentless', 'thundering', 'cold'],
    places: ['flooded street', 'shelter', 'aftermath', 'low ground'],
  },
  home: {
    nouns: ['home', 'kitchen', 'hallway', 'photograph', 'garden', 'doorway', 'table', 'childhood', 'blanket'],
    motionVerbs: ['stay', 'return', 'settle', 'grow', 'gather', 'rest', 'belong'],
    feelVerbs: ['build', 'keep', 'remember', 'forgive', 'need'],
    adjectives: ['familiar', 'safe', 'worn', 'quiet', 'small', 'warm', 'old'],
    places: ['old house', 'front room', 'driveway', 'same town'],
  },
  gold: {
    nouns: ['diamond', 'crown', 'fortune', 'trophy', 'ceiling', 'empire', 'chain', 'ticket', 'record'],
    motionVerbs: ['rise', 'climb', 'run', 'arrive', 'shine'],
    feelVerbs: ['earn', 'spend', 'win', 'count', 'claim', 'own', 'want'],
    adjectives: ['golden', 'expensive', 'flawless', 'hungry', 'certain', 'untouchable'],
    places: ['penthouse', 'front row', 'top floor', 'winners circle'],
  },
  ghost: {
    nouns: ['ghost', 'echo', 'stranger', 'silhouette', 'nightmare', 'secret', 'illusion', 'mirror', 'static'],
    motionVerbs: ['vanish', 'disappear', 'linger', 'return', 'drift'],
    feelVerbs: ['haunt', 'follow', 'whisper', 'forget', 'recognise'],
    adjectives: ['hollow', 'invisible', 'haunted', 'pale', 'forgotten', 'strange'],
    places: ['empty house', 'other side', 'back of my mind', 'rear-view'],
  },
  season: {
    nouns: ['summer', 'winter', 'autumn', 'season', 'harvest', 'snowfall', 'sunset', 'calendar'],
    motionVerbs: ['change', 'pass', 'return', 'grow', 'fade', 'bloom', 'end', 'begin'],
    feelVerbs: ['remember', 'miss', 'count', 'waste', 'keep'],
    adjectives: ['golden', 'endless', 'brief', 'perfect', 'cold', 'green', 'late'],
    places: ['long winter', 'good years', 'same summer', 'off season'],
  },
  sky: {
    nouns: ['sky', 'satellite', 'gravity', 'orbit', 'galaxy', 'comet', 'universe', 'cloud'],
    motionVerbs: ['rise', 'float', 'orbit', 'fall', 'fly', 'ascend', 'drift'],
    feelVerbs: ['reach', 'escape', 'imagine', 'chase', 'measure'],
    adjectives: ['weightless', 'infinite', 'distant', 'higher', 'open', 'cosmic'],
    places: ['atmosphere', 'upper air', 'far side of the moon', 'orbit'],
  },
  machine: {
    nouns: ['machine', 'circuit', 'signal', 'system', 'engine', 'frequency', 'wire', 'screen', 'code'],
    motionVerbs: ['run', 'reboot', 'restart', 'shut down', 'fail'],
    feelVerbs: ['process', 'rewire', 'transmit', 'calculate', 'override'],
    adjectives: ['digital', 'automatic', 'synthetic', 'cold', 'perfect', 'broken'],
    places: ['network', 'machine', 'other channel', 'feed'],
  },
}

/** Shared vocabulary available to every family. */
export const COMMON: WordBank = {
  nouns: ['truth', 'reason', 'silence', 'answer', 'question', 'story', 'moment', 'feeling', 'voice', 'sign', 'song'],
  motionVerbs: ['go', 'stay', 'run', 'fall', 'change', 'wait', 'move on', 'hold on', 'let go'],
  feelVerbs: ['know', 'feel', 'find', 'lose', 'hold', 'believe', 'remember', 'need', 'want'],
  adjectives: ['young', 'tired', 'lost', 'strange', 'quiet', 'honest', 'careless', 'ordinary'],
  places: ['start', 'same place', 'quiet part', 'other room'],
}

export type EndPos = 'noun' | 'verb' | 'adj' | 'adv'

export interface RhymeWord {
  word: string
  /** Every part of speech this word can serve as at the end of a line. */
  pos: EndPos[]
}

/**
 * Rhyme lexicon. Words carry every part of speech they can fill so a single
 * rhyme group can serve templates that end on a noun and templates that end on
 * a verb.
 */
export const RHYME_WORDS: RhymeWord[] = [
  // "-ay"
  { word: 'away', pos: ['adv'] }, { word: 'stay', pos: ['verb'] }, { word: 'say', pos: ['verb'] },
  { word: 'day', pos: ['noun'] }, { word: 'way', pos: ['noun'] }, { word: 'grey', pos: ['adj'] },
  { word: 'play', pos: ['verb'] }, { word: 'delay', pos: ['noun'] }, { word: 'escape', pos: ['noun', 'verb'] },
  { word: 'today', pos: ['adv'] },
  // "-ight"
  { word: 'night', pos: ['noun'] }, { word: 'light', pos: ['noun'] }, { word: 'right', pos: ['adj'] },
  { word: 'fight', pos: ['noun', 'verb'] }, { word: 'bright', pos: ['adj'] }, { word: 'sight', pos: ['noun'] },
  { word: 'flight', pos: ['noun'] }, { word: 'ignite', pos: ['verb'] }, { word: 'tonight', pos: ['adv'] },
  // long "o"
  { word: 'go', pos: ['verb'] }, { word: 'slow', pos: ['adj'] }, { word: 'know', pos: ['verb'] },
  { word: 'low', pos: ['adj'] }, { word: 'glow', pos: ['noun', 'verb'] }, { word: 'shadow', pos: ['noun'] },
  { word: 'window', pos: ['noun'] }, { word: 'echo', pos: ['noun', 'verb'] }, { word: 'tomorrow', pos: ['adv'] },
  // "-ime" / "-ine"
  { word: 'time', pos: ['noun'] }, { word: 'climb', pos: ['verb'] },
  { word: 'line', pos: ['noun'] }, { word: 'shine', pos: ['verb'] }, { word: 'fine', pos: ['adj'] },
  { word: 'divine', pos: ['adj'] }, { word: 'design', pos: ['noun'] }, { word: 'sign', pos: ['noun'] },
  // "-art" / "-ark"
  { word: 'heart', pos: ['noun'] }, { word: 'apart', pos: ['adv'] }, { word: 'start', pos: ['noun', 'verb'] },
  { word: 'part', pos: ['noun'] }, { word: 'dark', pos: ['adj'] }, { word: 'spark', pos: ['noun', 'verb'] },
  { word: 'mark', pos: ['noun'] },
  // "-ain" / "-ame"
  { word: 'rain', pos: ['noun'] }, { word: 'again', pos: ['adv'] }, { word: 'pain', pos: ['noun'] },
  { word: 'chain', pos: ['noun'] }, { word: 'remain', pos: ['verb'] }, { word: 'explain', pos: ['verb'] },
  { word: 'train', pos: ['noun'] }, { word: 'name', pos: ['noun'] }, { word: 'flame', pos: ['noun'] },
  // long "e"
  { word: 'free', pos: ['adj'] }, { word: 'sea', pos: ['noun'] }, { word: 'believe', pos: ['verb'] },
  { word: 'leave', pos: ['verb'] }, { word: 'breathe', pos: ['verb'] }, { word: 'need', pos: ['noun'] },
  { word: 'speed', pos: ['noun'] }, { word: 'street', pos: ['noun'] }, { word: 'complete', pos: ['adj'] },
  // "-old" / "-ole"
  { word: 'gold', pos: ['noun'] }, { word: 'hold', pos: ['verb'] }, { word: 'cold', pos: ['adj'] },
  { word: 'old', pos: ['adj'] }, { word: 'bold', pos: ['adj'] },
  { word: 'soul', pos: ['noun'] }, { word: 'whole', pos: ['adj'] }, { word: 'control', pos: ['noun'] },
  // "-own" / "-ound"
  { word: 'down', pos: ['adv'] }, { word: 'town', pos: ['noun'] }, { word: 'crown', pos: ['noun'] },
  { word: 'around', pos: ['adv'] }, { word: 'sound', pos: ['noun'] }, { word: 'ground', pos: ['noun'] },
  { word: 'drown', pos: ['verb'] },
  // "-ire"
  { word: 'fire', pos: ['noun'] }, { word: 'higher', pos: ['adv', 'adj'] }, { word: 'desire', pos: ['noun'] },
  { word: 'wire', pos: ['noun'] }, { word: 'tired', pos: ['adj'] },
  // "-end"
  { word: 'end', pos: ['noun'] }, { word: 'friend', pos: ['noun'] }, { word: 'defend', pos: ['verb'] },
  { word: 'pretend', pos: ['verb'] }, { word: 'bend', pos: ['verb'] }, { word: 'send', pos: ['verb'] },
  // "-er"
  { word: 'over', pos: ['adv'] }, { word: 'closer', pos: ['adv', 'adj'] }, { word: 'colder', pos: ['adj'] },
  { word: 'older', pos: ['adj'] }, { word: 'shoulder', pos: ['noun'] }, { word: 'remember', pos: ['verb'] },
  { word: 'forever', pos: ['adv'] }, { word: 'together', pos: ['adv'] },
  { word: 'weather', pos: ['noun'] }, { word: 'water', pos: ['noun'] }, { word: 'answer', pos: ['noun'] },
  { word: 'harder', pos: ['adj'] }, { word: 'stronger', pos: ['adj'] }, { word: 'longer', pos: ['adj'] },
  { word: 'louder', pos: ['adj'] },
  // "-ies"
  { word: 'eyes', pos: ['noun'] }, { word: 'lies', pos: ['noun'] }, { word: 'skies', pos: ['noun'] },
  { word: 'rise', pos: ['verb'] }, { word: 'goodbyes', pos: ['noun'] }, { word: 'disguise', pos: ['noun'] },
  { word: 'realise', pos: ['verb'] },
  // "-ove" / "-uch"
  { word: 'love', pos: ['noun'] }, { word: 'above', pos: ['adv'] }, { word: 'enough', pos: ['adj'] },
  { word: 'rough', pos: ['adj'] }, { word: 'touch', pos: ['noun', 'verb'] },
  // "-son" / "-tion"
  { word: 'reason', pos: ['noun'] }, { word: 'season', pos: ['noun'] }, { word: 'ocean', pos: ['noun'] },
  { word: 'motion', pos: ['noun'] }, { word: 'devotion', pos: ['noun'] },
  // "-un" / "-on"
  { word: 'run', pos: ['verb'] }, { word: 'one', pos: ['noun'] }, { word: 'done', pos: ['adj'] },
  { word: 'sun', pos: ['noun'] }, { word: 'young', pos: ['adj'] }, { word: 'gone', pos: ['adj'] },
  { word: 'dawn', pos: ['noun'] },
  // "-ome" / "-oam"
  { word: 'home', pos: ['adv'] }, { word: 'alone', pos: ['adj'] }, { word: 'unknown', pos: ['adj'] },
  { word: 'stone', pos: ['noun'] }, { word: 'bone', pos: ['noun'] }, { word: 'thrown', pos: ['adj'] },
  // "-ack"
  { word: 'back', pos: ['adv'] }, { word: 'track', pos: ['noun'] }, { word: 'crack', pos: ['noun'] },
]

export interface Template {
  /** Text with %END marking the rhyming final word. */
  text: string
  /** Part of speech the final word must be. */
  end: EndPos
}

/**
 * Slots: {noun} {nouns} {adj} {vMove} {vMoveIng} {vMoves} {vFeel} {place}
 */
export const VERSE_TEMPLATES: Template[] = [
  { text: 'I was standing in the {place} when it turned %END', end: 'adj' },
  { text: 'We were {adj} and we never learned to %END', end: 'verb' },
  { text: 'Every {noun} in the {place} is the %END', end: 'noun' },
  { text: 'You said the {noun} would {vMove} but it stayed %END', end: 'adj' },
  { text: 'There is nothing left in the {place} but the %END', end: 'noun' },
  { text: 'I keep the {adj} {noun} where I can {vFeel} the %END', end: 'noun' },
  { text: 'And the {nouns} kept {vMoveIng} into the %END', end: 'noun' },
  { text: 'Nobody told me how it feels to %END', end: 'verb' },
  { text: 'So I {vMove} through the {place} and I {vFeel} the %END', end: 'noun' },
  { text: 'Half of me is still out there in the %END', end: 'noun' },
  { text: 'Count the {nouns} on the {place} until they %END', end: 'verb' },
  { text: 'It took a {adj} {noun} to make me %END', end: 'adj' },
  { text: 'I do not need a {noun} to tell me where to %END', end: 'verb' },
  { text: 'You can hear the {noun} in the way I %END', end: 'verb' },
  { text: 'Somewhere past the {place} there is a %END', end: 'noun' },
  { text: 'The {noun} goes quiet and the {noun} starts to %END', end: 'verb' },
  { text: 'I have been {vMoveIng} since the {noun} went %END', end: 'adj' },
  { text: 'Tell me that the {adj} {noun} was worth the %END', end: 'noun' },
  { text: 'Every time I close my eyes I see the %END', end: 'noun' },
  { text: 'We built a {noun} out of {adj} %END', end: 'noun' },
  { text: 'Nothing in this town is ever going to %END', end: 'verb' },
  { text: 'I traded all my {nouns} for one more %END', end: 'noun' },
  { text: 'The {adj} {noun} taught me how to %END', end: 'verb' },
  { text: 'Been {vMoveIng} on the {noun} like I could %END', end: 'verb' },
  { text: 'She left a {noun} in the {place} and it is still %END', end: 'adj' },
  { text: 'All the {nouns} in the {place} are getting %END', end: 'adj' },
  { text: 'And we keep coming %END', end: 'adv' },
  { text: 'I hear the {noun} calling and it pulls me %END', end: 'adv' },
]

export const CHORUS_TEMPLATES: Template[] = [
  { text: 'We {vMove} until the {noun} is %END', end: 'adj' },
  { text: 'Take me where the {nouns} %END', end: 'verb' },
  { text: 'I will not {vMove} tonight, I will %END', end: 'verb' },
  { text: 'Hold on, we are almost %END', end: 'adj' },
  { text: 'This is how we {vMove} in the %END', end: 'noun' },
  { text: 'Nothing burns forever, nothing stays %END', end: 'adj' },
  { text: 'And I feel it in the {noun}, I feel the %END', end: 'noun' },
  { text: 'Say my name until the {nouns} %END', end: 'verb' },
  { text: 'Run with me, we do not have to %END', end: 'verb' },
  { text: 'All of it comes back to the %END', end: 'noun' },
  { text: 'Let the {adj} {noun} take me %END', end: 'adv' },
  { text: 'Oh, we are {adj} and we are %END', end: 'adj' },
  { text: 'Keep the {noun} burning while we %END', end: 'verb' },
  { text: 'I would give it all to see you %END', end: 'verb' },
  { text: 'Every {noun} that I lost is coming %END', end: 'adv' },
  { text: 'We are the {nouns} and we are %END', end: 'adj' },
  { text: 'Carry me over the {noun} and the %END', end: 'noun' },
]

export const BRIDGE_TEMPLATES: Template[] = [
  { text: 'Maybe I was never meant to %END', end: 'verb' },
  { text: 'What if none of it was ever %END', end: 'adj' },
  { text: 'Tell me one more time before we %END', end: 'verb' },
  { text: 'I let the {adj} {noun} go and now I %END', end: 'verb' },
  { text: 'Everything I ran from is the %END', end: 'noun' },
  { text: 'And if the {noun} never {vMoves} again, I %END', end: 'verb' },
  { text: 'I have been holding on so long, and it is %END', end: 'adj' },
  { text: 'Turn the {noun} around and take it %END', end: 'adv' },
]

export const RAP_TEMPLATES: Template[] = [
  { text: 'Came up out the {place} with a {adj} {noun} and a %END', end: 'noun' },
  { text: 'They was counting me out, now they counting on the %END', end: 'noun' },
  { text: 'Every {noun} that I {vFeel} got a story and a %END', end: 'noun' },
  { text: 'Put the {adj} {noun} on the table, watch it %END', end: 'verb' },
  { text: 'No sleep in the {place}, still chasing after the %END', end: 'noun' },
  { text: 'I been moving through the {place} like I never had to %END', end: 'verb' },
  { text: 'Talk is {adj}, but the {noun} never had to %END', end: 'verb' },
  { text: 'Told my people we go up and we never going %END', end: 'adv' },
  { text: 'Turn the {adj} {noun} to a {noun}, watch the %END', end: 'noun' },
  { text: 'Same face in the {noun}, different {noun}, same %END', end: 'noun' },
  { text: 'They want the {noun} but they never want the %END', end: 'noun' },
  { text: 'I do not {vFeel} the {nouns}, I just {vFeel} the %END', end: 'noun' },
  { text: 'Started from the {place}, now the whole thing %END', end: 'verb' },
  { text: 'Keep it {adj} while the rest of them go %END', end: 'adv' },
]

export const OPENER_TEMPLATES: Template[] = [
  { text: 'This one is for the {nouns} and the %END', end: 'noun' },
  { text: 'It started with a {adj} {noun} and a %END', end: 'noun' },
  { text: 'There was a {noun} in the {place} that would not %END', end: 'verb' },
]
