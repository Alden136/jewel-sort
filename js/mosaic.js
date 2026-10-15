// Mosaic canvas: draws empty sockets and placed jewels, reports taps on
// cells, and handles two-finger pinch, one-finger pan when zoomed, and
// wheel zoom.

import { jewelSprite, mix } from './jewels.js';

const MAX_ZOOM = 6;
const SOCKET_BG = '#1a1f3d';

export class MosaicView {
  constructor(canvas, { onZoom, onTap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onZoom = onZoom;
    this.onTap = onTap;
    this.highlight = null; // color whose empty cells glow as drop targets
    this.flashes = new Map(); // cell -> end time, for hints
    this.pic = null;
    this.filled = new Set();
    this.pending = new Set(); // committed cells whose jewel is still in flight
    this.showPreview = true;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.pops = new Map();
    this.sparkles = [];
    this.frame = 0;
    this.pointers = new Map();
    this.pinch = null;
    this.cssW = 0;
    this.cssH = 0;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bindGestures();
  }

  setPicture(pic, filled) {
    this.pic = pic;
    this.filled = filled;
    this.pops.clear();
    this.sparkles = [];
    this.fit();
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cssW = r.width;
    this.cssH = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.clamp();
    this.draw();
  }

  get baseCell() {
    if (!this.pic) return 1;
    return Math.max(1, Math.min((this.cssW - 20) / this.pic.w, (this.cssH - 20) / this.pic.h));
  }

  get cell() {
    return this.baseCell * this.scale;
  }

  origin() {
    const c = this.cell;
    return [(this.cssW - this.pic.w * c) / 2 + this.ox, (this.cssH - this.pic.h * c) / 2 + this.oy];
  }

  // Viewport rectangle of a cell, for animations that land on the picture.
  cellRect(i) {
    const r = this.canvas.getBoundingClientRect();
    const [x0, y0] = this.origin();
    const c = this.cell;
    const x = i % this.pic.w;
    const y = (i - x) / this.pic.w;
    return { left: r.left + x0 + x * c, top: r.top + y0 + y * c, width: c, height: c };
  }

  fit() {
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.onZoom?.(false);
    this.draw();
  }

  zoomAt(px, py, scale) {
    const s = Math.min(MAX_ZOOM, Math.max(1, scale));
    const [x0, y0] = this.origin();
    const wx = (px - x0) / this.cell;
    const wy = (py - y0) / this.cell;
    this.scale = s;
    const c = this.cell;
    this.ox = px - wx * c - (this.cssW - this.pic.w * c) / 2;
    this.oy = py - wy * c - (this.cssH - this.pic.h * c) / 2;
    this.clamp();
    this.onZoom?.(this.scale > 1.01);
    this.draw();
  }

  clamp() {
    if (!this.pic) return;
    const c = this.cell;
    const mx = Math.max(0, (this.pic.w * c - this.cssW) / 2 + 24);
    const my = Math.max(0, (this.pic.h * c - this.cssH) / 2 + 24);
    const zoomed = this.scale > 1.01;
    this.ox = zoomed ? Math.min(mx, Math.max(-mx, this.ox)) : 0;
    this.oy = zoomed ? Math.min(my, Math.max(-my, this.oy)) : 0;
  }

  // Cell under a canvas-local point, or -1.
  cellAt(px, py) {
    const [x0, y0] = this.origin();
    const c = this.cell;
    const x = Math.floor((px - x0) / c);
    const y = Math.floor((py - y0) / c);
    if (x < 0 || y < 0 || x >= this.pic.w || y >= this.pic.h) return -1;
    return y * this.pic.w + x;
  }

  // Nearest cell passing `test` within `radius` cells of a point, so small
  // cells stay easy to hit with a finger.
  nearestCell(px, py, test, radius = 1.6) {
    const [x0, y0] = this.origin();
    const c = this.cell;
    const fx = (px - x0) / c - 0.5;
    const fy = (py - y0) / c - 0.5;
    let best = -1;
    let bestD = radius * radius;
    const r = Math.ceil(radius);
    for (let y = Math.round(fy) - r; y <= Math.round(fy) + r; y++) {
      for (let x = Math.round(fx) - r; x <= Math.round(fx) + r; x++) {
        if (x < 0 || y < 0 || x >= this.pic.w || y >= this.pic.h) continue;
        const i = y * this.pic.w + x;
        const d = (x - fx) ** 2 + (y - fy) ** 2;
        if (d <= bestD && test(i)) [best, bestD] = [i, d];
      }
    }
    return best;
  }

  flash(cells, ms = 2400) {
    const end = performance.now() + ms;
    for (const c of cells) this.flashes.set(c, end);
    this.draw();
  }

  pop(cell) {
    this.pops.set(cell, performance.now());
    this.draw();
  }

  sparkle(count = 46) {
    const cells = [...this.filled];
    const now = performance.now();
    for (let i = 0; i < count && cells.length; i++) {
      this.sparkles.push({
        cell: cells[(Math.random() * cells.length) | 0],
        start: now + Math.random() * 1400,
        life: 700 + Math.random() * 500,
        size: 0.5 + Math.random() * 0.6,
      });
    }
    this.draw();
  }

  draw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  paint() {
    const { ctx, pic } = this;
    if (!pic || !this.cssW) return;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const c = this.cell;
    const [x0, y0] = this.origin();
    const now = performance.now();
    let animating = false;

    // Soft board behind the picture.
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    roundRect(ctx, x0 - c * 0.3, y0 - c * 0.3, pic.w * c + c * 0.6, pic.h * c + c * 0.6, Math.min(16, c * 0.6));
    ctx.fill();

    const spritePx = Math.max(4, Math.round((c * dpr) / 4) * 4);
    const glow = 0.55 + 0.45 * Math.sin(now / 180);
    if (this.highlight !== null) animating = true;
    for (const [cell, end] of this.flashes) if (now > end) this.flashes.delete(cell);
    if (this.flashes.size) animating = true;
    const labels = this.showPreview && c >= 18;
    if (labels) {
      ctx.font = `700 ${Math.round(c * 0.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }
    for (let i = 0; i < pic.cells.length; i++) {
      const col = pic.cells[i];
      if (col < 0) continue;
      const x = x0 + (i % pic.w) * c;
      const y = y0 + Math.floor(i / pic.w) * c;
      if (x > this.cssW || y > this.cssH || x + c < 0 || y + c < 0) continue;
      const color = pic.palette[col].color;
      if (this.filled.has(i) && !this.pending.has(i)) {
        let s = c;
        const t0 = this.pops.get(i);
        if (t0 !== undefined) {
          const t = (now - t0) / 260;
          if (t >= 1) this.pops.delete(i);
          else {
            s = c * (1 + 0.28 * Math.sin(t * Math.PI));
            animating = true;
          }
        }
        ctx.drawImage(jewelSprite(color, spritePx), x + (c - s) / 2, y + (c - s) / 2, s, s);
      } else {
        const g = c * 0.14;
        // While a color is picked up, other colors' spots step back.
        const dim = this.highlight !== null && col !== this.highlight;
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.fillStyle = this.showPreview ? mix(color, SOCKET_BG, 0.68) : 'rgba(255,255,255,0.07)';
        roundRect(ctx, x + g, y + g, c - g * 2, c - g * 2, c * 0.22);
        ctx.fill();
        if (labels) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillText(pic.palette[col].label, x + c / 2, y + c / 2 + 1);
        }
        ctx.globalAlpha = 1;
        const target = col === this.highlight && !this.filled.has(i);
        if (target || this.flashes.has(i)) {
          ctx.save();
          ctx.globalAlpha = target ? glow : 1;
          ctx.lineWidth = Math.max(1.5, c * 0.1);
          ctx.strokeStyle = this.flashes.has(i) ? '#ffffff' : mix(color, '#ffffff', 0.55);
          ctx.shadowColor = color;
          ctx.shadowBlur = c * 0.5;
          roundRect(ctx, x + g * 0.6, y + g * 0.6, c - g * 1.2, c - g * 1.2, c * 0.24);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    if (this.sparkles.length) {
      this.sparkles = this.sparkles.filter((s) => now < s.start + s.life);
      for (const s of this.sparkles) {
        const t = (now - s.start) / s.life;
        if (t < 0) continue;
        const x = x0 + (s.cell % pic.w) * c + c / 2;
        const y = y0 + Math.floor(s.cell / pic.w) * c + c / 2;
        drawSparkle(ctx, x, y, c * s.size * Math.sin(t * Math.PI), 1 - t);
      }
      animating = animating || this.sparkles.length > 0;
    }
    if (animating) this.draw();
  }

  bindGestures() {
    const cv = this.canvas;
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const pinchState = () => {
      const [a, b] = [...this.pointers.values()];
      return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    };
    let tap = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.pic) return;
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      tap = this.pointers.size === 1 ? { id: e.pointerId, x: p[0], y: p[1] } : null;
      if (this.pointers.size === 2) this.pinch = { ...pinchState(), scale: this.scale };
    });
    cv.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      this.pointers.set(e.pointerId, p);
      if (tap && Math.hypot(p[0] - tap.x, p[1] - tap.y) > 8) tap = null;
      if (this.pointers.size >= 2 && this.pinch) {
        const now = pinchState();
        const [mx, my] = this.pinch.mid;
        this.zoomAt(mx, my, (this.pinch.scale * now.dist) / this.pinch.dist);
        this.ox += now.mid[0] - mx;
        this.oy += now.mid[1] - my;
        this.pinch.mid = now.mid;
        this.clamp();
        this.draw();
      } else if (this.pointers.size === 1 && this.scale > 1.01) {
        this.ox += p[0] - prev[0];
        this.oy += p[1] - prev[1];
        this.clamp();
        this.draw();
      }
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    cv.addEventListener('pointerup', (e) => {
      const wasTap = tap && tap.id === e.pointerId;
      end(e);
      if (wasTap) {
        tap = null;
        this.onTap?.(...local(e));
      }
    });
    cv.addEventListener('pointercancel', (e) => {
      tap = null;
      end(e);
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        if (!this.pic) return;
        e.preventDefault();
        const [x, y] = local(e);
        this.zoomAt(x, y, this.scale * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0, r));
}

function drawSparkle(ctx, x, y, r, alpha) {
  if (r <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.fillStyle = '#fffbe8';
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
  ctx.restore();
}
