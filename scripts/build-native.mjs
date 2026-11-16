import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {arg,root,main,hostPlatform,variant} from './common.mjs';
import {verifyNative} from './verify-native.mjs';

main(import.meta.url,()=> {
  const directory=path.resolve(arg('root',root)),platform=hostPlatform(),arch=arg('arch',process.arch==='arm64'?'arm64':'x64');
  const selected=variant(platform,arch),manifest=path.join(directory,'native/Cargo.toml');
  if(!fs.existsSync(manifest))throw new Error('nativeManifestMissing');
  const target=path.join(directory,'native/target'),cross=arch!==process.arch;
  const args=['build','--locked','--release','--manifest-path',manifest,'--target-dir',target,...(cross?['--target',selected.triple]:[])];
  const result=spawnSync('cargo',args,{stdio:['ignore','inherit','inherit'],cwd:directory});
  if(result.error||result.status!==0)throw new Error('nativeBuildFailed');
  const filename=platform==='macos'?'libotools_ziplark_native.dylib':platform==='windows'?'otools_ziplark_native.dll':'libotools_ziplark_native.so';
  const source=path.join(target,cross?selected.triple:'','release',filename);
  const info=verifyNative(source,platform,arch);
  const lib=path.join(directory,'lib');fs.mkdirSync(lib,{recursive:true});
  fs.copyFileSync(source,path.join(lib,selected.source));
  if(!cross)fs.copyFileSync(source,path.join(directory,selected.entry));
  console.log(JSON.stringify({source,staged:path.join(lib,selected.source),...info}));
});
