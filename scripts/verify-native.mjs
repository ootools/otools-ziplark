import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {arg,main} from './common.mjs';

export const REQUIRED_EXPORTS=['otools_plugin_invoke','otools_plugin_free'];

function binaryKind(bytes) {
  if(bytes.length<64)throw new Error('nativeArtifactInvalid');
  const magic=bytes.readUInt32LE(0);
  if(magic===0xfeedfacf) {
    if(bytes.readUInt32LE(12)!==6)throw new Error('nativeArtifactInvalid');
    const cpu=bytes.readUInt32LE(4);return {platform:'macos',arch:cpu===0x0100000c?'arm64':cpu===0x01000007?'x64':null};
  }
  if(bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) {
    if(bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(16)!==3)throw new Error('nativeArtifactInvalid');
    const machine=bytes.readUInt16LE(18);return {platform:'linux',arch:machine===183?'arm64':machine===62?'x64':null};
  }
  if(bytes.toString('ascii',0,2)==='MZ') {
    const offset=bytes.readUInt32LE(60);
    if(offset<64||offset+24>bytes.length||bytes.readUInt32LE(offset)!==0x4550||(bytes.readUInt16LE(offset+22)&0x2000)===0)throw new Error('nativeArtifactInvalid');
    const machine=bytes.readUInt16LE(offset+4);return {platform:'windows',arch:machine===0xaa64?'arm64':machine===0x8664?'x64':null};
  }
  throw new Error('nativeArtifactInvalid');
}

// Parse PE export metadata without loading DLLs; supports verification on mac/Linux.
function peExports(bytes) {
  const pe=bytes.readUInt32LE(60),count=bytes.readUInt16LE(pe+6),optional=pe+24,optionalSize=bytes.readUInt16LE(pe+20);
  if(optional+optionalSize>bytes.length||bytes.readUInt16LE(optional)!==0x20b||optionalSize<120)throw new Error('nativeArtifactInvalid');
  const headers=bytes.readUInt32LE(optional+60),exportRva=bytes.readUInt32LE(optional+112),sections=optional+optionalSize;
  function rvaToOffset(rva,size=1) {
    if(rva<headers&&rva+size<=bytes.length)return rva;
    for(let i=0;i<count;i++) {
      const section=sections+i*40;if(section+40>bytes.length)throw new Error('nativeArtifactInvalid');
      const virtualSize=bytes.readUInt32LE(section+8),virtualAddress=bytes.readUInt32LE(section+12),rawSize=bytes.readUInt32LE(section+16),rawOffset=bytes.readUInt32LE(section+20);
      if(rva>=virtualAddress&&rva-virtualAddress+size<=Math.min(rawSize,Math.max(rawSize,virtualSize))&&rawOffset+rva-virtualAddress+size<=bytes.length)return rawOffset+rva-virtualAddress;
    }
    throw new Error('nativeArtifactInvalid');
  }
  if(!exportRva)throw new Error('nativeExportMissing');
  const directory=rvaToOffset(exportRva,40),nameCount=bytes.readUInt32LE(directory+24),nameRva=bytes.readUInt32LE(directory+32);
  if(nameCount>10000)throw new Error('nativeArtifactInvalid');
  const names=rvaToOffset(nameRva,nameCount*4),result=[];
  for(let i=0;i<nameCount;i++) {
    const start=rvaToOffset(bytes.readUInt32LE(names+i*4)),end=bytes.indexOf(0,start);
    if(end<start||end-start>4096)throw new Error('nativeArtifactInvalid');result.push(bytes.toString('ascii',start,end));
  }
  return result;
}

export function verifyNativeBytes(bytes,platform,arch) {
  const detected=binaryKind(bytes);
  if(detected.platform!==platform||!detected.arch||(arch&&detected.arch!==arch))throw new Error('nativeArtifactInvalid');
  return detected;
}

export function verifyNative(file,platform,arch) {
  if(!fs.existsSync(file))throw new Error('nativeArtifactMissing');
  const metadata=fs.lstatSync(file);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>256*1024*1024)throw new Error('nativeArtifactInvalid');
  const bytes=fs.readFileSync(file),detected=binaryKind(bytes);
  if(detected.platform!==platform||!detected.arch||(arch&&detected.arch!==arch))throw new Error('nativeArtifactInvalid');
  let exports=[];
  if(platform==='windows') {
    // dumpbin where available, otherwise the bounded PE parser is equally valid.
    const result=spawnSync('dumpbin',['/exports',file],{encoding:'utf8',timeout:15000});
    if(result.status===0)exports=result.stdout.split(/\s+/);else exports=peExports(bytes);
  }else {
    const candidates=platform==='macos'?[['nm',['-gU',file]],['llvm-nm',['--defined-only','--extern-only',file]]]:[['llvm-nm',['-D','--defined-only',file]],['nm',['-D','--defined-only',file]]];
    let available=false;
    for(const [command,args] of candidates) {
      const result=spawnSync(command,args,{encoding:'utf8',timeout:15000});
      if(result.status===0) {available=true;exports=result.stdout.split(/\s+/).map(symbol=>symbol.replace(/^_/,''));break;}
    }
    if(!available)throw new Error('nativeExportMissing');
  }
  if(REQUIRED_EXPORTS.some(symbol=>!exports.includes(symbol)))throw new Error('nativeExportMissing');
  return {platform,arch:detected.arch,exports:REQUIRED_EXPORTS};
}

main(import.meta.url,()=> {
  const file=process.argv[2];if(!file)throw new Error('nativeArtifactMissing');
  const info=verifyNative(file,arg('platform'),arg('arch'));console.log(JSON.stringify(info));
});
