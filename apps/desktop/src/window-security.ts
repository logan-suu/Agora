import type { BrowserWindow, Session } from 'electron';

export function trustedFrame(
  window: BrowserWindow,
  sender: Electron.IpcMainInvokeEvent,
  urls: Set<string>,
) {
  return (
    sender.sender === window.webContents &&
    sender.senderFrame === window.webContents.mainFrame &&
    sender.senderFrame !== null &&
    urls.has(sender.senderFrame.url)
  );
}

export function secureSession(
  session: Session,
  origin: string | undefined,
  capability: string | undefined,
  localFiles: Set<string>,
) {
  const allowed = (url: string) => {
    try {
      return localFiles.has(url) || (origin !== undefined && new URL(url).origin === origin);
    } catch {
      return false;
    }
  };
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowed(details.url) }),
  );
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers))
      if (key.toLowerCase() === 'x-agora-desktop') delete headers[key];
    if (origin && capability && new URL(details.url).origin === origin)
      headers['X-Agora-Desktop'] = capability;
    callback({ requestHeaders: headers });
  });
  return async () => {
    session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    session.webRequest.onBeforeSendHeaders(null);
    await session.closeAllConnections();
    await session.clearStorageData();
    await session.clearCache();
  };
}

export function secureWindow(window: BrowserWindow, urls: Set<string>) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!urls.has(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!urls.has(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}
