// Entry point. Nothing but node: builtins may be imported here: a native addon built for another
// Node ABI segfaults instead of failing, so the version check must run before any module loads.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`jobpilot needs Node 24 or newer; this is Node ${process.versions.node} (${process.execPath}).`);
  process.exit(1);
}

await import('./cli.js');
