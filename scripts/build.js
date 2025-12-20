import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true })
}
fs.mkdirSync(distDir)

const pluginsSrc = path.join(rootDir, 'plugins')
const pluginsDest = path.join(distDir, 'plugins')
if (fs.existsSync(pluginsSrc)) {
  fs.cpSync(pluginsSrc, pluginsDest, { recursive: true })
}

console.log('Generating registry...')
execSync('node scripts/generate-registry.js', {
  cwd: rootDir,
  stdio: 'inherit'
})

console.log('Bundling with esbuild...')
await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(distDir, 'main.mjs'),
  external: ['@performanc/voice', 'bufferutil', 'utf-8-validate'],
  format: 'esm',
  keepNames: true,
  banner: {
    js: `import { createRequire as _createRequire } from 'module'; const require = _createRequire(import.meta.url);`
  }
})

console.log('Generating SEA blob...')
execSync('node --experimental-sea-config sea-config.json', {
  cwd: rootDir,
  stdio: 'inherit'
})

console.log('Creating executable...')
const nodeExe = process.env.TARGET_NODE_EXE || process.execPath
console.log(`Using base Node.js binary: ${nodeExe}`)

const isWin = process.platform === 'win32'
const outputName = isWin ? 'nodelink.exe' : 'nodelink'
const destExe = path.join(distDir, outputName)

fs.copyFileSync(nodeExe, destExe)

const postjectPath = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'postject.cmd' : 'postject'
)

const blobPath = path.join(distDir, 'app.blob')

execSync(
  `"${postjectPath}" "${destExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: 'inherit' }
)

if (process.platform === 'win32') {
  console.log('Adding icon...')
  const rceditPath = path.join(rootDir, 'node_modules', 'rcedit', 'bin', 'rcedit.exe')
  const iconPath = path.join(rootDir, 'assets', 'icon.ico')

  if (fs.existsSync(rceditPath) && fs.existsSync(iconPath)) {
    try {
      execSync(`"${rceditPath}" "${destExe}" --set-icon "${iconPath}"`, {
        stdio: 'inherit'
      })
      console.log('Icon added successfully!')
    } catch (e) {
      console.warn('Failed to add icon:', e.message)
    }
  } else {
    if (!fs.existsSync(iconPath)) console.warn('Icon file not found at assets/icon.ico')
    if (!fs.existsSync(rceditPath)) console.warn('rcedit not found. Skipping icon injection.')
  }
}

console.log(`Build complete: dist/${outputName}`)
