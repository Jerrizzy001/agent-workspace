import { chromium } from 'playwright';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dockerHost=process.env.WORKSPACE_DOCKER_HOST;
const fixture=await mkdtemp(path.join(tmpdir(),'workspace-linux-release-'));
const suffix=path.basename(fixture).toLowerCase();const image='agent-workspace-fixture:'+suffix;const container='aw-'+suffix;
const docker=(args,options={})=>execFileSync('docker',[...(dockerHost?['--host',dockerHost]:[]),...args],{encoding:'utf8',...options});
const pkg=JSON.parse(await readFile('package.json','utf8'));
await copyFile(path.resolve('release',`agent-workspace-server-${pkg.version}.tar.gz`),path.join(fixture,'server.tar.gz'));
await writeFile(path.join(fixture,'Dockerfile'),`FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
RUN apt-get update && apt-get install -y --no-install-recommends tmux git ca-certificates python3 make g++ openssl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app /fixture && chown node:node /app /fixture
COPY --chown=node:node server.tar.gz /fixture/server.tar.gz
USER node
WORKDIR /app
RUN tar -xzf /fixture/server.tar.gz --strip-components=1 && npm ci --no-audit --no-fund
RUN mkdir /fixture/repo /fixture/data /fixture/tls && cd /fixture/repo && git init && git config user.name Fixture && git config user.email fixture@example.invalid && printf 'fixture\\n' > hello.txt && git add . && git commit -m fixture
RUN openssl req -x509 -newkey rsa:2048 -nodes -keyout /fixture/tls/key.pem -out /fixture/tls/cert.pem -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1
CMD ["sleep", "infinity"]
`);
let browser;const checks=[];
try {
  docker(['build','-t',image,fixture],{stdio:'pipe',maxBuffer:4*1024*1024});
  docker(['run','--detach','--name',container,'--publish','127.0.0.1::8787',image]);
  const published=docker(['port',container,'8787/tcp']).trim();const port=Number(published.split(':').at(-1));const origin=`https://127.0.0.1:${port}`;
  function start(){docker(['exec','--detach',container,'sh','-c',`node /app/dist/server/headless.mjs --data-dir /fixture/data --project /fixture/repo --host 0.0.0.0 --port 8787 --tls-cert /fixture/tls/cert.pem --tls-key /fixture/tls/key.pem --public-origin ${origin} > /fixture/server.log 2>&1 & echo $! > /fixture/server.pid; wait $!`]);}
  start();
  browser=await chromium.launch({headless:true,...(process.env.WORKSPACE_BROWSER?{executablePath:process.env.WORKSPACE_BROWSER}:{channel:process.env.WORKSPACE_BROWSER_CHANNEL || 'chrome'})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,ignoreHTTPSErrors:true});const page=await context.newPage();page.setDefaultTimeout(30000);
  for(let i=0;i<100;i++){try{const r=await context.request.get(origin+'/api/status');if(r.status()===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const secret=docker(['exec',container,'cat','/fixture/data/remote-pairing.secret']).trim();
  async function login(){await page.goto(origin);await page.getByLabel('Pairing code').fill(secret);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected to workspace',{exact:true}).waitFor();}
  await login();const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.workspace.invoke(command,payload),{command,payload});
  const snapshot=await invoke('snapshot');const project=snapshot.projects[0];assert.equal(project.path,'/fixture/repo');
  const task=await invoke('task.create',{projectId:project.id,title:'Linux host continuity'});const attempt=await invoke('attempt.start',{taskId:task.id,provider:'shell',idempotencyKey:'linux-continuity'});const viewer={sessionId:attempt.session.id,generation:attempt.session.generation,viewerId:'linux-browser'};
  await invoke('session.attach',{...viewer,cols:80,rows:24});await invoke('session.input',{...viewer,data:"printf 'LINUX_PID=%s\\n' \"$$\"\r"});
  let capture='';for(let i=0;i<50;i++){capture=(await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data;if(/LINUX_PID=\d+/.test(capture))break;await page.waitForTimeout(100);}const pid=capture.match(/LINUX_PID=(\d+)/)?.[1];assert.ok(pid);
  const file=await invoke('files.read',{projectId:project.id,path:'hello.txt'});await invoke('files.write',{projectId:project.id,path:'hello.txt',content:'Linux browser edit\n',expectedHash:file.hash});assert.equal((await invoke('files.read',{projectId:project.id,path:'hello.txt'})).content,'Linux browser edit\n');
  checks.push('fresh Linux arm64 archive npm ci, Node native terminal, HTTPS mobile browser pairing, shell PID and file edits');
  // Stop only this fixture's host process; the container and its tmux server remain.
  const hostPid=docker(['exec',container,'cat','/fixture/server.pid']).trim();assert.match(hostPid,/^\d+$/);docker(['exec',container,'node','-e',"process.kill(Number(process.argv[1]),'SIGTERM')",hostPid]);
  for(let i=0;i<60;i++){try{docker(['exec',container,'node','-e',"process.kill(Number(process.argv[1]),0)",hostPid],{stdio:'pipe'});}catch{break;}await page.waitForTimeout(100);}
  start();for(let i=0;i<100;i++){try{const r=await context.request.get(origin+'/api/status');if(r.status()===200)break;}catch{}await page.waitForTimeout(100);}
  await page.reload();await page.getByLabel('Pairing code').waitFor();await page.getByLabel('Pairing code').fill(secret);await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('Connected to workspace',{exact:true}).waitFor();
  const after=await invoke('snapshot');assert.ok(after.sessions.some(s=>s.id===viewer.sessionId&&s.generation===viewer.generation));await invoke('session.attach',{...viewer,cols:80,rows:24});assert.match((await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data,new RegExp('LINUX_PID='+pid));
  await invoke('session.input',{...viewer,data:"printf '%s%s\\n' 'LINUX_RESTART_' 'OK'\r"});for(let i=0;i<30;i++){if((await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data.includes('LINUX_RESTART_OK'))break;await page.waitForTimeout(100);}assert.match((await invoke('session.capture',{sessionId:viewer.sessionId,generation:viewer.generation})).data,/LINUX_RESTART_OK/);
  assert.equal((await page.request.get(origin+'/manifest.webmanifest')).status(),200);await invoke('session.terminate',viewer);checks.push('Linux host process restart preserves same tmux session, generation and PID; browser re-pairs and sends new shell input');
  const runtime={node:docker(['exec',container,'node','--version']).trim(),tmux:docker(['exec',container,'tmux','-V']).trim(),arch:docker(['exec',container,'uname','-m']).trim(),image:'node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c'};
  console.log(JSON.stringify({passed:true,runtime,checks}));
}finally{await browser?.close();try{docker(['rm','--force',container],{stdio:'pipe'});}catch{}try{docker(['image','rm',image],{stdio:'pipe'});}catch{}await rm(fixture,{recursive:true,force:true});}
