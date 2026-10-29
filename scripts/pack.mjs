// Package cue (rea) as a standalone macOS app, signed with your certificate (or ad-hoc).
//   npm run pack             -> dist/cue (rea)-darwin-arm64/cue (rea).app
//   npm run install-app      -> also copies it to /Applications
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const NAME = 'cue (rea)';

const [outDir] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  overwrite: true,
  platform: 'darwin',
  arch: process.arch === 'x64' ? 'x64' : 'arm64',
  name: NAME,
  executableName: 'cue-rea',
  appBundleId: 'com.cue.overlay.rea',
  appCategoryType: 'public.app-category.productivity',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  asar: true,
  ignore: [/^\/(test|docs|scripts|dist)(\/|$)/, /^\/README\.md$/, /^\/\.gitignore$/],
  // Same entitlement strings and agent-app behavior as upstream cue's Info.plist.
  extendInfo: {
    LSUIElement: true,
    NSMicrophoneUsageDescription: 'cue transcribes your microphone so it can help you in conversations.',
    NSAudioCaptureUsageDescription: 'cue captures system audio to transcribe the other participant in a call.',
    NSCameraUsageDescription: 'cue does not use the camera.'
  }
});

// Sign with a real certificate when there is one. macOS ties Microphone and Screen Recording
// grants to the signature: an ad-hoc grant only matches that exact build, so every rebuild
// asks again, while a certificate grant survives rebuilds.
// CUE_SIGN_IDENTITY overrides the pick ('-' forces ad-hoc).
function signingIdentity() {
  if (process.env.CUE_SIGN_IDENTITY) return process.env.CUE_SIGN_IDENTITY;
  let out = '';
  try { out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); }
  catch { return '-'; }
  const ids = [...out.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "(.+)"$/gm)].map((m) => ({ hash: m[1], name: m[2] }));
  const pick = ids.find((i) => i.name.startsWith('Developer ID Application:')) ||
    ids.find((i) => i.name.startsWith('Apple Development:'));
  return pick ? pick.hash : '-';
}

const appPath = path.join(outDir, NAME + '.app');
// Renaming the bundle breaks Electron's signature; re-sign so macOS will run it.
const identity = signingIdentity();
execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
console.log('signed ' + (identity === '-' ? 'ad-hoc (permissions reset on every rebuild)' : 'with ' + identity));
console.log('built  ' + appPath);

if (process.argv.includes('--install')) {
  const dest = path.join('/Applications', NAME + '.app');
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); // only ever our own bundle name
  execFileSync('ditto', [appPath, dest], { stdio: 'inherit' });
  console.log('installed ' + dest);
}
