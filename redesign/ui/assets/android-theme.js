// Run before first paint. The Activity and transparent overlay share the same pages.
(() => {
  const params = new URLSearchParams(location.search);
  const platform = params.get('platform') || (window.AndroidShell ? 'android' : 'web');
  if (platform !== 'android') return;
  const root = document.documentElement;
  root.dataset.platform = 'android';
  // Fail transparent if an older shell cannot report its container mode.
  let mode = 'overlay';
  try { mode = window.AndroidShell ? window.AndroidShell.getMode() : params.get('mode') || 'activity'; } catch { /* preserve overlay transparency */ }
  root.dataset.container = mode === 'activity' ? 'activity' : 'overlay';
  root.style.colorScheme = 'light';
})();
