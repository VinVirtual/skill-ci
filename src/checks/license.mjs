// LICENSE: present, recognisable, no template placeholders, and in agreement with package.json.
import { finding } from '../lib/context.mjs'

const LICENSE_RE = /^(licen[cs]e|copying|unlicense)(\.(md|txt|rst))?$/i

const SIGNATURES = [
  ['MIT', /Permission is hereby granted, free of charge/i],
  ['Apache-2.0', /Apache License[\s\S]{0,80}Version 2\.0/i],
  ['GPL-3.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i],
  ['GPL-2.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 2/i],
  ['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE/i],
  ['LGPL-3.0', /GNU LESSER GENERAL PUBLIC LICENSE/i],
  ['MPL-2.0', /Mozilla Public License,? (Version|v\.?) ?2\.0/i],
  ['ISC', /Permission to use, copy, modify, and\/or distribute this software/i],
  ['BSD-3-Clause', /Redistribution and use in source and binary forms[\s\S]*Neither the name/i],
  ['BSD-2-Clause', /Redistribution and use in source and binary forms/i],
  ['Unlicense', /This is free and unencumbered software released into the public domain/i],
  ['CC0-1.0', /CC0 1\.0 Universal/i],
]

const PLACEHOLDERS = /\[(year|yyyy|fullname|full name|name of copyright owner|copyright holders?)\]|<(year|copyright holders?|name of author|owner)>|\{\{?\s*(year|yyyy|fullname|author)\s*\}?\}|\byyyy\b/i

export const findLicense = (files) => files.find((f) => !f.includes('/') && LICENSE_RE.test(f)) ?? null

/** SPDX id of a licence text, or null. */
export function detectLicense(text) {
  for (const [id, re] of SIGNATURES) if (re.test(text)) return id
  return null
}

export function lintLicense(text, { file = 'LICENSE', packageJson = null } = {}) {
  const out = []
  const add = (rule, level, message, extra = {}) => out.push(finding(`license/${rule}`, level, message, { file, ...extra }))
  if (text.trim() === '') { add('empty', 'error', 'LICENSE is empty.'); return { findings: out, spdx: null } }
  const spdx = detectLicense(text)
  if (!spdx) add('unrecognised', 'notice', 'The licence text is not one skill-ci recognises; make sure it is a real open-source licence.')
  const ph = text.match(PLACEHOLDERS)
  if (ph) add('placeholder', 'warning', `The licence still has a template placeholder: "${ph[0]}".`, { line: text.slice(0, ph.index).split('\n').length })
  if ((spdx === 'MIT' || spdx?.startsWith('BSD') || spdx === 'ISC') && !/copyright\s+(\(c\)\s*|©\s*)?\d{4}/i.test(text)) add('no-copyright', 'warning', `An ${spdx} licence needs a "Copyright (c) <year> <name>" line.`)
  if (packageJson) {
    let pkg = null
    try { pkg = JSON.parse(packageJson) } catch { /* the install check reports broken package.json */ }
    const declared = pkg && typeof pkg.license === 'string' ? pkg.license : null
    if (declared && spdx && !declared.toUpperCase().startsWith(spdx.toUpperCase().replace(/-\d.*$/, ''))) add('package-mismatch', 'warning', `package.json says "${declared}" but LICENSE reads as ${spdx}.`, { file: 'package.json' })
  }
  return { findings: out, spdx }
}

export function checkLicense(ctx) {
  const file = findLicense(ctx.files)
  if (!file) return { findings: [finding('license/missing', 'error', 'No LICENSE file at the repository root; without one nobody may legally reuse the skill.', { file: 'LICENSE', hint: 'Add a LICENSE file (MIT is common for skills).' })], note: 'missing' }
  const text = ctx.read(file)
  if (text === null) return { findings: [finding('license/unreadable', 'error', `${file} could not be read as text.`, { file })] }
  const res = lintLicense(text, { file, packageJson: ctx.exists('package.json') ? ctx.read('package.json') : null })
  return { findings: res.findings, note: res.spdx ?? 'unrecognised' }
}
