/* Theme toggle — light/dark mode with localStorage persistence */
(function() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  window.toggleTheme = function() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    if (next === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', next);
    }
    localStorage.setItem('theme', next);
    // Update button text
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = next === 'light' ? '☀ Light' : '🌙 Dark';
  };

  // Set initial button text after DOM loads
  document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = saved === 'light' ? '☀ Light' : '🌙 Dark';
  });
})();
