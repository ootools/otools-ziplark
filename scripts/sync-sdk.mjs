/**
 * Verify the vendored host SDK is intact. The SDK dist is copied verbatim into
 * dist/sdk/ by build-web.mjs; in-place edits here would silently diverge from
 * upstream otools-plugin-sdk, so CI hashes it against vendor/sdk-source.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root, main} from './common.mjs';

const SOURCE_JSON = 'vendor/sdk-source.json';
// The SDK is a single-file bundle: host-file-tree / otools-file-open live
// *inside* index.js (only their .d.ts are emitted as standalone files).
const REQUIRED = ['index.js', 'runtime.js', 'host-file-tree.d.ts', 'otools-file-open.d.ts'];
const REQUIRED_EXPORTS = [
  ['index.js', ['onOtoolsOpenFile', 'pickFromHostTree']],
  ['runtime.js', ['listenTauri']],
];

function hashDirectory(directory) {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlinkInSdk');
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile() && (name.endsWith('.js') || name.endsWith('.d.ts') || name === 'package.json')) {
        files[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
  };
  walk(directory);
  return files;
}

main(import.meta.url, () => {
  const sdk = path.join(root, 'vendor/otools-plugin-sdk-dist');
  if (!fs.existsSync(sdk)) throw new Error('vendorSdkMissing');
  for (const file of REQUIRED) {
    if (!fs.existsSync(path.join(sdk, file))) throw new Error('vendorSdkIncomplete: ' + file);
  }
  for (const [file, names] of REQUIRED_EXPORTS) {
    const source = fs.readFileSync(path.join(sdk, file), 'utf8');
    for (const name of names) {
      if (!source.includes(`as ${name}`)) throw new Error('vendorSdkMissingExport: ' + file + '#' + name);
    }
  }
  const files = hashDirectory(sdk);
  const lockFile = path.join(root, SOURCE_JSON);
  if (!process.argv.includes('--check')) {
    fs.writeFileSync(lockFile, `${JSON.stringify({source: 'ootools/OTools vendor/otools-plugin-sdk/dist', version: '0.1.1', files}, null, 2)}\n`);
    console.log(`sdk-source.json updated (${Object.keys(files).length} files)`);
    return;
  }
  if (!fs.existsSync(lockFile)) throw new Error('sdkSourceLockMissing');
  const expected = JSON.parse(fs.readFileSync(lockFile, 'utf8')).files;
  const mismatched = Object.entries(files).filter(([name, digest]) => expected[name] !== digest);
  if (mismatched.length || Object.keys(expected).length !== Object.keys(files).length) {
    throw new Error('vendorSdkModified: ' + mismatched.slice(0, 5).map(([name]) => name).join(', '));
  }
  console.log(`vendored SDK verified (${Object.keys(files).length} files unchanged)`);
});
