import { sigtermStop } from '../../../src/app/stop.js';

// Installs the hosted SIGTERM stop, announces itself, then polls until the stop reason arrives.
const stop = sigtermStop();
console.log('ready');
const timer = setInterval(() => {
  const reason = stop();
  if (reason !== null) {
    console.log(reason);
    clearInterval(timer);
    process.exit(0);
  }
}, 20);
