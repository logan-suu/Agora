const title = document.getElementById('title');
const detail = document.getElementById('detail');
const restart = document.getElementById('restart');
const guidance = {
  upgrade_requires_quiescence:
    'An upgrade needs recovery before this version can open your data. Use the compatible application to finish or recover the upgrade.',
  state_in_use:
    'Another service or an interrupted shutdown owns this data directory. Quit other copies of Agora. If this follows a crash, have the previous process and saved ownership record checked before recovery.',
  unsupported_state_version:
    'This saved data needs a compatible version or upgrade recovery. Install the compatible app; your data has been retained.',
  invalid_installation:
    'An application component is missing or unsafe. Replace Agora with a complete download, then try again.',
  shutdown_timeout:
    'The local service has not finished stopping. Keep Agora open; resources are not yet confirmed released.',
};
async function refresh() {
  try {
    const status = await window.agoraDesktop.status();
    title.textContent =
      status.state === 'failed'
        ? 'Agora needs attention'
        : status.state === 'draining'
          ? 'Stopping Agora'
          : 'Starting Agora';
    detail.textContent =
      guidance[status.code] ??
      (status.state === 'failed'
        ? 'The local service stopped unexpectedly. Your saved data is retained. Try again after it has exited.'
        : 'Preparing your local service…');
    restart.disabled = !status.canRestart;
  } catch {
    detail.textContent = 'The application connection is unavailable. Quit and reopen Agora.';
  }
}
restart.addEventListener('click', () => {
  restart.disabled = true;
  void window.agoraDesktop.restart();
});
document.getElementById('quit').addEventListener('click', () => {
  void window.agoraDesktop.quit();
});
void refresh();
setInterval(refresh, 500);
