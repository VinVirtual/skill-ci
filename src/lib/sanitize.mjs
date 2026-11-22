// Text that came from the repository (file names, values, test output) is hostile in CI: it can carry
// line breaks that start GitHub workflow commands (::set-env, ::add-mask), ANSI escapes and bidi overrides.

const ANSI = /\x1b(?:\[[0-?]{0,40}[ -/]{0,10}[@-~]|\][^\x07\x1b]{0,500}(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const CONTROL_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** One line of display text: escapes and every control character (line breaks included) become spaces. */
export function cleanLine(value) {
  return String(value ?? '').replace(ANSI, '').replace(CONTROL_LINE, ' ')
}

/** A block of display text (command output): keeps \n and \t, drops \r, escapes and other controls. */
export function cleanBlock(value) {
  return String(value ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL_BLOCK, '')
}

/** True when a file name holds a control character (a line break in a name breaks line-based outputs). */
export const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(String(s))
