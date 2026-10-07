const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const javaRoot = process.env.VEYRA_JAVA_HOME || path.join(process.env.APPDATA, 'veyra-launcher', 'runtimes', 'java-runtime-epsilon');
const javac = path.join(javaRoot, 'bin', 'javac.exe');
const jar = path.join(javaRoot, 'bin', 'jar.exe');
const classes = path.join(root, 'build', 'compat');
fs.mkdirSync(classes, { recursive: true });
fs.mkdirSync(path.join(root, 'assets', 'compat'), { recursive: true });
execFileSync(javac, ['--release', '25', '-d', classes, path.join(root, 'compat', 'NeoVersionGuard.java')], { stdio: 'inherit' });
execFileSync(jar, ['--create', '--file', path.join(root, 'assets', 'compat', 'neoforge-version-guard.jar'),
  '--manifest', path.join(root, 'compat', 'MANIFEST.MF'), '-C', classes, '.'], { stdio: 'inherit' });
process.stdout.write('Built NeoForge 26.3.0.56-beta compatibility guard.\n');
