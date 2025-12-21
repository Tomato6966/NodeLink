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

const gitInfo = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const commitTime = Number.parseInt(execSync('git log -1 --format=%ct', { encoding: 'utf8' }).trim(), 10) * 1000
    return { branch, commit, commitTime }
  } catch (e) {
    console.warn('Failed to retrieve git info:', e.message)
    return { branch: 'unknown', commit: 'unknown', commitTime: 0 }
  }
})();

console.log('Bundling with esbuild...')
await esbuild.build({
  entryPoints: [path.join(rootDir, 'src/index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(distDir, 'main.mjs'),
  external: ['bufferutil', 'utf-8-validate', '@toddynnn/symphonia-decoder'],
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

console.log('Copying native modules...')
const symphoniaSrc = path.join(rootDir, 'node_modules', '@toddynnn', 'symphonia-decoder')
const symphoniaDest = path.join(distDir, 'node_modules', '@toddynnn', 'symphonia-decoder')

if (fs.existsSync(symphoniaSrc)) {
  fs.mkdirSync(path.dirname(symphoniaDest), { recursive: true })
  fs.cpSync(symphoniaSrc, symphoniaDest, { recursive: true })
  
  const files = fs.readdirSync(symphoniaDest)
  for (const file of files) {
    if (file.endsWith('.node') && !file.includes('win32')) {
      fs.rmSync(path.join(symphoniaDest, file))
    }
  }

  const toddyDir = path.join(rootDir, 'node_modules', '@toddynnn')
  if (fs.existsSync(toddyDir)) {
    const packages = fs.readdirSync(toddyDir)
    for (const pkg of packages) {
      if (pkg.startsWith('symphonia-decoder-')) {
        const pkgDir = path.join(toddyDir, pkg)
        if (fs.statSync(pkgDir).isDirectory()) {
          const binaries = fs.readdirSync(pkgDir).filter(f => f.endsWith('.node'))
          for (const binary of binaries) {
            fs.copyFileSync(path.join(pkgDir, binary), path.join(symphoniaDest, binary))
          }
        }
      }
    }
  }
}

console.log('Preparing SEA runner (Self-Extracting Portable Logic)...')

const filesToEmbed = {}

function scanDir(dir, base = '') {
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const fullPath = path.join(dir, file)
    const relativePath = path.join(base, file)
    
    if (file === 'nodelink.exe' || file === 'app.blob' || file === 'runner.js') continue

    if (fs.statSync(fullPath).isDirectory()) {
      scanDir(fullPath, relativePath)
    } else {
      const content = fs.readFileSync(fullPath).toString('base64')
      filesToEmbed[relativePath.replace(/\\/g, '/')] = content
    }
  }
}

scanDir(distDir)

const configDefaultCode = fs.readFileSync(path.join(rootDir, 'config.default.js'), 'utf-8')
const configDefaultBase64 = Buffer.from(configDefaultCode).toString('base64')

let configBase64 = null
const configPath = path.join(rootDir, 'config.js')
if (fs.existsSync(configPath)) {
  const configCode = fs.readFileSync(configPath, 'utf-8')
  configBase64 = Buffer.from(configCode).toString('base64')
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
} catch (e) {
}

if (!process.env.NODELINK_RESTARTED) {
  const requiredFlags = ['--openssl-legacy-provider'];
  const args = [...requiredFlags, ...process.argv.slice(1)];
  
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODELINK_RESTARTED: '1' }
  });

  child.on('close', (code) => {
    process.exit(code);
  });

  return;
}

const baseDir = path.dirname(process.execPath);
const internalDir = path.join(baseDir, 'internal');
const pluginsDir = path.join(baseDir, 'plugins');
const mainPath = path.join(internalDir, 'main.mjs');
const configDefaultPath = path.join(baseDir, 'config.default.js');
const configPath = path.join(baseDir, 'config.js');

const embeddedFiles = ${JSON.stringify(filesToEmbed)};
const configBase64 = ${configBase64 ? `"${configBase64}"` : 'null'};

try {
  if (!fs.existsSync(internalDir)) {
    fs.mkdirSync(internalDir, { recursive: true });
  }
  
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  if (!fs.existsSync(configDefaultPath)) {
    const configContent = Buffer.from("${configDefaultBase64}", 'base64');
    fs.writeFileSync(configDefaultPath, configContent);
  }

  if (configBase64 && !fs.existsSync(configPath)) {
    const configContent = Buffer.from(configBase64, 'base64');
    fs.writeFileSync(configPath, configContent);
  }

  for (const [filename, contentBase64] of Object.entries(embeddedFiles)) {
    const filePath = path.join(internalDir, filename);
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(contentBase64, 'base64'));
    }
  }

  import(pathToFileURL(mainPath).href).catch(err => {
    console.error('[NodeLink] Failed to start application:', err);
    process.exit(1);
  });

} catch (err) {
  console.error('[NodeLink] Bootstrap error:', err);
  process.exit(1);
}
`
fs.writeFileSync(path.join(distDir, 'runner.js'), runnerCode)

console.log('Updating sea-config.json...')
const seaConfig = {
  main: 'dist/runner.js',
  output: 'dist/app.blob',
  disableExperimentalSEAWarning: true
}
fs.writeFileSync(path.join(rootDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2))

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

console.log(`Build complete: dist/${outputName}`)
