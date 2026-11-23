/* Runs first. (1) always use https, (2) never run inside someone else's frame, (3) register the offline service worker. */
(function () {
  try {
    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (location.protocol === 'http:' && !local) {
      location.replace('https://' + location.host + location.pathname + location.search + location.hash);
      return;
    }
  } catch (e) { /* ignore */ }
  try {
    if (window.top !== window.self) window.top.location = window.self.location;
  } catch (e) {
    // blocked from navigating the parent: hide the app instead of letting it be clicked through
    document.documentElement.style.display = 'none';
  }
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;
      var active = document.querySelector('.screen.active');
      if (active && (active.id === 'screen-home' || active.id === 'screen-login')) location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function (err) { console.warn('SW registration failed', err); });
    });
  }
})();
