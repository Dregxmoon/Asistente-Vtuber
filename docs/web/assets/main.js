'use strict';

(() => {
  const root = document.documentElement;
  root.classList.add('js');
  let saved = null;
  try {
    saved = localStorage.getItem('kaoru-theme');
  } catch (_) {}
  root.classList.toggle(
    'dark',
    saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  );

  document.addEventListener('DOMContentLoaded', () => {
    const theme = document.getElementById('theme-toggle');
    const syncTheme = () => {
      const dark = root.classList.contains('dark');
      theme?.setAttribute('aria-pressed', String(dark));
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#141413' : '#f8f8f7');
    };
    syncTheme();
    theme?.addEventListener('click', () => {
      root.classList.toggle('dark');
      try {
        localStorage.setItem('kaoru-theme', root.classList.contains('dark') ? 'dark' : 'light');
      } catch (_) {}
      syncTheme();
    });

    const menu = document.querySelector('.menu-toggle');
    const navigation = document.getElementById('site-navigation');
    const closeMenu = () => {
      navigation?.classList.remove('is-open');
      menu?.setAttribute('aria-expanded', 'false');
    };
    menu?.addEventListener('click', () => {
      const open = navigation?.classList.toggle('is-open');
      menu.setAttribute('aria-expanded', String(Boolean(open)));
    });
    navigation?.addEventListener('click', closeMenu);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') {
        closeMenu();
        menu.focus();
      }
    });

    document.querySelectorAll('.language-bar a').forEach((link) => {
      link.addEventListener('click', () => {
        const destination = new URL(link.href);
        destination.hash = location.hash;
        link.href = destination.href;
      });
    });

    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        const text = document.getElementById(button.dataset.copy)?.textContent || '';
        const status = document.querySelector('.copy-status');
        try {
          await navigator.clipboard.writeText(text);
          if (status) status.textContent = button.dataset.copied;
        } catch (_) {
          if (status) status.textContent = button.dataset.error;
        }
      });
    });

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    if (!reducedMotion.matches && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.remove('reveal-pending');
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.05 }
      );
      document.querySelectorAll('.fade-up').forEach((element) => {
        if (element.getBoundingClientRect().top > window.innerHeight) {
          element.classList.add('reveal-pending');
          observer.observe(element);
        }
      });
      reducedMotion.addEventListener('change', () => {
        if (reducedMotion.matches) {
          document
            .querySelectorAll('.reveal-pending')
            .forEach((element) => element.classList.remove('reveal-pending'));
          observer.disconnect();
        }
      });
    }
  });
})();
