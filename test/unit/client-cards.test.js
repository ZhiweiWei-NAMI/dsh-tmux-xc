import test from 'node:test';
import assert from 'node:assert/strict';
import '../../lib/client.js';
const {taskCardTitle,flatTasks,terminalShell,terminalAttachCommand}=globalThis.__dshTmuxXcPure;
const uri=(kind,s,w='-',p='-')=>`dsh-tmux:v1/namilab/dea37f45406a/default/2747042-1792290254/${kind}/${s}/${w}/${p}`;
test('cards distinguish same-command panes without restoring the tree',()=>{
  const panes=[0,1].map(index=>({index,cmd:'bash'}));
  const window={name:'bash',index:0,panes};const session={alias:'LLM training',windows:[window]};
  assert.deepEqual(panes.map(p=>taskCardTitle(p,window,session)),['LLM training · bash #1','LLM training · bash #2']);
  panes[1].alias='Evaluation';assert.equal(taskCardTitle(panes[1],window,session),'Evaluation');
});
test('cards deduplicate linked panes and retain every exact parent path',()=>{
  const sessions=[1,2].map(s=>({uri:uri('session',s),name:'task'+s,windows:[{uri:uri('window',s,3),name:'bash',panes:[{uri:uri('pane',s,3,7),index:0,cmd:'bash'}]}]}));
  const result=flatTasks({hosts:[{id:'namilab',sockets:[{sessions}]}]});
  assert.equal(result[0].tasks.length,1);assert.equal(result[0].tasks[0].links.length,2);
  assert.deepEqual(result[0].tasks[0].links.map(l=>l.session.uri),sessions.map(s=>s.uri));
});
test('native terminal selects only a supported discovered command language',()=>{
  const shells=[{path:'C:\\Windows\\System32\\cmd.exe'},{path:'C:\\Program Files\\PowerShell\\7\\pwsh.exe'},{path:'/bin/bash'}];
  assert.equal(terminalShell(shells,{transport:'ssh'}),shells[1]);
  assert.equal(terminalShell(shells,{transport:'local'}),shells[2]);
  assert.equal(terminalShell([{path:'/bin/fish'}]),null);
});
test('terminal command guards the exact generation and pane in one tmux queue',()=>{
  const ref={kind:'pane',sid:3,wid:5,pid:7,gen:'123-456'};
  const shell={path:'/bin/bash'},host={transport:'ssh',ssh:'Lab Alias'},socket={path:'/tmp/tmux lab'};
  const command=terminalAttachCommand(ref,host,socket,shell);
  assert.ok(command.startsWith('ssh -t -o ClearAllForwardings=yes '));
  for(const part of ['if-shell -F','123-456','#{session_id},$3','#{window_id},@5','#{pane_id},%7','select-window','select-pane','attach-session'])assert.ok(command.includes(part),part);
  assert.equal(terminalAttachCommand({...ref,gen:'bad'},host,socket,shell),null);
  assert.equal(terminalAttachCommand(ref,{...host,ssh:'-oProxyCommand=bad'},socket,shell),null);
  assert.equal(terminalAttachCommand(ref,host,{path:'/tmp/bad\npath'},shell),null);
  assert.equal(terminalAttachCommand(ref,host,{path:'/tmp/bad"path'},{path:'powershell.exe'}),null);
  assert.equal(terminalAttachCommand(ref,{transport:'local'},socket,{path:'pwsh.exe'}),null);
});
test('cards retain empty hosts and tolerate an empty inventory',()=>{
  assert.deepEqual(flatTasks(null),[]);assert.equal(flatTasks([{id:'empty',sockets:[]}])[0].tasks.length,0);
});
