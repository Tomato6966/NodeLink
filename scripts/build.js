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

execSync('node scripts/generate-registry.js', {
  cwd: rootDir,
  stdio: 'inherit'
})

const gitInfo = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const commitTime = Number.parseInt(execSync('git log -1 --format=%ct', { encoding: 'utf8' }).trim(), 10) * 1000
    return { branch, commit, commitTime }
  } catch (e) {
    return { branch: 'unknown', commit: 'unknown', commitTime: 0 }
  }
})();

await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(distDir, 'main.mjs'),
  external: ['bufferutil', 'utf-8-validate', '@toddynnn/symphonia-decoder', 'toddy-mediaplex'],
  format: 'esm',
  keepNames: true,
  loader: { '.node': 'file' },
  define: {
    '__BUILD_GIT_INFO__': JSON.stringify(gitInfo)
  },
  banner: {
    js: `import { createRequire as _createRequire } from 'module'; const require = _createRequire(import.meta.url);`
  }
})

const modulesToCopy = [
  { src: path.join(rootDir, 'node_modules', '@toddynnn', 'symphonia-decoder'), dest: path.join(distDir, 'node_modules', '@toddynnn', 'symphonia-decoder') },
  { src: path.join(rootDir, 'node_modules', 'toddy-mediaplex'), dest: path.join(distDir, 'node_modules', 'toddy-mediaplex') }
]

const toddyDir = path.join(rootDir, 'node_modules', '@toddynnn')
if (fs.existsSync(toddyDir)) {
  const packages = fs.readdirSync(toddyDir)
  for (const pkg of packages) {
    if (pkg.startsWith('symphonia-decoder-')) {
      modulesToCopy.push({ src: path.join(toddyDir, pkg), dest: path.join(distDir, 'node_modules', '@toddynnn', pkg) })
    }
  }
}

const rootModulesDir = path.join(rootDir, 'node_modules')
if (fs.existsSync(rootModulesDir)) {
  const packages = fs.readdirSync(rootModulesDir)
  for (const pkg of packages) {
    if (pkg.startsWith('mediaplex-')) {
      modulesToCopy.push({ src: path.join(rootModulesDir, pkg), dest: path.join(distDir, 'node_modules', pkg) })
    }
  }
}

for (const { src, dest } of modulesToCopy) {
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true })
  }
}

const symphoniaDest = path.join(distDir, 'node_modules', '@toddynnn', 'symphonia-decoder')
const symphoniaPkgDir = path.join(distDir, 'node_modules', '@toddynnn', 'symphonia-decoder-win32-x64-msvc')
if (fs.existsSync(symphoniaPkgDir)) {
  for (const binary of fs.readdirSync(symphoniaPkgDir).filter(f => f.endsWith('.node'))) {
    fs.copyFileSync(path.join(symphoniaPkgDir, binary), path.join(symphoniaDest, binary))
  }
}

const mediaplexDest = path.join(distDir, 'node_modules', 'toddy-mediaplex')
const mediaplexPkgDir = path.join(distDir, 'node_modules', 'mediaplex-win32-x64-msvc')
if (fs.existsSync(mediaplexPkgDir)) {
  for (const binary of fs.readdirSync(mediaplexPkgDir).filter(f => f.endsWith('.node'))) {
    fs.copyFileSync(path.join(mediaplexPkgDir, binary), path.join(mediaplexDest, binary))
  }
}

const filesToEmbed = {}
function scanDir(dir, base = '') {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file)
    const relativePath = path.join(base, file)
    if (file === 'nodelink.exe' || file === 'app.blob' || file === 'runner.js') continue
    if (fs.statSync(fullPath).isDirectory()) {
      scanDir(fullPath, relativePath)
    } else {
      filesToEmbed[relativePath.replace(/\\/g, '/')] = fs.readFileSync(fullPath).toString('base64')
    }
  }
}
scanDir(distDir)

const configDefaultBase64 = Buffer.from(fs.readFileSync(path.join(rootDir, 'config.default.js'), 'utf-8')).toString('base64')
let configBase64 = null
if (fs.existsSync(path.join(rootDir, 'config.js'))) {
  configBase64 = Buffer.from(fs.readFileSync(path.join(rootDir, 'config.js'), 'utf-8')).toString('base64')
}

const runnerCode = `
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const dns = require('dns');

try {
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {}

if (!process.env.NODELINK_RESTARTED) {
  const child = spawn(process.execPath, ['--openssl-legacy-provider', ...process.argv.slice(1)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODELINK_RESTARTED: '1' }
  });
  child.on('close', (code) => process.exit(code));
  return;
}

const baseDir = path.dirname(process.execPath);
const internalDir = path.join(baseDir, 'internal');
const mainPath = path.join(internalDir, 'main.mjs');
const configDefaultPath = path.join(baseDir, 'config.default.js');
const configPath = path.join(baseDir, 'config.js');
const embeddedFiles = ${JSON.stringify(filesToEmbed)};

try {
  if (!fs.existsSync(internalDir)) fs.mkdirSync(internalDir, { recursive: true });
  if (!fs.existsSync(path.join(baseDir, 'plugins'))) fs.mkdirSync(path.join(baseDir, 'plugins'), { recursive: true });
  if (!fs.existsSync(configDefaultPath)) {
    fs.writeFileSync(configDefaultPath, Buffer.from("${configDefaultBase64}", 'base64'));
  }
  if (${configBase64 ? 'true' : 'false'} && !fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, Buffer.from("${configBase64 || ''}", 'base64'));
  }
  for (const [filename, contentBase64] of Object.entries(embeddedFiles)) {
    const filePath = path.join(internalDir, filename);
    if (!fs.existsSync(path.dirname(filePath))) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, Buffer.from(contentBase64, 'base64'));
  }
  import(pathToFileURL(mainPath).href).catch(err => {
    console.error('[NodeLink] Failed to start application:', err);
    console.log('Press any key to exit...');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
  });
} catch (err) {
  console.error('[NodeLink] Bootstrap error:', err);
  console.log('Press any key to exit...');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', () => process.exit(1));
}
`
fs.writeFileSync(path.join(distDir, 'runner.js'), runnerCode)

fs.writeFileSync(path.join(rootDir, 'sea-config.json'), JSON.stringify({
  main: 'dist/runner.js',
  output: 'dist/app.blob',
  disableExperimentalSEAWarning: true
}, null, 2))

execSync('node --experimental-sea-config sea-config.json', { cwd: rootDir, stdio: 'inherit' })

const outputName = process.platform === 'win32' ? 'nodelink.exe' : 'nodelink'
const destExe = path.join(distDir, outputName)
fs.copyFileSync(process.execPath, destExe)

const postjectPath = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject')
execSync(`"${postjectPath}" "${destExe}" NODE_SEA_BLOB "dist/app.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { stdio: 'inherit' })
console.log('Build complete: ' + destExe)