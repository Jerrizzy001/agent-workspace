import { _electron as electron, chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cleanupFixture } from './fixture-cleanup.mjs';
// Explicit opt-in: starts one real provider task using the host's existing account.
const fixture=await mkdtemp(path.join(tmpdir(),'workspace-remote-provider-'));
const repo=path.join(fixture,'repo');await mkdir(repo);await writeFile(path.join(repo,'README.md'),'Disposable remote provider fixture.\n');
for(const args of [['init'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','.'],['commit','-m','fixture']])execFileSync('git',args,{cwd:repo,stdio:'ignore'});
let app,browser,owner,remotePage,sp;let ownerInvoke;
try{
  app=await electron.launch({...process.env.WORKSPACE_APP_EXECUTABLE?{executablePath:process.env.WORKSPACE_APP_EXECUTABLE}:{args:['.']},env:{...process.env,WORKSPACE_TEST_DATA_DIR:path.join(fixture,'data')}});
  owner=await app.firstWindow();await owner.waitForFunction(()=>!!window.workspace?.remote);
  ownerInvoke=(command,payload={})=>owner.evaluate(({command,payload})=>window.workspace.invoke(command,payload),{command,payload});
  const project=await ownerInvoke('project.add',{path:repo});
  const status=await owner.evaluate(()=>window.workspace.remote.enable({host:'127.0.0.1',port:0,tls:false}));
  const secret=await owner.evaluate(()=>window.workspace.remote.pairingSecret());
  browser=await chromium.launch({headless:true,channel:process.env.WORKSPACE_BROWSER_CHANNEL || 'chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});remotePage=await context.newPage();
  await remotePage.goto(status.url);await remotePage.getByLabel('Pairing code').fill(secret);await remotePage.getByRole('button',{name:'Connect',exact:true}).click();await remotePage.getByText('Connected to workspace',{exact:true}).waitFor();
  const invoke=(command,payload={})=>remotePage.evaluate(({command,payload})=>window.workspace.invoke(command,payload),{command,payload});
  const worktree=await invoke('worktree.create',{projectId:project.id,branch:'remote-codex-proof'});
  const expected='remote-codex-proof-'+Date.now()+'\n';
  const task=await invoke('task.create',{projectId:project.id,title:'Verify authenticated remote Codex launch',description:'Disposable integration test'});
  const launch=await invoke('attempt.start',{taskId:task.id,provider:'codex',model:'gpt-6.1-sol',worktreePath:worktree.path,idempotencyKey:'single-remote-codex-proof',prompt:`This is a disposable integration test repository. Create a file named provider-proof.txt in the current working directory containing exactly the decoded JSON string ${JSON.stringify(expected)} including its final newline. Also append exactly one line containing remote-codex-execution to a file named run-count.txt in the current working directory (create it if absent; append if it already exists). Modify only these two files. Do not read personal files, use network tools, install packages, modify configuration, or make commits. Then report the files were created and stop.`});
  sp={sessionId:launch.session.id,generation:launch.session.generation,viewerId:'remote-codex-verification'};
  await invoke('session.attach',{...sp,cols:120,rows:45});
  const read=async name=>(await invoke('files.read',{projectId:project.id,worktreePath:worktree.path,path:name})).content;
  let trusted=false,proved=false;
  for(let tick=0;tick<150;tick++){
    const capture=(await invoke('session.capture',{sessionId:sp.sessionId,generation:sp.generation})).data;
    await writeFile(path.join(fixture,'codex-output.txt'),capture);
    if(/Is this a project you created/.test(capture)&&!trusted){trusted=true;await invoke('session.input',{...sp,data:'\x1b[B\r'});}
    else if(/Do you trust the contents|Trust this folder\?/.test(capture)&&!trusted){trusted=true;await invoke('session.input',{...sp,data:'\r'});}
    const proof=await read('provider-proof.txt').catch(()=>''),count=await read('run-count.txt').catch(()=>'');
    if(proof===expected&&count==='remote-codex-execution\n'){proved=true;break;}
    if(tick===20||tick===60)console.log(JSON.stringify({stage:'waiting for single remote Codex task',elapsedSeconds:tick*2}));
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  assert.ok(proved,'Single remote model task must produce exact proof and one execution line');
  const changed=await invoke('git.status',{projectId:project.id,worktreePath:worktree.path});
  assert.deepEqual(changed.files.map(file=>file.path).sort(),['provider-proof.txt','run-count.txt']);
  await assert.rejects(readFile(path.join(repo,'provider-proof.txt')),error=>error.code==='ENOENT');
  await assert.rejects(readFile(path.join(repo,'run-count.txt')),error=>error.code==='ENOENT');
  const socket=path.join(tmpdir(),`aw-${createHash('sha256').update(await realpath(path.join(fixture,'data'))).digest('hex').slice(0,20)}.sock`);
  const tmux=process.env.WORKSPACE_TMUX || '/opt/homebrew/bin/tmux';
  const panePid=()=>execFileSync(tmux,['-S',socket,'display-message','-p','-t',launch.session.backendName,'#{pane_pid}'],{encoding:'utf8'}).trim();
  const beforePid=panePid();await remotePage.close();remotePage=await context.newPage();await remotePage.goto(status.url);await remotePage.getByText('Connected to workspace',{exact:true}).waitFor();
  const recovered=await invoke('snapshot');assert.equal(recovered.attempts.length,1);assert.equal(recovered.attempts[0].id,launch.attempt.id);assert.ok(recovered.sessions.some(s=>s.id===sp.sessionId&&s.generation===sp.generation));assert.equal(panePid(),beforePid);
  await invoke('session.attach',{...sp,cols:120,rows:45});await new Promise(resolve=>setTimeout(resolve,5000));assert.equal(await read('provider-proof.txt'),expected);assert.equal(await read('run-count.txt'),'remote-codex-execution\n');assert.equal(panePid(),beforePid);
  await invoke('session.terminate',sp);sp=null;
  const evidence={passed:true,verifiedAt:new Date().toISOString(),provider:'codex',model:'gpt-6.1-sol',cliVersion:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),attemptId:launch.attempt.id,sessionId:launch.session.id,generation:launch.session.generation,panePid:beforePid,executionCount:1,proofSha256:createHash('sha256').update(expected).digest('hex'),checks:['attempt launched once through authenticated phone-sized browser gateway into disposable managed worktree','exact requested file and one append-only execution line verified through remote file API','browser disconnect/reconnect retains exact attempt, session, generation and tmux pane PID with no prompt redelivery']};
  await mkdir('docs/screenshots/remote',{recursive:true});
  await writeFile('docs/screenshots/remote/provider-verification.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({...evidence,fixture}));
}finally{await browser?.close();if(sp&&ownerInvoke){await ownerInvoke('session.attach',{...sp,cols:100,rows:30}).catch(()=>{});await ownerInvoke('session.terminate',sp).catch(()=>{});}await app?.close().catch(()=>{});await cleanupFixture(fixture);}
