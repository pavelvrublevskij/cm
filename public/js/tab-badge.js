/**
 * The browser tab shows how many Task Board tickets and sessions wait for the user: the count in
 * the title and a dot on the favicon.
 */
const TabBadge = {
  TITLE: 'CM',
  ICON: '/favicon.svg',
  SIZE: 32,
  _count: 0,
  _dotIcon: null,

  title(count) {
    return count ? `(${count}) ${TabBadge.TITLE}` : TabBadge.TITLE;
  },

  set(count) {
    if (count === TabBadge._count) return;
    TabBadge._count = count;
    document.title = TabBadge.title(count);
    if (!count) TabBadge._setIcon(TabBadge.ICON);
    else if (TabBadge._dotIcon) TabBadge._setIcon(TabBadge._dotIcon);
    else TabBadge._drawDotIcon();
  },

  _setIcon(href) {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = href;
  },

  /** The favicon with a red dot in its top-right corner, drawn once and kept as a data URL. */
  _drawDotIcon() {
    const img = new Image();
    img.onload = () => {
      const size = TabBadge.SIZE;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      ctx.beginPath();
      ctx.arc(size * 0.75, size * 0.25, size * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
      TabBadge._dotIcon = canvas.toDataURL('image/png');
      if (TabBadge._count) TabBadge._setIcon(TabBadge._dotIcon);
    };
    img.src = TabBadge.ICON;
  }
};
