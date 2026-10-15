// Faceted jewel sprites. One drawing routine serves every color: the picture,
// the tray, flying jewels, and exported images.

const spriteCache = new Map();
const urlCache = new Map();

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(hex, target, t) {
  const a = hexToRgb(hex);
  const b = typeof target === 'string' ? hexToRgb(target) : target;
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

export function isLight(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

// Draws an octagonal cut gem lit from the upper left into a square of size s.
export function drawJewel(ctx, x, y, s, color) {
  const k = s * 0.07;
  const cut = s * 0.28;
  const outer = [
    [cut, k],
    [s - cut, k],
    [s - k, cut],
    [s - k, s - cut],
    [s - cut, s - k],
    [cut, s - k],
    [k, s - cut],
    [k, cut],
  ].map(([px, py]) => [x + px, y + py]);
  const cx = x + s / 2;
  const cy = y + s / 2;
  const inner = outer.map(([px, py]) => [cx + (px - cx) * 0.56, cy + (py - cy) * 0.56]);
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
  };

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.08;
  ctx.shadowOffsetY = s * 0.04;
  poly(outer);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  const lx = -0.6;
  const ly = -0.8;
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const mx = (outer[i][0] + outer[j][0]) / 2 - cx;
    const my = (outer[i][1] + outer[j][1]) / 2 - cy;
    const len = Math.hypot(mx, my) || 1;
    const d = (mx * lx + my * ly) / len;
    poly([outer[i], outer[j], inner[j], inner[i]]);
    ctx.fillStyle = d > 0 ? mix(color, '#ffffff', d * 0.5) : mix(color, '#000000', -d * 0.38);
    ctx.fill();
  }

  poly(inner);
  const g = ctx.createLinearGradient(inner[7][0], inner[0][1], inner[3][0], inner[4][1]);
  g.addColorStop(0, mix(color, '#ffffff', 0.32));
  g.addColorStop(1, mix(color, '#000000', 0.05));
  ctx.fillStyle = g;
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(x + s * 0.38, y + s * 0.34, s * 0.11, s * 0.06, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fill();

  poly(outer);
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.strokeStyle = mix(color, '#000000', 0.45);
  ctx.stroke();
}

// Cached sprite at a device-pixel size, for canvas drawing.
export function jewelSprite(color, px) {
  const key = `${color}|${px}`;
  let c = spriteCache.get(key);
  if (!c) {
    if (spriteCache.size > 600) spriteCache.clear();
    c = document.createElement('canvas');
    c.width = c.height = px;
    drawJewel(c.getContext('2d'), 0, 0, px, color);
    spriteCache.set(key, c);
  }
  return c;
}

// Data URL sprite for DOM jewels.
export function jewelURL(color) {
  let url = urlCache.get(color);
  if (!url) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    drawJewel(c.getContext('2d'), 0, 0, 128, color);
    url = c.toDataURL();
    urlCache.set(color, url);
  }
  return url;
}

// Full picture as a standalone canvas, for export and the gallery viewer.
export function renderPicture(pic, cell = 32) {
  const pad = cell;
  const c = document.createElement('canvas');
  c.width = pic.w * cell + pad * 2;
  c.height = pic.h * cell + pad * 2;
  const ctx = c.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 0, c.height);
  bg.addColorStop(0, '#22284d');
  bg.addColorStop(1, '#141831');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < pic.cells.length; i++) {
    const col = pic.cells[i];
    if (col < 0) continue;
    const x = i % pic.w;
    const y = (i - x) / pic.w;
    ctx.drawImage(jewelSprite(pic.palette[col].color, cell), pad + x * cell, pad + y * cell);
  }
  return c;
}
