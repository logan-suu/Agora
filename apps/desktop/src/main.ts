import { app } from 'electron';
import { runDesktop } from './desktop-app.js';

// Electron waits for ESM evaluation before ready; runDesktop itself waits for ready.
void runDesktop().catch(() => {
  console.error('desktop_startup_failed');
  app.quit();
});
