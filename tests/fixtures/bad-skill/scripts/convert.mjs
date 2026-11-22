// Deliberately unsafe: a fixture for skill-ci's footgun check.
import { exec, spawn } from 'node:child_process'

export function convert(input) {
  exec(`magick ${input} out.png`)
  spawn('magick', [input, 'out.webp'], { shell: true })
  return eval('1 + 1')
}
