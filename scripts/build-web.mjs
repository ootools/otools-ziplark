/**
 * Build the plugin's static frontend.
 *
 * Ziplark's upstream UI is vanilla HTML/CSS/JS and talks only to
 * `window.__TAURI__` (core.invoke / dialog / event.listen). So the whole port
 * is an overlay: copy the upstream files verbatim, inject one classic script
 * that installs the OTools host bridge, and copy the vendored SDK as ESM.
 *
 * `upstream/` is never modified. See scripts/sync-upstream.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {arg, root, main} from './common.mjs';

const IMPORT_MAP = `    <script type="importmap">
      {"imports":{"@tauri-apps/api/dpi":"./sdk-shims/dpi.js","@tauri-apps/plugin-dialog":"./sdk-shims/plugin-dialog.js"}}
    </script>
    <link rel="stylesheet" href="bridge.css" />
`;

function copyFile(source, target) {
  if (!fs.existsSync(source)) throw new Error('sourceMissing: ' + path.relative(root, source));
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('symlinkNotAllowed');
  fs.copyFileSync(source, target);
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) throw new Error('sourceMissing: ' + path.relative(root, source));
  fs.mkdirSync(target, {recursive: true});
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name), to = path.join(target, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('symlinkNotAllowed');
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile() && !name.endsWith('.map')) copyFile(from, to);
  }
}

// main.js 锚点补丁：在状态声明之后注入 `__ztState` 读写出口（currentArchive /
// archiveStack / tree 是脚本作用域 let/const，tabs.js 从外部不可达）。这是 dist
// main.js 相对 upstream 唯一允许的差异，设计见 docs/tabs-design.md §1。
export const MAIN_PATCH_ANCHOR = 'let createInputs = [];';
export const MAIN_PATCH_START = '/* ziplark-tabs: 状态出口（build 注入，见 docs/tabs-design.md §1；勿手改） */';
export const MAIN_PATCH_END = '/* ziplark-tabs:end */';
export const MAIN_PATCH_BLOCK =
  MAIN_PATCH_START + '\n' +
  'window.__ztState = {\n' +
  '  getCurrentArchive() { return currentArchive; },\n' +
  '  setCurrentArchive(v) { currentArchive = v; },\n' +
  '  getArchiveStack() { return archiveStack; },\n' +
  '  setArchiveStack(v) { archiveStack = v; },\n' +
  '  getTree() { return tree; },\n' +
  '};\n' +
  MAIN_PATCH_END + '\n';

export function applyMainPatch(source) {
  if (source.includes(MAIN_PATCH_START)) return source;
  const anchorAt = source.indexOf(MAIN_PATCH_ANCHOR);
  if (anchorAt < 0) throw new Error('mainPatchAnchorMissing');
  const lineEnd = source.indexOf('\n', anchorAt);
  if (lineEnd < 0) throw new Error('mainPatchAnchorUnterminated');
  const insertAt = lineEnd + 1;
  return source.slice(0, insertAt) + MAIN_PATCH_BLOCK + source.slice(insertAt);
}

export function buildWeb(directory = root) {
  const upstream = path.join(directory, 'upstream/ui');
  const shell = path.join(directory, 'shell');
  const sdk = path.join(directory, 'node_modules/otools-plugin-sdk/dist');
  const dist = path.join(directory, 'dist');

  for (const file of ['index.html', 'main.js', 'styles.css', 'logo.png']) {
    if (!fs.existsSync(path.join(upstream, file))) throw new Error('upstreamUiMissing: ' + file);
  }
  for (const file of ['host-bridge.js', 'dialogs.js', 'bridge.css']) {
    if (!fs.existsSync(path.join(shell, file))) throw new Error('shellOverlayMissing: ' + file);
  }
  if (!fs.existsSync(path.join(sdk, 'index.js'))) throw new Error('sdkDistMissing');

  // Clean only generated output; never touch upstream/ or lib/.
  fs.rmSync(dist, {recursive: true, force: true});
  fs.mkdirSync(dist, {recursive: true});

  for (const file of ['main.js', 'styles.css', 'logo.png']) {
    copyFile(path.join(upstream, file), path.join(dist, file));
  }
  const distMainPath = path.join(dist, 'main.js');
  fs.writeFileSync(distMainPath, applyMainPatch(fs.readFileSync(distMainPath, 'utf8')));
  for (const file of ['host-bridge.js', 'dialogs.js', 'bridge.css']) {
    copyFile(path.join(shell, file), path.join(dist, file));
  }
  copyTree(path.join(shell, 'sdk-shims'), path.join(dist, 'sdk-shims'));
  copyTree(sdk, path.join(dist, 'sdk'));
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    const source = path.join(directory, file);
    if (fs.existsSync(source)) copyFile(source, path.join(dist, file));
  }

  let html = fs.readFileSync(path.join(upstream, 'index.html'), 'utf8');
  const bridgeTag = '    <script src="host-bridge.js"></script>\n';
  if (!html.includes('<script src="main.js"></script>')) throw new Error('upstreamEntryChanged');
  if (!html.includes('</head>')) throw new Error('upstreamHeadMissing');
  html = html.replace('</head>', IMPORT_MAP + '  </head>');
  html = html.replace('<script src="main.js"></script>', bridgeTag + '    <script src="main.js"></script>');
  fs.writeFileSync(path.join(dist, 'index.html'), html);

  // Guardrails: the bridge must be installed before main.js, the SDK must be
  // reachable, and no native artifact may leak into the web payload.
  const built = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  if (built.indexOf('host-bridge.js') > built.indexOf('<script src="main.js"')) {
    throw new Error('bridgeOrderInvalid');
  }
  if (!fs.existsSync(path.join(dist, 'sdk/index.js')) || !fs.existsSync(path.join(dist, 'sdk/runtime.js'))) {
    throw new Error('sdkCopyIncomplete');
  }
  const leaked = fs.readdirSync(dist).filter(name => /\.(dylib|so|dll)$/i.test(name));
  if (leaked.length) throw new Error('nativeArtifactInWeb');

  const count = fs.readdirSync(path.join(dist, 'sdk')).filter(name => name.endsWith('.js')).length;
  return {dist, sdkModules: count, entry: 'dist/index.html'};
}

main(import.meta.url, () => {
  console.log(JSON.stringify(buildWeb(path.resolve(arg('root', root)))));
});
