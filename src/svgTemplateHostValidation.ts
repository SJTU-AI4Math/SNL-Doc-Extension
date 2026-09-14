import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'use', 'symbol', 'clipPath', 'mask', 'linearGradient', 'radialGradient',
  'stop', 'pattern', 'title', 'desc',
]);
const TEXT_CONTAINERS = new Set(['text', 'tspan', 'title', 'desc']);
const ALLOWED_ATTRIBUTES = new Set([
  'aria-hidden', 'class', 'clip-path', 'clip-rule', 'color', 'cx', 'cy', 'd', 'data-snl-slot',
  'display', 'dominant-baseline', 'dx', 'dy', 'fill', 'fill-opacity', 'fill-rule', 'focusable',
  'font-family', 'font-size', 'font-style', 'font-weight', 'gradientTransform', 'gradientUnits',
  'height', 'href', 'id', 'mask', 'maskContentUnits', 'maskUnits', 'offset', 'opacity', 'overflow',
  'patternContentUnits', 'patternTransform', 'patternUnits', 'points', 'preserveAspectRatio', 'r',
  'rect', 'role', 'rx', 'ry', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-width',
  'text-anchor', 'transform', 'vector-effect', 'viewBox', 'visibility', 'width', 'x', 'x1', 'x2',
  'xml:space', 'y', 'y1', 'y2',
]);
const SAFE_STYLE_PROPERTIES = new Set([
  'clip-path', 'mask', 'fill', 'stroke', 'color', 'opacity', 'fill-opacity', 'stroke-opacity',
  'stop-color', 'stop-opacity', 'stroke-width', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'fill-rule', 'clip-rule', 'display', 'visibility', 'vector-effect',
  'text-anchor', 'dominant-baseline', 'font-size', 'font-style', 'font-weight',
]);
const LOCAL_URL_ONLY = new Set(['clip-path', 'mask']);
const PAINT_OR_URL = new Set(['fill', 'stroke']);
const SAFE_LOCAL_ID = /^[A-Za-z_][\w:.-]*$/;
const CSS_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const CSS_LENGTH = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:%|px|pt|pc|mm|cm|in|em|ex)?$/;

function reject(message: string): never { throw new Error(message); }
function rejectCssEscape(value: string, context: string): void {
  if (value.includes('\\')) reject(`SVG template ${context} must not contain CSS escapes.`);
}
function localUrl(value: string, name: string): void {
  const trimmed = value.trim();
  rejectCssEscape(trimmed, name);
  if (trimmed !== 'none' && !/^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/.test(trimmed)) {
    reject(`SVG template ${name} must use only local url(#id) references.`);
  }
}
function paint(value: string, name: string): void {
  const trimmed = value.trim();
  rejectCssEscape(trimmed, name);
  if (/^url\s*\(/i.test(trimmed)) return localUrl(trimmed, name);
  if (/^(?:none|currentColor|transparent)$/i.test(trimmed)) return;
  if (/^#[0-9a-f]{3,4}(?:[0-9a-f]{3,4})?$/i.test(trimmed)) return;
  if (/^[a-z][a-z0-9-]*$/i.test(trimmed)) return;
  reject(`SVG template ${name} contains an unsupported paint value.`);
}
function opacity(value: string, name: string): void {
  const trimmed = value.trim();
  if (!CSS_NUMBER.test(trimmed)) reject(`SVG template ${name} must be numeric.`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) reject(`SVG template ${name} must be between 0 and 1.`);
}
function styleValue(name: string, value: string): void {
  const trimmed = value.trim();
  rejectCssEscape(trimmed, `style property "${name}"`);
  if (PAINT_OR_URL.has(name) || name === 'color' || name === 'stop-color') return paint(trimmed, name);
  if (LOCAL_URL_ONLY.has(name)) return localUrl(trimmed, name);
  if (name.endsWith('opacity') || name === 'opacity') return opacity(trimmed, name);
  if (name === 'stroke-width' || name === 'stroke-dashoffset' || name === 'font-size') {
    if (!CSS_LENGTH.test(trimmed)) reject(`SVG template style property "${name}" must be a safe length.`);
    return;
  }
  const keywords: Record<string, RegExp> = {
    'stroke-linecap': /^(?:butt|round|square)$/,
    'stroke-linejoin': /^(?:miter|round|bevel)$/,
    'fill-rule': /^(?:nonzero|evenodd)$/,
    'clip-rule': /^(?:nonzero|evenodd)$/,
    display: /^(?:inline|none)$/,
    visibility: /^(?:visible|hidden|collapse)$/,
    'vector-effect': /^(?:none|non-scaling-stroke)$/,
    'text-anchor': /^(?:start|middle|end)$/,
    'dominant-baseline': /^[a-z-]+$/,
    'font-style': /^(?:normal|italic|oblique)$/,
    'font-weight': /^(?:normal|bold|[1-9]00)$/,
  };
  if (!keywords[name]?.test(trimmed)) reject(`SVG template style property "${name}" contains an unsupported value.`);
}
function style(value: string): void {
  rejectCssEscape(value, 'style attribute');
  for (const part of value.split(';').map((item) => item.trim()).filter(Boolean)) {
    const colon = part.indexOf(':');
    if (colon <= 0 || part.indexOf(':', colon + 1) >= 0) reject('SVG template style attribute is malformed.');
    const name = part.slice(0, colon).trim();
    const cssValue = part.slice(colon + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(name) || !cssValue) reject(`SVG template style property "${name}" is not supported.`);
    styleValue(name, cssValue);
  }
}
function viewBox(value: string): void {
  const number = '[+-]?(?:\\d+|\\d*\\.\\d+)(?:[eE][+-]?\\d+)?';
  const wsp = '[ \\t\\r\\n]';
  const commaWsp = `(?:${wsp}+,?${wsp}*|,${wsp}*)`;
  const match = new RegExp(`^${wsp}*(${number})${commaWsp}(${number})${commaWsp}(${number})${commaWsp}(${number})${wsp}*$`).exec(value);
  if (!match) reject('SVG template viewBox is invalid.');
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) reject('SVG template viewBox is invalid.');
}
function validateAttribute(attr: SaxesAttributeNS): void {
  const name = attr.name;
  if (attr.uri === 'http://www.w3.org/2000/xmlns/') return;
  rejectCssEscape(attr.value, `attribute "${name}"`);
  if (name.startsWith('on')) reject(`SVG template event attribute "${name}" is not allowed.`);
  if (attr.prefix && name !== 'xml:space' && name !== 'xlink:href') reject(`SVG template attribute namespace "${name}" is not allowed.`);
  if (attr.uri && attr.uri !== XLINK_NS && attr.uri !== XML_NS) reject(`SVG template attribute namespace "${name}" is not allowed.`);
  if (attr.uri === XML_NS) {
    if (name !== 'xml:space' || (attr.value !== 'default' && attr.value !== 'preserve')) reject('SVG template xml:space is invalid.');
    return;
  }
  if (name === 'style') return style(attr.value);
  if (!ALLOWED_ATTRIBUTES.has(name) && name !== 'xlink:href') reject(`SVG template attribute "${name}" is not supported.`);
  if (name === 'href' || name === 'xlink:href') {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(attr.value.trim()) || attr.value.includes('\\')) reject('SVG template href must be a local fragment reference.');
    return;
  }
  if (name === 'data-snl-slot') {
    if (!/^(0|[1-9]\d?)$/.test(attr.value)) reject('SVG template slot marker is invalid.');
    return;
  }
  if (LOCAL_URL_ONLY.has(name)) return localUrl(attr.value, name);
  if (PAINT_OR_URL.has(name) || name === 'color' || name === 'stop-color') return paint(attr.value, name);
  if (/\b(?:javascript:|data:|https?:|file:|ftp:)\b/i.test(attr.value)) reject(`SVG template attribute "${name}" contains an external URL.`);
}

