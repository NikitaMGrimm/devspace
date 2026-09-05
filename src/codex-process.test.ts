import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";

const posix = { skip: process.platform === "win32" };
const command = (script: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
function manager(t: TestContext) { const sessions = new ProcessSessionManager(); t.after(() => sessions.shutdown()); return sessions; }
function input(script: string, workspaceId = "ws_a") {
  return { workspaceId, command: command(script), cwd: process.cwd(), timeoutMs: 0, captureCombinedOutput: true, closeStdin: true };
}
async function drain(sessions: ProcessSessionManager, snapshot: ProcessSnapshot, workspaceId = "ws_a") {
  let output = snapshot.output ?? "";
  while (snapshot.running) {
    snapshot = await sessions.write({workspaceId,sessionId:snapshot.sessionId!,yieldTimeMs:1_000});
    output += snapshot.output ?? "";
  }
  return {output,snapshot};
}

test("combined output follows stdout/stderr arrival order", posix, async (t) => {
  const sessions=manager(t);
  const result=await sessions.start({...input("process.stdout.write('out1\\n'); setTimeout(()=>process.stderr.write('err\\n'),30); setTimeout(()=>process.stdout.write('out2\\n'),60)"),yieldTimeMs:1000});
  assert.equal(result.output,"out1\nerr\nout2\n");
  assert.equal(result.stdout,"out1\nout2\n"); assert.equal(result.stderr,"err\n");
  assert.equal(result.exitCode,0);
});
test("longer commands remain pollable and consumed output is not duplicated", posix, async(t)=>{
  const sessions=manager(t);
  const first=await sessions.start({...input("process.stdout.write('start\\n'); setTimeout(()=>process.stdout.write('end\\n'),100)"),yieldTimeMs:0});
  assert.equal(first.running,true); assert.equal(sessions.workspaceForSession(first.sessionId!),"ws_a");
  const result=await drain(sessions,first);
  assert.equal(result.output,"start\nend\n"); assert.equal(result.snapshot.timedOut,false);
  assert.throws(()=>sessions.workspaceForSession(first.sessionId!),/already exited or is unknown/);
});
test("different workspaces have independent command sessions and retain ownership checks",posix,async(t)=>{
  const sessions=manager(t);
  const [a,b]=await Promise.all([
    sessions.start({...input("setTimeout(()=>process.stdout.write('A'),80)"),yieldTimeMs:0}),
    sessions.start({...input("setTimeout(()=>process.stdout.write('B'),80)","ws_b"),yieldTimeMs:0}),
  ]);
  assert.notEqual(a.sessionId,b.sessionId);
  assert.equal(sessions.workspaceForSession(b.sessionId!),"ws_b");
  await assert.rejects(sessions.write({workspaceId:"ws_b",sessionId:a.sessionId!,chars:""}),/does not belong/);
  const results=await Promise.all([drain(sessions,a),drain(sessions,b,"ws_b")]);
  assert.equal(results[0]!.output,"A"); assert.equal(results[1]!.output,"B");
});
test("strict non-TTY commands get stdin EOF rather than hanging",posix,async(t)=>{
  const sessions=manager(t);
  const result=await sessions.start({...input("process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('EOF'))"),yieldTimeMs:1000});
  assert.equal(result.running,false); assert.equal(result.output,"EOF");
});
test("writing to a closed pipe produces a recoverable error",posix,async(t)=>{
  const sessions=manager(t);
  const first=await sessions.start({...input("setTimeout(()=>{},2000)"),yieldTimeMs:0});
  await assert.rejects(sessions.write({workspaceId:"ws_a",sessionId:first.sessionId!,chars:"hello\n"}),/stdin is closed/);
  sessions.terminate("ws_a",first.sessionId!);
});
test("legacy pipe sessions can still accept stdin",posix,async(t)=>{
  const sessions=manager(t);
  const first=await sessions.start({...input("process.stdin.once('data',data=>process.stdout.write(data,()=>process.exit(0)))"),closeStdin:false,yieldTimeMs:0});
  const result=await sessions.write({workspaceId:"ws_a",sessionId:first.sessionId!,chars:"echo\n",yieldTimeMs:1000});
  assert.equal(result.output,"echo\n"); assert.equal(result.exitCode,0);
});
test("UTF-8 split across stream chunks is decoded without replacement characters",posix,async(t)=>{
  const sessions=manager(t);
  const result=await sessions.start({...input("process.stdout.write(Buffer.from([0xe2])); setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),30)"),yieldTimeMs:1000});
  assert.equal(result.output,"€"); assert.equal(result.stdout,"€");
});
test("combined output respects budgets and reports original token count",posix,async(t)=>{
  const sessions=manager(t);
  const result=await sessions.start({...input("process.stdout.write('x'.repeat(50000))"),yieldTimeMs:1000,maxOutputTokens:20});
  assert.ok(Array.from(result.output!).length<=80);
  assert.equal(result.originalOutputTokens,12500);
  const zero=await sessions.start({...input("process.stdout.write('abc')"),yieldTimeMs:1000,maxOutputTokens:0});
  assert.equal(zero.output,""); assert.equal(zero.originalOutputTokens,1);
});
test("legacy snapshots do not gain a combined output field unless requested",posix,async(t)=>{
  const sessions=manager(t);
  const result=await sessions.start({...input("process.stdout.write('legacy')"),captureCombinedOutput:false,yieldTimeMs:1000});
  assert.equal(result.stdout,"legacy"); assert.equal(Object.hasOwn(result,"output"),false);
});
test("legacy execution timeout and Ctrl-C still terminate process groups",posix,async(t)=>{
  const sessions=manager(t);
  const timed=await sessions.start({...input("setTimeout(()=>{},2000)"),timeoutMs:20,yieldTimeMs:1000});
  assert.equal(timed.timedOut,true); assert.equal(timed.running,false);
  const running=await sessions.start({...input("setTimeout(()=>{},2000)"),yieldTimeMs:0});
  const interrupted=await sessions.write({workspaceId:"ws_a",sessionId:running.sessionId!,chars:"\u0003",yieldTimeMs:1000});
  assert.equal(interrupted.running,false); assert.equal(interrupted.signal,"SIGINT");
});
