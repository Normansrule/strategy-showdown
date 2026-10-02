// Applies a saved theme choice before first paint (classic script, loaded from 'self' so the CSP allows it).
(function () {
  try {
    var t = localStorage.getItem('ss-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system setting */ }
})();
