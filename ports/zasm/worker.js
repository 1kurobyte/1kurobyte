// Runs one zasm invocation per message in a fresh wasm instance, so a crash
// or a hang in the assembler can't take the page down (the page terminates
// this worker after a timeout).
importScripts('zasm.js');

onmessage = async ({ data: { source, name } }) => {
  let stdout = '', stderr = '';
  const mod = await createZasm({
    print: (t) => { stdout += t + '\n'; },
    printErr: (t) => { stderr += t + '\n'; },
  });
  const input = '/work/' + name;
  mod.FS.mkdir('/work');
  mod.FS.writeFile(input, source);
  let status;
  try {
    status = mod.callMain([input]);
  } catch (e) {
    if (e && e.name === 'ExitStatus') status = e.status;
    else { stderr += `zasm crashed: ${e}\n`; status = -1; }
  }
  let elf = null;
  try { elf = mod.FS.readFile(input.replace(/\.[^./]*$/, '')); } catch (e) { /* no output */ }
  postMessage({ stdout, stderr, status, elf }, elf ? [elf.buffer] : []);
};
