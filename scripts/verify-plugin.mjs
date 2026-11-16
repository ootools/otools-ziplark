import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {main,root,variant} from './common.mjs';
import {readZip,safeArchivePath} from './archive.mjs';
import {productionManifest} from './pack-plugin.mjs';
import {verifyNativeBytes} from './verify-native.mjs';

export function verifyPackage(directory) {
  const files=fs.readdirSync(directory),packages=files.filter(name=>name.endsWith('.oplg'));
  if(packages.length!==1)throw new Error('packageFileMissing');
  const filename=packages[0],expected=new Set([filename,'plugin.json','logo.svg']),sums=new Map();
  for(const line of fs.readFileSync(path.join(directory,'SHA256SUMS'),'utf8').trim().split('\n')) {
    const match=/^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    if(!match||!expected.has(match[2])||sums.has(match[2]))throw new Error('invalidChecksums');sums.set(match[2],match[1]);
  }
  if(sums.size!==expected.size)throw new Error('invalidChecksums');
  for(const [name,digest] of sums) {
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024*1024)throw new Error('invalidPackageFile');
    const actual=createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(actual!==digest)throw new Error('checksumMismatch');
  }
  const sidecar=fs.readFileSync(path.join(directory,'plugin.json')),manifest=JSON.parse(sidecar);
  productionManifest(manifest);
  if(Object.hasOwn(manifest,'devUrl')||Object.hasOwn(manifest,'quickDev')||manifest.native.autoReload!==false)throw new Error('developmentManifest');
  const entries=readZip(fs.readFileSync(path.join(directory,filename))),byName=new Map(entries.map(entry=>[entry.name,entry.data]));
  if(!byName.get('plugin.json')?.equals(sidecar)||!byName.get('logo.svg')?.equals(fs.readFileSync(path.join(directory,'logo.svg'))))throw new Error('manifestMismatch');
  const meta=JSON.parse(fs.readFileSync(path.join(directory,'meta.json'))),selected=variant(meta.platform,meta.arch);
  if(filename!==`${manifest.packid}-${manifest.version}-${selected.suffix}.oplg`)throw new Error('packageIdentityMismatch');
  const libraries=entries.filter(entry=>entry.name.startsWith('lib/'));
  if(libraries.length!==1||libraries[0].name!==selected.entry||libraries[0].data.length<64)throw new Error('nativeArtifactMissing');
  verifyNativeBytes(libraries[0].data,meta.platform,meta.arch);
  // Export verification occurs on the real source during build/pack. Verification of
  // an untrusted package stays in memory and never loads/extracts its native code.
  if(!byName.get(manifest.entry)?.length||!byName.has('logo.svg'))throw new Error('webEntryMissing');
  for(const entry of entries) {
    safeArchivePath(entry.name);
    if(!['plugin.json','logo.svg',selected.entry].includes(entry.name)&&!entry.name.startsWith('dist/'))throw new Error('unexpectedPackageEntry');
  }
  return {packid:manifest.packid,version:manifest.version,platform:meta.platform,arch:meta.arch,entries:entries.length,verified:true};
}

main(import.meta.url,()=> {
  const directory=path.resolve(root,process.argv[2]||'dist-pack');
  if(fs.existsSync(path.join(directory,'SHA256SUMS')))console.log(JSON.stringify(verifyPackage(directory)));
  else {
    const subdirs=fs.readdirSync(directory).filter(name=>fs.statSync(path.join(directory,name)).isDirectory());
    if(!subdirs.length)throw new Error('packageFileMissing');
    for(const name of subdirs)console.log(JSON.stringify(verifyPackage(path.join(directory,name))));
  }
});
