import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {arg,root,main,variant} from './common.mjs';
import {safeArchivePath,encodeZip,readZip} from './archive.mjs';
import {verifyNative} from './verify-native.mjs';

export function productionManifest(input,version=input.version) {
  if(!input||typeof input!=='object'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.packid||'')||input.uuid!==input.packid||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version||''))throw new Error('invalidManifest');
  try {safeArchivePath(input.entry);}catch{throw new Error('invalidEntry');}
  if(!input.entry.startsWith('dist/'))throw new Error('invalidEntry');
  if(input.native?.enabled!==true)throw new Error('invalidManifest');
  const result={...input,version,native:{...input.native,autoReload:false}};delete result.devUrl;delete result.quickDev;return result;
}

function regular(file) {
  if(!fs.existsSync(file))throw new Error('buildFileMissing');
  const stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new Error('symlinkNotAllowed');if(!stat.isFile())throw new Error('invalidBuildFile');
  if(stat.size>256*1024*1024)throw new Error('buildFileTooLarge');return fs.readFileSync(file);
}
function walk(directory,prefix='dist') {
  const root=fs.lstatSync(directory);if(root.isSymbolicLink()||!root.isDirectory())throw new Error('symlinkNotAllowed');
  const entries=[];
  for(const name of fs.readdirSync(directory).sort()) {
    const file=path.join(directory,name),stat=fs.lstatSync(file),relative=`${prefix}/${name}`;
    safeArchivePath(relative);if(stat.isSymbolicLink())throw new Error('symlinkNotAllowed');
    if(stat.isDirectory())entries.push(...walk(file,relative));else if(stat.isFile())entries.push({name:relative,data:regular(file)});else throw new Error('invalidBuildFile');
  }
  return entries;
}

export function packPlugin(directory,platform,arch,output='dist-pack',version='') {
  const selected=variant(platform,arch),source=JSON.parse(regular(path.join(directory,'plugin.json')));
  const manifest=productionManifest(source,version||source.version),native=path.join(directory,'lib',selected.source);
  if(!fs.existsSync(native))throw new Error('nativeArtifactMissing');
  verifyNative(native,platform,arch);
  const manifestBytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  const entries=[{name:'plugin.json',data:manifestBytes},{name:'logo.svg',data:regular(path.join(directory,'logo.svg'))},...walk(path.join(directory,'dist')),{name:selected.entry,data:regular(native)}];
  if(!entries.some(entry=>entry.name===manifest.entry))throw new Error('webEntryMissing');
  const bytes=encodeZip(entries);readZip(bytes);
  // No output directory exists until all source validation and ZIP checks passed.
  const artifactDir=path.resolve(directory,output,selected.suffix);fs.mkdirSync(artifactDir,{recursive:true});
  const name=`${manifest.packid}-${manifest.version}-${selected.suffix}.oplg`,file=path.join(artifactDir,name);
  const temporary=`${file}.tmp`;fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,file);
  fs.writeFileSync(path.join(artifactDir,'plugin.json'),manifestBytes);fs.writeFileSync(path.join(artifactDir,'logo.svg'),entries[1].data);
  const sums=[name,'plugin.json','logo.svg'].map(name=>`${createHash('sha256').update(fs.readFileSync(path.join(artifactDir,name))).digest('hex')}  ${name}`);
  fs.writeFileSync(path.join(artifactDir,'SHA256SUMS'),`${sums.join('\n')}\n`);
  const meta={packid:manifest.packid,uuid:manifest.uuid,version:manifest.version,platform,arch,packageMode:1,output:file,entries:entries.length,totalBytes:entries.reduce((n,entry)=>n+entry.data.length,0),nativeLibs:[selected.entry]};
  fs.writeFileSync(path.join(artifactDir,'meta.json'),`${JSON.stringify(meta,null,2)}\n`);return meta;
}

main(import.meta.url,()=> {
  const platform=arg('platform');if(!platform)throw new Error('platformRequired');
  const arch=arg('arch',platform==='macos'?'':'x64');
  console.log(JSON.stringify(packPlugin(path.resolve(arg('root',root)),platform,arch,arg('out','dist-pack'),arg('version'))));
});
