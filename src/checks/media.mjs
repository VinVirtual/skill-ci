// Size budget for committed media (images, video, audio, 3D, PDF) and a warning for any other very large file.
import { posix } from 'node:path'
import { finding } from '../lib/context.mjs'
import { fileSize } from '../lib/files.mjs'

export const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'ico', 'svg', 'psd',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'm4a', 'ogg', 'oga', 'flac', 'aac', 'opus',
  'glb', 'gltf', 'usdz', 'fbx', 'stl', 'obj', 'dae', 'blend', 'pdf', 'ttf', 'otf', 'woff', 'woff2'])
const MB = 1024 * 1024
export const LARGE_OTHER_BYTES = 10 * MB

export const isMedia = (file) => MEDIA_EXT.has(posix.extname(file).slice(1).toLowerCase())
export const formatMB = (bytes) => `${(bytes / MB).toFixed(bytes < MB / 10 ? 2 : 1)} MB`

/** Applies the budget to [{ file, bytes }]. -> { findings, total, media } */
export function budget(entries, { maxFileMB = 5, maxTotalMB = 15 } = {}) {
  const findings = []
  const media = entries.filter((e) => isMedia(e.file)).sort((a, b) => b.bytes - a.bytes)
  const total = media.reduce((s, e) => s + e.bytes, 0)
  for (const e of media) {
    if (e.bytes > maxFileMB * MB) findings.push(finding('media/file-too-large', 'error', `${formatMB(e.bytes)}, over the ${maxFileMB} MB per-file budget.`, { file: e.file, hint: 'Compress it (smaller resolution, lower bitrate, WebP/AVIF/H.264), or host it elsewhere and link to it.' }))
  }
  if (total > maxTotalMB * MB) findings.push(finding('media/total-too-large', 'error', `Committed media add up to ${formatMB(total)}, over the ${maxTotalMB} MB budget. Largest: ${media.slice(0, 3).map((e) => `${e.file} (${formatMB(e.bytes)})`).join(', ')}.`))
  else if (total > 0.8 * maxTotalMB * MB) findings.push(finding('media/total-near-budget', 'notice', `Committed media add up to ${formatMB(total)}, over 80% of the ${maxTotalMB} MB budget.`))
  for (const e of entries) {
    if (!isMedia(e.file) && e.bytes > LARGE_OTHER_BYTES) findings.push(finding('media/large-file', 'warning', `${formatMB(e.bytes)} non-media file; large files make every clone slow.`, { file: e.file }))
  }
  return { findings, total, media }
}

export function checkMedia(ctx) {
  // Only what git publishes counts; untracked files are not cloned by users.
  const files = ctx.files.filter((f) => ctx.tracked.has(f))
  const entries = files.map((file) => ({ file, bytes: fileSize(ctx.abs(file)) }))
  const res = budget(entries, { maxFileMB: ctx.config.media['max-file-mb'], maxTotalMB: ctx.config.media['max-total-mb'] })
  return {
    findings: res.findings.filter((f) => !ctx.disabled(f.rule)),
    note: `${res.media.length} media files, ${formatMB(res.total)} of ${ctx.config.media['max-total-mb']} MB`,
    details: { largest: res.media.slice(0, 5).map((e) => ({ file: e.file, size: formatMB(e.bytes) })) },
  }
}
