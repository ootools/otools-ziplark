/**
 * Guard the immutable upstream snapshot.
 *
 * `--check` hashes everything under upstream/ and compares it with
 * upstream.lock.json. It is run in CI so a well-meaning "small fix" to the
 * vendored UI never silently becomes part of the port. All Ziplark-specific
 * changes belong in shell/ instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {root, main} from './common.mjs';

const LOCK = 'upstream.lock.json';
const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

export function snapshot(directory = root) {
  const base = path.join(directory, 'upstream');
  if (!fs.existsSync(base)) throw new Error('upstreamMissing');
  const files = {};
  const walk = (dir, prefix = 'upstream') => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (IGNORE.has(name)) continue;
      const file = path.join(dir, name), relative = `${prefix}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlinkInUpstream');
      if (stat.isDirectory()) walk(file, relative);
      else if (stat.isFile()) {
        files[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } else throw new Error('unexpectedUpstreamEntry');
    }
  };
  walk(base);
  return files;
}

export function readLock(directory = root) {
  const file = path.join(directory, LOCK);
  if (!fs.existsSync(file)) throw new Error('upstreamLockMissing');
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!lock.files || typeof lock.files !== 'object') throw new Error('invalidUpstreamLock');
  return lock;
}

export function compare(files, lock) {
  const left = Object.keys(files).sort(), right = Object.keys(lock.files).sort();
  if (left.length !== right.length) return ['upstreamFileCountChanged'];
  const differences = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return ['upstreamFileSetChanged'];
    if (files[left[i]] !== lock.files[right[i]]) differences.push(left[i]);
  }
  return differences;
}

main(import.meta.url, () => {
  const check = process.argv.includes('--check');
  const files = snapshot();
  if (!check) {
    const file = path.join(root, LOCK);
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(file, `${JSON.stringify({
      repository: 'https://github.com/zhitongblog/ziplark',
      commit: '9d539b64f7654ff104ff0dfe9b5a8ba3645bb498',
      license: 'MIT',
      fileCount: Object.keys(files).length,
      files,
    }, null, 2)}\n`);
    console.log(`upstream.lock.json updated (${Object.keys(files).length} files, previous ${previous.fileCount ?? 'none'})`);
    return;
  }
  const differences = compare(files, readLock());
  if (differences.length) {
    throw new Error('upstreamSnapshotModified: ' + differences.slice(0, 8).join(', '));
  }
  console.log(`upstream snapshot verified (${Object.keys(files).length} files unchanged)`);
});
