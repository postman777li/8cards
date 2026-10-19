// Deterministic local acceptance service; never used by production entrypoints.
import { createApp } from '../../apps/server/src/app.js';
let seed = 12345;
const app = createApp({
  random: () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000,
  multiplierRandom: () => 0.39,
});
app.listen(3101, '127.0.0.1');
const stop = () => {
  void app.realtime.close().then(() => app.close(() => process.exit(0)));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
