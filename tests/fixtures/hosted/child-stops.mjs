// Stands in for a pipeline that stops cooperatively: exits 0 on SIGTERM after printing `stopped`.
process.on('SIGTERM', () => {
  console.log('stopped');
  process.exit(0);
});
console.log('ready');
setInterval(() => {}, 1000);