/** Node-host trust boundary for SVG templates received from a webview. */
export function validateSvgTemplateForPersistence(source: string): void {
  if (!source.trim()) reject('SVG template must not be empty.');
  const stack: Array<{ local: string; slot: boolean; childCount: number }> = [];
  const ids = new Set<string>();
  const references: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let rootViewBox = '';
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => reject('SVG template document types are not allowed.'));
  parser.on('processinginstruction', () => reject('SVG template processing instructions are not allowed.'));
  parser.on('opentag', (tag: SaxesTagNS) => {
    if (rootClosed) reject('SVG template must contain exactly one root element.');
    const parent = stack.at(-1);
    if (parent) parent.childCount += 1;
    if (tag.uri !== SVG_NS || tag.prefix) reject(`SVG template element "${tag.name}" must stay in the SVG namespace.`);
    if (!ALLOWED_ELEMENTS.has(tag.local)) reject(`SVG template element "${tag.local}" is not supported.`);
    if (!rootSeen) {
      if (tag.local !== 'svg') reject('SVG template must have an <svg> root.');
      rootSeen = true;
    }
    for (const attr of Object.values(tag.attributes)) {
      validateAttribute(attr);
      if (attr.name === 'id') {
        if (!SAFE_LOCAL_ID.test(attr.value) || ids.has(attr.value)) reject('SVG template contains an invalid or duplicate id.');
        ids.add(attr.value);
      }
      if (attr.name === 'href' || attr.name === 'xlink:href') references.push(attr.value.trim().slice(1));
      for (const match of attr.value.matchAll(/url\(\s*#([A-Za-z_][\w:.-]*)\s*\)/g)) references.push(match[1]);
      if (!parent && attr.name === 'viewBox') rootViewBox = attr.value.trim();
    }
    const slot = Object.values(tag.attributes).some((attr) => attr.name === 'data-snl-slot');
    if (slot && tag.local !== 'g') reject('SVG template slot anchors must be <g> elements.');
    stack.push({ local: tag.local, slot, childCount: 0 });
  });
  parser.on('text', (text: string) => {
    const parent = stack.at(-1);
    if (text.trim() && (!parent || !TEXT_CONTAINERS.has(parent.local))) reject('SVG template contains text outside supported text elements.');
    if (parent && text.length > 0) parent.childCount += 1;
  });
  parser.on('comment', () => { const parent = stack.at(-1); if (parent) parent.childCount += 1; });
  parser.on('cdata', () => { const parent = stack.at(-1); if (!parent || !TEXT_CONTAINERS.has(parent.local)) reject('SVG template contains CDATA outside supported text elements.'); if (parent) parent.childCount += 1; });
  parser.on('closetag', () => {
    const closed = stack.pop();
    if (!closed) reject('SVG template close tag is unbalanced.');
    if (closed.slot && closed.childCount !== 0) reject('SVG template slot <g> anchors must be empty.');
    if (stack.length === 0) rootClosed = true;
  });
  parser.on('error', (reason: Error) => { throw reason; });
  parser.write(source).close();
  if (!rootSeen || !rootClosed || stack.length !== 0) reject('SVG template is not well-formed XML.');
  if (!rootViewBox) reject('SVG template must declare a non-empty viewBox.');
  viewBox(rootViewBox);
  for (const reference of references) if (!ids.has(reference)) reject(`SVG template local fragment target "#${reference}" does not exist.`);
}
