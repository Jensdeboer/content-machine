'use strict';
// Loads brands/<brand>/design/01-tokens/tokens.json and exposes every value by
// role name. Nothing else in the renderer holds a colour or a pixel size.
const fs = require('fs');
const path = require('path');

function loadTokens(brandDir) {
  const file = path.join(brandDir, 'design', '01-tokens', 'tokens.json');
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Tokens(t, file);
}

class Tokens {
  constructor(raw, file) {
    this.raw = raw;
    this.file = file;
    this.canvas = raw.canvas;
    this.safe = raw.canvas.safe;
    this.margin = raw.canvas.margin;
    this.footerHeight = raw.canvas.footer.height;
    // Size steps, largest first, as [name, px].
    this.sizeSteps = Object.entries(raw.size)
      .filter(([k]) => !k.startsWith('$'))
      .sort((a, b) => b[1] - a[1]);
    this.floor = raw.size.floor;
    this.spaceScale = raw.space.scale.slice();
  }

  color(role) {
    const c = this.raw.color[role];
    if (!c) throw new Error(`tokens: no colour role "${role}"`);
    if (c.type === 'gradient') return this.gradientCss(c.gradient);
    return c.value;
  }

  gradientCss(g) {
    const stops = g.stops.map((s) => `${s.value} ${s.position}`).join(', ');
    return `radial-gradient(${g.shape} ${g.size} at ${g.position}, ${stops})`;
  }

  size(step) {
    const v = this.raw.size[step];
    if (typeof v !== 'number') throw new Error(`tokens: no size step "${step}"`);
    return v;
  }

  sizeName(px) {
    const hit = this.sizeSteps.find(([, v]) => v === px);
    return hit ? hit[0] : null;
  }

  // The next smaller step below `step`, or null at the floor.
  stepDown(step) {
    const i = this.sizeSteps.findIndex(([k]) => k === step);
    if (i < 0 || i === this.sizeSteps.length - 1) return null;
    return this.sizeSteps[i + 1][0];
  }

  space(n) {
    if (!this.spaceScale.includes(n)) throw new Error(`tokens: ${n} is not on the space scale`);
    return n;
  }

  font(role) {
    const f = this.raw.type[role];
    return `'${f.family}', ${f.fallback}`;
  }

  weight(role, name) {
    return this.raw.type[role].weights[name];
  }

  tracking(name) {
    return this.raw.type.display.tracking[name] ?? this.raw.type.data.tracking[name];
  }

  leading(role, name) {
    return this.raw.type[role].leading[name];
  }

  // CSS custom properties in the same naming as 01-tokens/tokens.css, generated
  // from tokens.json so the json stays the single source of truth.
  cssVars() {
    const r = this.raw;
    const lines = [];
    for (const [k, c] of Object.entries(r.color)) lines.push(`--pv-color-${k}: ${this.color(k)};`);
    lines.push(`--pv-font-display: ${this.font('display')};`);
    lines.push(`--pv-font-body: ${this.font('body')};`);
    lines.push(`--pv-font-data: ${this.font('data')};`);
    lines.push(`--pv-weight-display-bold: ${r.type.display.weights.bold};`);
    lines.push(`--pv-weight-display-semi: ${r.type.display.weights.semi};`);
    lines.push(`--pv-weight-body: ${r.type.body.weights.regular};`);
    lines.push(`--pv-weight-body-light: ${r.type.body.weights['light-italic']};`);
    lines.push(`--pv-weight-data: ${r.type.data.weights.medium};`);
    for (const [k, v] of Object.entries(r.type.display.tracking)) lines.push(`--pv-track-${k}: ${v};`);
    for (const [k, v] of Object.entries(r.type.data.tracking)) lines.push(`--pv-track-${k}: ${v};`);
    for (const [k, v] of Object.entries(r.type.display.leading)) lines.push(`--pv-lead-${k}: ${v};`);
    for (const [k, v] of Object.entries(r.type.body.leading)) lines.push(`--pv-lead-${k}: ${v};`);
    for (const [k, v] of this.sizeSteps) lines.push(`--pv-size-${k}: ${v}px;`);
    for (const v of r.space.scale) lines.push(`--pv-space-${v}: ${v}px;`);
    lines.push(`--pv-canvas-width: ${r.canvas.width}px;`);
    lines.push(`--pv-canvas-height: ${r.canvas.height}px;`);
    lines.push(`--pv-margin: ${r.canvas.margin}px;`);
    lines.push(`--pv-safe-x: ${r.canvas.safe.x}px;`);
    lines.push(`--pv-safe-y: ${r.canvas.safe.y}px;`);
    lines.push(`--pv-safe-width: ${r.canvas.safe.width}px;`);
    lines.push(`--pv-safe-height: ${r.canvas.safe.height}px;`);
    lines.push(`--pv-footer-height: ${r.canvas.footer.height}px;`);
    return `:root{\n  ${lines.join('\n  ')}\n}`;
  }
}

module.exports = { loadTokens, Tokens };
