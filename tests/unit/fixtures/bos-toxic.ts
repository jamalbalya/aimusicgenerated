/**
 * The fixed Bos Toxic case, used by every test that has to prove the request
 * reaches the neural engine unaltered.
 */

import { readFileSync } from 'node:fs'

export const BOS_TOXIC_STYLE =
  'Indonesian dangdut koplo, sarcastic workplace anthem, powerful kendang, groovy bass, ' +
  'funky guitar, dramatic male vocal, humorous verses, explosive sing-along chorus'

export const BOS_TOXIC_LYRICS = readFileSync(
  new URL('./bos-toxic-lyrics.txt', import.meta.url), 'utf8')
