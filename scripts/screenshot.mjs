#!/usr/bin/env node
// Screenshots an HTML page (a rendered summary) to PNG with headless Chrome via playwright-core.
// Usage: node scripts/screenshot.mjs <in.html> <out.png> [width]
// Finds playwright-core in $PLAYWRIGHT_CORE, the local or global node_modules, and Chrome on PATH or Playwright's own.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function findChromium() {
  const require = createRequire(import.meta.url)
  let root = ''
  try { root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  const cands = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright', root && join(root, 'playwright-core'), root && join(root, 'playwright'),
    root && join(root, '@playwright/cli/node_modules/playwright-core'), root && join(root, '@playwright/test/node_modules/playwright-core')].filter(Boolean)
  for (const c of cands) { try { return require(c).chromium } catch {} }
  throw new Error('playwright-core not found: npm i -g playwright-core, or set PLAYWRIGHT_CORE=/path/to/playwright-core')
}

export async function screenshot(input, output, { width = 1060, scale = 1.5 } = {}) {
  const chromium = findChromium()
  const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: scale, colorScheme: 'light' })
    await page.goto(pathToFileURL(resolve(input)).href)
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))
    await page.locator('main').screenshot({ path: output })
  } finally { await browser.close() }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('screenshot.mjs')) {
  const [input, output, width] = process.argv.slice(2)
  if (!input || !output) { console.error('usage: node scripts/screenshot.mjs <in.html> <out.png> [width]'); process.exit(2) }
  screenshot(input, output, { width: width ? Number(width) : undefined }).catch((e) => { console.error(e.message); process.exit(1) })
}
