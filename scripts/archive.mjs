import {inflateRawSync,crc32} from 'node:zlib';

const MAX_ARCHIVE_BYTES=512*1024*1024;
const MAX_ENTRY_BYTES=256*1024*1024;
const MAX_ENTRIES=10000;

export function safeArchivePath(name) {
  if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\\')||name.includes(':')||/[\x00-\x1f\x7f]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')) {
    throw new Error('invalidArchivePath');
  }
}

// Deterministic stored ZIP. Native binaries already have reasonable compression;
// limiting to stored entries keeps verification simple and avoids implicit inflate.
export function encodeZip(entries) {
  if(entries.length>MAX_ENTRIES)throw new Error('archiveTooLarge');
  const chunks=[],central=[];let offset=0;
  for(const entry of entries) {
    const name=Buffer.from(entry.name,'utf8'),data=Buffer.from(entry.data),checksum=crc32(data);
    if(name.length>65535||data.length>MAX_ENTRY_BYTES)throw new Error('archiveTooLarge');
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(0x21,12);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    chunks.push(local,name,data);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(0x314,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(0x21,14);
    directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE((0o100644<<16)>>>0,38);directory.writeUInt32LE(offset,42);
    central.push(directory,name);offset+=30+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  const zip=Buffer.concat([...chunks,directory,end]);if(zip.length>MAX_ARCHIVE_BYTES)throw new Error('archiveTooLarge');return zip;
}

function range(raw,offset,length) {
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>raw.length)throw new Error('invalidArchive');
}

// Validate in memory only. Never extract, import, load or execute package content.
export function readZip(raw) {
  if(raw.length>MAX_ARCHIVE_BYTES||raw.length<22)throw new Error('invalidArchive');
  let end=-1;
  for(let offset=raw.length-22;offset>=Math.max(0,raw.length-65557);offset--) {
    if(raw.readUInt32LE(offset)===0x06054b50&&offset+22+raw.readUInt16LE(offset+20)===raw.length) {end=offset;break;}
  }
  if(end<0||raw.readUInt16LE(end+4)!==0||raw.readUInt16LE(end+6)!==0)throw new Error('invalidArchive');
  const count=raw.readUInt16LE(end+10),directorySize=raw.readUInt32LE(end+12),directoryStart=raw.readUInt32LE(end+16);
  if(count>MAX_ENTRIES||raw.readUInt16LE(end+8)!==count||directoryStart+directorySize!==end)throw new Error('invalidArchive');
  range(raw,directoryStart,directorySize);
  let cursor=directoryStart,total=0;const entries=[],names=new Set(),localRanges=[];
  for(let i=0;i<count;i++) {
    range(raw,cursor,46);if(raw.readUInt32LE(cursor)!==0x02014b50)throw new Error('invalidArchive');
    const flags=raw.readUInt16LE(cursor+8),method=raw.readUInt16LE(cursor+10),checksum=raw.readUInt32LE(cursor+16),compressed=raw.readUInt32LE(cursor+20),size=raw.readUInt32LE(cursor+24);
    const nameLength=raw.readUInt16LE(cursor+28),extra=raw.readUInt16LE(cursor+30),comment=raw.readUInt16LE(cursor+32),local=raw.readUInt32LE(cursor+42);
    range(raw,cursor+46,nameLength+extra+comment);
    const name=raw.toString('utf8',cursor+46,cursor+46+nameLength);safeArchivePath(name);
    if(names.has(name))throw new Error('duplicateArchiveEntry');names.add(name);
    const unixMode=raw.readUInt32LE(cursor+38)>>>16;
    if((unixMode&0o170000)===0o120000)throw new Error('symlinkNotAllowed');
    if(flags&0x09||![0,8].includes(method)||size>MAX_ENTRY_BYTES||(total+=size)>MAX_ARCHIVE_BYTES)throw new Error('archiveTooLarge');
    range(raw,local,30);if(raw.readUInt32LE(local)!==0x04034b50||raw.readUInt16LE(local+6)!==flags||raw.readUInt16LE(local+8)!==method||raw.readUInt32LE(local+14)!==checksum||raw.readUInt32LE(local+18)!==compressed||raw.readUInt32LE(local+22)!==size)throw new Error('invalidArchive');
    const localName=raw.readUInt16LE(local+26),localExtra=raw.readUInt16LE(local+28);range(raw,local+30,localName+localExtra);
    if(raw.toString('utf8',local+30,local+30+localName)!==name)throw new Error('invalidArchive');
    const start=local+30+localName+localExtra,finish=start+compressed;range(raw,start,compressed);
    if(finish>directoryStart||localRanges.some(([from,to])=>local<to&&finish>from))throw new Error('invalidArchive');localRanges.push([local,finish]);
    const content=raw.subarray(start,finish);
    let data;
    try {data=method===0?Buffer.from(content):inflateRawSync(content,{maxOutputLength:Math.max(1,size)});}catch{throw new Error('invalidArchive');}
    if(data.length!==size)throw new Error('archiveSizeMismatch');
    if(crc32(data)!==checksum)throw new Error('archiveCrcMismatch');
    entries.push({name,data});cursor+=46+nameLength+extra+comment;
  }
  if(cursor!==end)throw new Error('invalidArchive');return entries;
}
