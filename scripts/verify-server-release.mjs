import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { cleanupFixture } from './fixture-cleanup.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const fixture=await mkdtemp(path.join(tmpdir(),'workspace-server-release-'));
const repo=path.join(fixture,'repo');await mkdir(repo);await writeFile(path.join(repo,'hello.txt'),'fixture\n');
for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','.'],['commit','-m','fixture']])execFileSync('git',args,{cwd:repo,stdio:'ignore'});
const archive=path.resolve('release',`agent-workspace-server-${pkg.version}.tar.gz`);
execFileSync('tar',['-xzf',archive,'-C',fixture]);
const serverDir=path.join(fixture,`agent-workspace-server-${pkg.version}`);
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:serverDir,stdio:'pipe'});
const serverPkg=JSON.parse(await readFile(path.join(serverDir,'package.json'),'utf8'));
assert.ok(!JSON.stringify(serverPkg.scripts).includes("electron"));assert.ok(!serverPkg.dependencies.electron);
let child,browser;const checks=[];
try{
  child=spawn(process.execPath,['dist/server/headless.mjs','--data-dir',path.join(fixture,'data'),'--project',repo,'--port','0'],{cwd:serverDir,env:{...process.env,NODE_PATH:''},stdio:['ignore','pipe','pipe']});
  const status=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Host startup timed out')),15000);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Host exited '+code));});child.stdout.on('data',bytes=>{out+=bytes;const line=out.split('\n').find(l=>l.startsWith('{'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});});
  const secret=(await readFile(path.join(fixture,'data','remote-pairing.secret'),'utf8')).trim();
  browser=await chromium.launch({headless:true,...(process.env.WORKSPACE_BROWSER?{executablePath:process.env.WORKSPACE_BROWSER}:{channel:process.env.WORKSPACE_BROWSER_CHANNEL || 'chrome'})});const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(status.url);await page.getByLabel('Pairing code').fill(secret);await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByText('Connected to workspace',{exact:true}).waitFor();const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.workspace.invoke(command,payload),{command,payload});
  const snapshot=await invoke('snapshot');assert.equal(snapshot.projects.length,1);const project=snapshot.projects[0];
  const task=await invoke('task.create',{projectId:project.id,title:'Standalone browser terminal'});
  const attempt=await invoke('attempt.start',{taskId:task.id,provider:'shell',idempotencyKey:'standalone'});
  const viewer={sessionId:attempt.session.id,generation:attempt.session.generation,viewerId:'standalone-browser'};
  await invoke('session.attach',{...viewer,cols:80,rows:24});await invoke('session.input',{...viewer,data:"printf '%s%s\\n' 'STANDALONE_' 'BROWSER_OK'\r"});
  for(let i=0;i<40;i++){if((await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data.includes('STANDALONE_BROWSER_OK'))break;await page.waitForTimeout(100);}
  assert.match((await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data,/STANDALONE_BROWSER_OK/);
  const manifest=await page.request.get(status.url+'/manifest.webmanifest');assert.equal(manifest.status(),200);assert.equal((await manifest.json()).display,'standalone');
  assert.equal((await page.request.get(status.url+'/sw.js')).status(),200);assert.deepEqual(errors,[]);checks.push('fresh archive npm ci has no Electron hooks; Node24 native terminal loads independently of checkout');checks.push('bundled browser assets, mobile pairing, authenticated real shell input/capture and PWA manifest work outside checkout');
  await invoke('session.terminate',viewer);
  console.log(JSON.stringify({passed:true,checks}));
}finally{await browser?.close();if(child){child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});}await cleanupFixture(fixture);}
