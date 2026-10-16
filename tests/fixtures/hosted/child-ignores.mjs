// Stands in for a pipeline that never stops: ignores SIGTERM and sleeps 10 s.
process.on('SIGTERM', () => {});
console.log('ready');
setTimeout(() => {}, 10_000);
