import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function arg(name,fallback='') {
  const index=process.argv.indexOf(`--${name}`);return index>=0?(process.argv[index+1]||fallback):fallback;
}
export function main(metaUrl,operation) {
  if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(metaUrl)) {
    try {operation();} catch(error) {console.error(error.message||'commandFailed');process.exitCode=1;}
  }
}

export const variants={
  macos:{
    arm64:{source:'macOS-arm64.dylib',entry:'lib/macOS.dylib',suffix:'macos',triple:'aarch64-apple-darwin'},
    x64:{source:'macOS-x86_64.dylib',entry:'lib/macOS.dylib',suffix:'macos-intel',triple:'x86_64-apple-darwin'},
  },
  windows:{
    x64:{source:'Windows-x64.dll',entry:'lib/Windows.dll',suffix:'windows',triple:'x86_64-pc-windows-msvc'},
    arm64:{source:'Windows-arm64.dll',entry:'lib/Windows.dll',suffix:'windows-arm',triple:'aarch64-pc-windows-msvc'},
  },
  linux:{
    x64:{source:'Linux-x64.so',entry:'lib/Linux.so',suffix:'linux',triple:'x86_64-unknown-linux-gnu'},
    arm64:{source:'Linux-arm64.so',entry:'lib/Linux.so',suffix:'linux-arm',triple:'aarch64-unknown-linux-gnu'},
  },
};
export function hostPlatform() {return ({darwin:'macos',win32:'windows',linux:'linux'})[process.platform];}
export function variant(platform,arch) {
  if(!variants[platform])throw new Error('unsupportedPlatform');
  if(!['x64','arm64'].includes(arch))throw new Error('unsupportedArchitecture');
  return variants[platform][arch];
}
