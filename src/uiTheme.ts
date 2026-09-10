export function applyAppearance(value: string) {
  const appearance = ['light', 'dark'].includes(value) ? value : 'system';
  document.documentElement.dataset.appearance = appearance;
  document.documentElement.dataset.theme = appearance === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : appearance;
}

export function initializeAppearance() {
  applyAppearance(localStorage.getItem('parallel.appearance') || 'system');
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    if (document.documentElement.dataset.appearance === 'system') applyAppearance('system');
  };
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}
