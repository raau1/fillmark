// Builds the Windows desktop app: release/Fillmark.exe
//   1. builds the web app (dist/)
//   2. embeds it into the Go launcher (desktop/)
//   3. cross-compiles a single Windows x64 executable with icon and version info
// Requirements: Node 20+, Go 1.22+. llvm-rc/llvm-cvtres are only needed to
// regenerate desktop/rsrc_windows_amd64.syso after changing the icon.
// Options: --linux  also build a Linux launcher (used by the automated tests)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'desktop');
const release = join(root, 'release');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
const has = (cmd) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (!has('go')) {
  console.error('Go is required to build the desktop app: https://go.dev/dl/');
  process.exit(1);
}

run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
rmSync(join(desktop, 'dist'), { recursive: true, force: true });
cpSync(join(root, 'dist'), join(desktop, 'dist'), { recursive: true });

if (has('llvm-rc') && has('llvm-cvtres')) {
  run('llvm-rc', ['/FO', 'fillmark.res', 'fillmark.rc'], { cwd: desktop });
  run('llvm-cvtres', ['/MACHINE:X64', '/OUT:rsrc_windows_amd64.syso', 'fillmark.res'], { cwd: desktop });
  rmSync(join(desktop, 'fillmark.res'), { force: true });
} else if (!existsSync(join(desktop, 'rsrc_windows_amd64.syso'))) {
  console.warn('warning: no icon resource (desktop/rsrc_windows_amd64.syso); the exe will have the default icon');
}

mkdirSync(release, { recursive: true });
const env = { ...process.env, CGO_ENABLED: '0' };
run('go', ['test', './...'], { cwd: desktop, env });
run('go', ['build', '-trimpath', '-ldflags', '-H windowsgui -s -w', '-o', join(release, 'Fillmark.exe'), '.'], {
  cwd: desktop,
  env: { ...env, GOOS: 'windows', GOARCH: 'amd64' },
});
if (process.argv.includes('--linux')) {
  run('go', ['build', '-trimpath', '-o', join(release, 'fillmark-linux'), '.'], { cwd: desktop, env: { ...env, GOOS: 'linux', GOARCH: 'amd64' } });
}
console.log(`\nrelease/Fillmark.exe  ${(statSync(join(release, 'Fillmark.exe')).size / 1048576).toFixed(1)} MB`);
