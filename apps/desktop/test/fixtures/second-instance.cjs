// Native competing process: reuse the production host and the same application data root.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const [root, resources] = process.argv.slice(2);
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'cache'));
(async () => {
  const { runDesktop } = await import(
    pathToFileURL(path.join(resources, 'app.asar/dist/desktop-app.js')).href
  );
  let spawned = false;
  await runDesktop({
    applicationData: root,
    resourcesRoot: resources,
    spawnService() {
      spawned = true;
      throw new Error('duplicate_spawn');
    },
  });
  fs.writeFileSync(
    path.join(root, 'second-instance.json'),
    JSON.stringify({ spawned, ownsLock: app.hasSingleInstanceLock() }),
  );
  app.exit(spawned ? 1 : 0);
})();
