import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const name=`agent-workspace-server-${pkg.version}`;
const destination=path.resolve('release',name);
await rm(destination,{recursive:true,force:true});
await mkdir(path.join(destination,'dist'),{recursive:true});
await cp('dist/server',path.join(destination,'dist/server'),{recursive:true});
await cp('dist/renderer',path.join(destination,'dist/renderer'),{recursive:true});
await mkdir(path.join(destination,'scripts'),{recursive:true});
await cp('scripts/prepare-native.mjs',path.join(destination,'scripts/prepare-native.mjs'));
await cp('docs/server-README.md',path.join(destination,'README.md'));
await writeFile(path.join(destination,'package.json'),JSON.stringify({
  name:'agent-workspace-server',version:pkg.version,private:true,type:'module',
  description:'Standalone Agent Workspace browser host',engines:{node:'>=24'},
  scripts:{start:'node dist/server/headless.mjs',postinstall:'node scripts/prepare-native.mjs',rebuild:'npm rebuild node-pty && node scripts/prepare-native.mjs'},
  dependencies:{'node-pty':pkg.dependencies['node-pty'],ws:pkg.dependencies.ws},
},null,2)+'\n');
execFileSync('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{cwd:destination,stdio:'inherit'});
execFileSync('tar',['-czf',path.resolve('release',name+'.tar.gz'),'-C',path.resolve('release'),name],{stdio:'inherit'});
console.log(path.join('release',name+'.tar.gz'));
