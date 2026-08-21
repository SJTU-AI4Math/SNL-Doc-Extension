import React, { useEffect, useRef, useState } from 'react';
import { parseSanitizedSvgTemplate } from '@sjtu-ai4math/snl-basics';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { getVsCodeApi, type VsCodeApi } from '../vscodeApi';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { createWorkspaceSvgAssetLoader } from '../runtime/svgTemplateAssetBridge';
import './svg-macro-editor.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAINTED_SELECTOR = 'path,rect,circle,ellipse,line,polyline,polygon,text,use,image';
const NON_PAINTED_ANCESTOR = 'defs,clipPath,mask,marker,pattern,symbol';

type MatrixLike = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;

export interface ExistingSvgProjection {
  asset?: { source?: unknown; base_identity?: unknown; revision?: unknown };
  editor?: { source?: unknown; source_revision?: unknown };
  accessibility?: { label?: unknown };
}

export interface SvgMacroEditorProps {
  api?: Pick<VsCodeApi, 'postMessage'>;
  editorIdentity?: string;
  initialProjection?: ExistingSvgProjection;
  onTemplateChange(template: string): void;
  onDirty?(): void;
  onProjectionChange?(projection: Record<string, unknown>, requiredArity: number): void;
}

let requestSequence = 0;

type PendingSave = { requestId: string; editorIdentity?: string; slug: string; label: string; operationsJson: string; sourceSvg: string; templateSvg: string; requiredArity: number; expected: { templatePath: string; templateRevision: string; sourcePath: string; sourceRevision: string; manifestPath: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function decodeWrittenProjection(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !exactKeys(value, ['asset', 'generation', 'producer_revision', 'accessibility', 'editor'])) return null;
  const asset = value.asset;
  const accessibility = value.accessibility;
  const editor = value.editor;
  if (!isRecord(asset) || !exactKeys(asset, ['source', 'base_identity', 'revision', 'request_epoch'])) return null;
  if (!isRecord(accessibility) || !exactKeys(accessibility, ['label'])) return null;
  if (!isRecord(editor) || !exactKeys(editor, ['source', 'source_revision', 'manifest'])) return null;
  const digest = /^sha256:[a-f0-9]{64}$/;
  const templatePath = /^svg\/[A-Za-z0-9][A-Za-z0-9._-]*\.template\.[a-f0-9]{64}\.svg$/;
  const sourcePath = /^svg\/[A-Za-z0-9][A-Za-z0-9._-]*\.source\.[a-f0-9]{64}\.svg$/;
  const manifestPath = /^svg\/[A-Za-z0-9][A-Za-z0-9._-]*\.manifest\.[a-f0-9]{64}\.json$/;
  if (typeof asset.source !== 'string' || !templatePath.test(asset.source)
      || asset.base_identity !== 'workspace:.SNL_Doc/assets'
      || typeof asset.revision !== 'string' || !digest.test(asset.revision)
      || asset.request_epoch !== 0 || value.generation !== 1
      || value.producer_revision !== 'snl-doc-extension-svg-editor:v1'
      || typeof accessibility.label !== 'string' || accessibility.label.trim().length < 1 || accessibility.label.length > 500
      || typeof editor.source !== 'string' || !sourcePath.test(editor.source)
      || typeof editor.source_revision !== 'string' || !digest.test(editor.source_revision)
      || typeof editor.manifest !== 'string' || !manifestPath.test(editor.manifest)) return null;
  return value;
}

function digestText(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function expectedProjectionIdentity(slug: string, sourceSvg: string, templateSvg: string, operations: unknown[]): PendingSave['expected'] {
  const sourceDigest = digestText(sourceSvg);
  const templateDigest = digestText(templateSvg);
  const sourcePath = `svg/${slug}.source.${sourceDigest}.svg`;
  const templatePath = `svg/${slug}.template.${templateDigest}.svg`;
  const manifest = `${JSON.stringify({
    version: 1,
    compiler: 'snl-doc-extension-svg-editor:v1',
    source: sourcePath,
    source_revision: `sha256:${sourceDigest}`,
    output: templatePath,
    output_revision: `sha256:${templateDigest}`,
    operations
  }, null, 2)}\n`;
  return {
    templatePath,
    templateRevision: `sha256:${templateDigest}`,
    sourcePath,
    sourceRevision: `sha256:${sourceDigest}`,
    manifestPath: `svg/${slug}.manifest.${digestText(manifest)}.json`
  };
}

function projectionMatchesPending(projection: Record<string, unknown>, pending: PendingSave): boolean {
  const asset = projection.asset as Record<string, unknown>;
  const editor = projection.editor as Record<string, unknown>;
  const accessibility = projection.accessibility as Record<string, unknown>;
  return asset.source === pending.expected.templatePath
    && asset.revision === pending.expected.templateRevision
    && editor.source === pending.expected.sourcePath
    && editor.source_revision === pending.expected.sourceRevision
    && editor.manifest === pending.expected.manifestPath
    && accessibility.label === pending.label;
}

const SVG_EDITOR_MESSAGES = defineUiMessages(
  'svgMacroEditor',
  {
    editor: 'SVG Macro editor', importFile: 'Import SVG file', source: 'SVG source', load: 'Load SVG preview', reloadRequired: 'Reload the SVG preview before saving this edited source.',
    selectedOne: '1 painted occurrence selected', selectedMany: '{count} painted occurrences selected',
    slotIndex: 'Slot index', selectGroup: 'Select parent group', replaceSlot: 'Replace selection with slot',
    selectedForeground: 'Map selected paint to foreground', exactColor: 'Exact color key',
    exactForeground: 'Map exact color to foreground', paperKnockout: 'Map exact color to paper knockout',
    assetName: 'Asset name', accessibility: 'Accessibility label', save: 'Save SVG Macro Asset', saved: 'SVG Macro Asset saved.',
    loadFailed: 'Could not load the existing SVG Macro Assets.', invalidSvg: 'The SVG source is invalid or unsafe.',
    importInvalid: 'Imported SVG must be a .svg file no larger than 1 MiB.', importReadFailed: 'Could not read the imported SVG file.', importText: 'Imported SVG must be UTF-8 text.',
    saveFailed: 'Could not save SVG Macro Assets.', invalidReply: 'The SVG Macro Asset host returned an invalid response.', changedWhileSaving: 'The SVG changed while it was being saved. Save it again.',
    colorRequired: 'Exact color key is required.', colorNoMatch: 'Exact color key did not match any authored fill or stroke.', paperFailed: 'Paper knockout could not be compiled safely.', transformFailed: 'The selected paint transformation could not be applied safely.',
    slotInvalid: 'Slot index must be a non-negative integer.', slotParents: 'Multi-selection must stay inside the same painter group.', slotFailed: 'The selection could not be replaced with a slot safely.',
    bridgeUnavailable: 'VS Code Asset bridge is unavailable.', assetFieldsRequired: 'Asset name and accessibility label are required.'
  },
  {
    editor: 'SVG 宏编辑器', importFile: '导入 SVG 文件', source: 'SVG 源码', load: '载入 SVG 预览', reloadRequired: '源码已修改，请重新载入 SVG 预览后再保存。',
    selectedOne: '已选择 1 个绘制对象', selectedMany: '已选择 {count} 个绘制对象',
    slotIndex: 'Slot 索引', selectGroup: '选择父级分组', replaceSlot: '将所选对象替换为 Slot',
    selectedForeground: '将所选绘制颜色映射为前景色', exactColor: '精确色键',
    exactForeground: '将精确色映射为前景色', paperKnockout: '将精确色映射为纸张镂空',
    assetName: 'Asset 名称', accessibility: '无障碍标签', save: '保存 SVG 宏 Asset', saved: 'SVG 宏 Asset 已保存。',
    loadFailed: '无法载入已有的 SVG 宏 Assets。', invalidSvg: 'SVG 源码无效或不安全。',
    importInvalid: '导入文件必须是不超过 1 MiB 的 .svg 文件。', importReadFailed: '无法读取导入的 SVG 文件。', importText: '导入的 SVG 必须是 UTF-8 文本。',
    saveFailed: '无法保存 SVG 宏 Assets。', invalidReply: 'SVG 宏 Asset 宿主返回了无效响应。', changedWhileSaving: '保存期间 SVG 已发生变化，请重新保存。',
    colorRequired: '必须填写精确色键。', colorNoMatch: '精确色键未匹配任何已编写的填充或描边。', paperFailed: '无法安全编译纸张镂空。', transformFailed: '无法安全应用所选绘制对象的变换。',
    slotInvalid: 'Slot 索引必须是非负整数。', slotParents: '多选对象必须位于同一个绘制分组中。', slotFailed: '无法安全地将所选对象替换为 Slot。',
    bridgeUnavailable: 'VS Code Asset 桥接不可用。', assetFieldsRequired: '必须填写 Asset 名称和无障碍标签。'
  }
);

function transformPoint(matrix: MatrixLike, x: number, y: number): { x: number; y: number } {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function inversePoint(matrix: MatrixLike, x: number, y: number): { x: number; y: number } {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('Selected artwork uses a non-invertible transform.');
  }
  const dx = x - matrix.e;
  const dy = y - matrix.f;
  return {
    x: (matrix.d * dx - matrix.c * dy) / determinant,
    y: (-matrix.b * dx + matrix.a * dy) / determinant
  };
}

function selectionCenter(elements: SVGGraphicsElement[]): { x: number; y: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const box = element.getBBox();
    const matrix = element.getCTM();
    if (!matrix) throw new Error('Selected artwork is detached from the SVG viewport.');
    for (const [x, y] of [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height]
    ]) {
      const point = transformPoint(matrix, x, y);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error('Selected artwork has no measurable painted bounds.');
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

type PaintChannel = 'fill' | 'stroke';

function matchingPaintChannels(element: SVGElement, expected: string): PaintChannel[] {
  const channels: PaintChannel[] = [];
  const style = element.getAttribute('style') ?? '';
  const declarations = new Map(style.split(';').flatMap((declaration) => {
    const separator = declaration.indexOf(':');
    return separator < 0 ? [] : [[declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim().toLowerCase()]];
  }));
  for (const channel of ['fill', 'stroke'] as const) {
    if (element.getAttribute(channel)?.trim().toLowerCase() === expected || declarations.get(channel) === expected) channels.push(channel);
  }
  return channels;
}

function setPaintChannels(element: SVGElement, channels: PaintChannel[], value: string): void {
  const selected = new Set(channels);
  const style = element.getAttribute('style');
  if (style) {
    const remaining = style.split(';').filter((declaration) => {
      const name = declaration.slice(0, Math.max(0, declaration.indexOf(':'))).trim().toLowerCase();
      return !selected.has(name as PaintChannel);
    }).filter(Boolean);
    if (remaining.length) element.setAttribute('style', remaining.join(';'));
    else element.removeAttribute('style');
  }
  for (const channel of channels) element.setAttribute(channel, value);
}

function removeIds(root: SVGElement): void {
  root.removeAttribute('id');
  root.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
}

function assertSplittableAncestors(root: SVGSVGElement, target: SVGElement): void {
  for (let ancestor = target.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    const style = ancestor.getAttribute('style') ?? '';
    if (ancestor.hasAttribute('filter') || ancestor.hasAttribute('mask') ||
        (ancestor.hasAttribute('opacity') && ancestor.getAttribute('opacity') !== '1') ||
        /(?:mix-blend-mode|isolation|filter|opacity)\s*:/i.test(style)) {
      throw new Error('Paper knockout cannot split artwork inside an opacity, filter, blend, or authored mask group.');
    }
  }
}

function cloneTargetInRootSpace(root: SVGSVGElement, target: SVGElement, channels: PaintChannel[]): SVGElement {
  let branch = target.cloneNode(true) as SVGElement;
  removeIds(branch);
  setPaintChannels(branch, ['fill', 'stroke'], 'none');
  setPaintChannels(branch, channels, '#000');
  for (let ancestor = target.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
    const shell = ancestor.cloneNode(false) as SVGElement;
    removeIds(shell);
    shell.append(branch);
    branch = shell;
  }
  return branch;
}

/** Move the exact painter prefix before target into one root-level group. */
function extractPainterPrefix(root: SVGSVGElement, target: SVGElement): SVGGElement | null {
  let child: Element = target;
  let nestedPrefix: SVGElement | null = null;
  for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) {
    const shell = parent.cloneNode(false) as SVGElement;
    removeIds(shell);
    const siblings = Array.from(parent.children);
    const boundary = siblings.indexOf(child);
    for (const sibling of siblings.slice(0, boundary)) shell.append(sibling);
    if (nestedPrefix) shell.append(nestedPrefix);
    nestedPrefix = shell.childElementCount > 0 ? shell : null;
    child = parent;
  }
  const prefix = document.createElementNS(SVG_NS, 'g');
  const rootChildren = Array.from(root.children);
  const boundary = rootChildren.indexOf(child);
  for (const sibling of rootChildren.slice(0, boundary)) {
    if (sibling.localName !== 'defs') prefix.append(sibling);
  }
  if (nestedPrefix) prefix.append(nestedPrefix);
  if (prefix.childElementCount === 0) return null;
  root.insertBefore(prefix, child);
  return prefix;
}

function compilePaperKnockout(root: SVGSVGElement, exactColor: string): number {
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/);
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Paper knockout requires a finite four-number viewBox.');
  }
  const targets = Array.from(root.querySelectorAll<SVGElement>(PAINTED_SELECTOR))
    .filter((element) => !element.closest(NON_PAINTED_ANCESTOR))
    .map((element) => ({ element, channels: matchingPaintChannels(element, exactColor) }))
    .filter((candidate) => candidate.channels.length > 0);
  let count = 0;
  for (const { element, channels } of targets) {
    assertSplittableAncestors(root, element);
    const knockout = cloneTargetInRootSpace(root, element, channels);
    const prefix = extractPainterPrefix(root, element);
    setPaintChannels(element, channels, 'none');
    if (!prefix) continue;
    let candidate = count;
    while (root.querySelector(`[id="snl-editor-paper-${candidate}"]`)) candidate += 1;
    const id = `snl-editor-paper-${candidate}`;
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', id);
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('x', viewBox[0]);
    mask.setAttribute('y', viewBox[1]);
    mask.setAttribute('width', viewBox[2]);
    mask.setAttribute('height', viewBox[3]);
    const coverage = document.createElementNS(SVG_NS, 'rect');
    coverage.setAttribute('x', viewBox[0]);
    coverage.setAttribute('y', viewBox[1]);
    coverage.setAttribute('width', viewBox[2]);
    coverage.setAttribute('height', viewBox[3]);
    coverage.setAttribute('fill', 'white');
    mask.append(coverage, knockout);
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.append(mask);
    root.insertBefore(defs, root.firstChild);
    prefix.setAttribute('mask', `url(#${id})`);
    count = candidate + 1;
  }
  return targets.length;
}

function serialize(root: SVGSVGElement): string {
  const clone = root.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-snl-editor-selected]').forEach((element) => element.removeAttribute('data-snl-editor-selected'));
  return new window.XMLSerializer().serializeToString(clone);
}

export function SvgMacroEditor({ api, editorIdentity, initialProjection, onTemplateChange, onDirty, onProjectionChange }: SvgMacroEditorProps): React.ReactElement {
  const t = useUiMessages(SVG_EDITOR_MESSAGES);
  const [source, setSource] = useState('');
  const [loadedSource, setLoadedSource] = useState('');
  const [fileName, setFileName] = useState('');
  const [root, setRoot] = useState<SVGSVGElement | null>(null);
  const [selected, setSelected] = useState<SVGGraphicsElement[]>([]);
  const [slotIndex, setSlotIndex] = useState('0');
  const [error, setError] = useState('');
  const [assetName, setAssetName] = useState('');
  const [accessibilityLabel, setAccessibilityLabel] = useState('');
  const [exactColor, setExactColor] = useState('#000000');
  const [operations, setOperations] = useState<unknown[]>([]);
  const [saved, setSaved] = useState(false);
  const pendingRequest = useRef<PendingSave | null>(null);
  const localEditGeneration = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const runtimeSource = initialProjection?.asset?.source;
  const runtimeBaseIdentity = initialProjection?.asset?.base_identity;
  const runtimeRevision = initialProjection?.asset?.revision;
  const authoredSource = initialProjection?.editor?.source;
  const authoredRevision = initialProjection?.editor?.source_revision;
  const initialAccessibilityLabel = initialProjection?.accessibility?.label;
  useEffect(() => {
    const host = api ?? getVsCodeApi();
    if (!host || typeof runtimeSource !== 'string' || typeof runtimeBaseIdentity !== 'string' || typeof runtimeRevision !== 'string') return;
    const controller = new AbortController();
    const hydrationGeneration = localEditGeneration.current;
    const loader = createWorkspaceSvgAssetLoader(host);
    const rawRequest = typeof authoredSource === 'string' && typeof authoredRevision === 'string'
      ? loader({ source: authoredSource, baseIdentity: runtimeBaseIdentity, revision: authoredRevision }, controller.signal)
      : Promise.resolve<string | null>(null);
    Promise.all([
      rawRequest,
      loader({ source: runtimeSource, baseIdentity: runtimeBaseIdentity, revision: runtimeRevision }, controller.signal)
    ]).then(([raw, runtime]) => {
      if (controller.signal.aborted || localEditGeneration.current !== hydrationGeneration) return;
      const parsed = parseSanitizedSvgTemplate(runtime);
      setSource(raw ?? runtime);
      setLoadedSource(raw ?? runtime);
      setRoot(parsed.root);
      setSelected([]);
      setOperations([]);
      setSaved(true);
      setError('');
      const basename = (typeof authoredSource === 'string' ? authoredSource : runtimeSource).split('/').pop() ?? '';
      setFileName(basename);
      const inferredSlug = basename.replace(/\.source\.[a-f0-9]{64}\.svg$/i, '').replace(/\.template\.[a-f0-9]{64}\.svg$/i, '');
      setAssetName(inferredSlug);
      if (typeof initialAccessibilityLabel === 'string') setAccessibilityLabel(initialAccessibilityLabel);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && localEditGeneration.current === hydrationGeneration) setError(t('loadFailed'));
    });
    return () => controller.abort();
  }, [api, authoredRevision, authoredSource, initialAccessibilityLabel, runtimeBaseIdentity, runtimeRevision, runtimeSource, t]);

  useEffect(() => {
    if (!root) return;
    root.querySelectorAll('[data-snl-editor-selected]').forEach((element) => element.removeAttribute('data-snl-editor-selected'));
    selected.forEach((element) => element.setAttribute('data-snl-editor-selected', 'true'));
  }, [root, selected]);

  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const message = event.data as { type?: unknown; requestId?: unknown; projection?: unknown; message?: unknown } | null;
      const pending = pendingRequest.current;
      if (!message || !pending || message.requestId !== pending.requestId) return;
      if (message.type === 'svgMacro.assetsError') {
        pendingRequest.current = null;
        setError(t('saveFailed'));
        return;
      }
      if (message.type !== 'svgMacro.assetsWritten') return;
      pendingRequest.current = null;
      const projection = decodeWrittenProjection(message.projection);
      if (!projection || !projectionMatchesPending(projection, pending)) {
        setError(t('invalidReply'));
        return;
      }
      const currentTemplate = root ? serialize(root) : '';
      if (editorIdentity !== pending.editorIdentity
          || assetName.trim() !== pending.slug
          || accessibilityLabel.trim() !== pending.label
          || JSON.stringify(operations) !== pending.operationsJson
          || source !== pending.sourceSvg || currentTemplate !== pending.templateSvg) {
        setError(t('changedWhileSaving'));
        return;
      }
      onProjectionChange?.(projection, pending.requiredArity);
      setSaved(true);
      setError('');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [accessibilityLabel, assetName, editorIdentity, onProjectionChange, operations, root, source, t]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.replaceChildren();
    const mounted = root;
    if (mounted) preview.append(mounted);
    return () => {
      if (mounted?.parentNode === preview) mounted.remove();
    };
  }, [root]);

  function importFile(file: File | undefined): void {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.svg') || file.size > 1024 * 1024) {
      setError(t('importInvalid'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError(t('importReadFailed'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError(t('importText'));
        return;
      }
      setSource(reader.result);
      localEditGeneration.current += 1; onDirty?.();
      setSaved(false);
      setFileName(file.name);
      setError('');
    };
    reader.readAsText(file, 'utf-8');
  }

  function load(): void {
    try {
      const parsed = parseSanitizedSvgTemplate(source);
      setRoot(parsed.root);
      setLoadedSource(source);
      setSelected([]);
      setOperations([]);
      setSaved(false);
      setError('');
    } catch {
      setRoot(null);
      setSelected([]);
      setError(t('invalidSvg'));
    }
  }

  function select(event: React.MouseEvent<HTMLDivElement>): void {
    if (!root || !(event.target instanceof Element)) return;
    const occurrence = event.target.closest(PAINTED_SELECTOR);
    if (!(occurrence instanceof SVGElement) || !root.contains(occurrence) || occurrence.closest(NON_PAINTED_ANCESTOR)) return;
    const painted = occurrence as SVGGraphicsElement;
    setSelected((previous) => {
      if (!event.shiftKey) return [painted];
      return previous.includes(painted)
        ? previous.filter((candidate) => candidate !== painted)
        : [...previous, painted];
    });
  }

  function mapExactColorToPaperKnockout(): void {
    if (!root) return;
    const before = serialize(root);
    const expected = exactColor.trim().toLowerCase();
    if (!expected) {
      setError(t('colorRequired'));
      return;
    }
    try {
      const changes = compilePaperKnockout(root, expected);
      if (changes === 0) throw new Error('Exact color key did not match any authored fill or stroke.');
      const template = serialize(root);
      parseSanitizedSvgTemplate(template);
      setOperations((previous) => [...previous, { type: 'map-exact-color-to-paper-knockout', color: exactColor }]);
      setSaved(false);
      setError('');
      localEditGeneration.current += 1;
      onTemplateChange(template);
    } catch (reason) {
      setRoot(parseSanitizedSvgTemplate(before).root);
      setSelected([]);
      setError(t('paperFailed'));
    }
  }

  function mapExactColorToForeground(): void {
    if (!root) return;
    const before = serialize(root);
    const expected = exactColor.trim().toLowerCase();
    if (!expected) {
      setError(t('colorRequired'));
      return;
    }
    let changes = 0;
    for (const element of [root, ...Array.from(root.querySelectorAll<SVGElement>('*'))]) {
      for (const channel of ['fill', 'stroke'] as const) {
        const value = element.getAttribute(channel);
        if (value?.trim().toLowerCase() === expected) {
          element.setAttribute(channel, 'currentColor');
          changes += 1;
        }
      }
      const authoredStyle = element.getAttribute('style');
      if (authoredStyle) {
        const declarations = authoredStyle.split(';').map((declaration) => {
          const separator = declaration.indexOf(':');
          if (separator < 0) return declaration;
          const name = declaration.slice(0, separator).trim().toLowerCase();
          const value = declaration.slice(separator + 1).trim();
          if ((name === 'fill' || name === 'stroke') && value.toLowerCase() === expected) {
            changes += 1;
            return `${name}:currentColor`;
          }
          return declaration;
        });
        element.setAttribute('style', declarations.join(';'));
      }
    }
    if (changes === 0) {
      setError(t('colorNoMatch'));
      return;
    }
    try {
      const template = serialize(root);
      parseSanitizedSvgTemplate(template);
      setOperations((previous) => [...previous, { type: 'map-exact-color-to-foreground', color: exactColor }]);
      setSaved(false);
      setError('');
      localEditGeneration.current += 1;
      onTemplateChange(template);
    } catch (reason) {
      setRoot(parseSanitizedSvgTemplate(before).root);
      setSelected([]);
      setError(t('transformFailed'));
    }
  }

  function mapSelectionToForeground(): void {
    if (!root || selected.length === 0) return;
    const before = serialize(root);
    for (const element of selected) {
      const fill = element.getAttribute('fill');
      const stroke = element.getAttribute('stroke');
      if (fill === null || fill.toLowerCase() !== 'none') element.setAttribute('fill', 'currentColor');
      if (stroke !== null && stroke.toLowerCase() !== 'none') element.setAttribute('stroke', 'currentColor');
    }
    try {
      const template = serialize(root);
      parseSanitizedSvgTemplate(template);
      setOperations((previous) => [...previous, { type: 'map-selected-paint-to-foreground' }]);
      setSaved(false);
      setError('');
      localEditGeneration.current += 1;
      onTemplateChange(template);
    } catch (reason) {
      setRoot(parseSanitizedSvgTemplate(before).root);
      setSelected([]);
      setError(t('transformFailed'));
    }
  }

  function selectParentGroups(): void {
    if (!root || selected.length === 0) return;
    const groups = selected.flatMap((element) => {
      const parent = element.parentElement;
      return parent instanceof SVGElement && parent.localName === 'g' && root.contains(parent)
        ? [parent as SVGGraphicsElement]
        : [];
    });
    setSelected([...new Set(groups)]);
  }

  function replaceWithSlot(): void {
    if (!root || selected.length === 0) return;
    const before = serialize(root);
    const slot = Number(slotIndex);
    if (!Number.isSafeInteger(slot) || slot < 0) {
      setError(t('slotInvalid'));
      return;
    }
    const first = selected[0];
    if (!selected.every((element) => element.parentElement === first.parentElement)) {
      setError(t('slotParents'));
      return;
    }
    try {
      const center = selectionCenter(selected);
      const candidateParent = first.parentElement;
      if (!(candidateParent instanceof SVGElement)) throw new Error('Selected artwork has no SVG parent.');
      const commonParent: SVGElement = candidateParent;
      const rootCtm = typeof root.getCTM === 'function' ? root.getCTM() : null;
      const parentMatrix = commonParent === root
        ? rootCtm ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
        : (commonParent as SVGGraphicsElement).getCTM();
      if (!parentMatrix) throw new Error('Selected artwork parent is detached from the SVG viewport.');
      const local = inversePoint(parentMatrix, center.x, center.y);
      const marker = document.createElementNS(SVG_NS, 'g');
      marker.setAttribute('data-snl-slot', String(slot));
      marker.setAttribute('transform', `translate(${Number(local.x.toFixed(6))} ${Number(local.y.toFixed(6))})`);
      const selectedSet = new Set(selected);
      const insertionReference = commonParent === first.parentElement
        ? Array.from(commonParent.children).find((child) => selectedSet.has(child as SVGGraphicsElement)) ?? null
        : null;
      commonParent.insertBefore(marker, insertionReference);
      for (const element of selected) {
        if (![...selectedSet].some((candidate) => candidate !== element && candidate.contains(element))) element.remove();
      }
      const template = serialize(root);
      parseSanitizedSvgTemplate(template);
      setOperations((previous) => [...previous, { type: 'replace-selection-with-slot', index: slot, anchor: [local.x, local.y] }]);
      setSelected([]);
      setSaved(false);
      setError('');
      localEditGeneration.current += 1;
      onTemplateChange(template);
    } catch (reason) {
      setRoot(parseSanitizedSvgTemplate(before).root);
      setSelected([]);
      setError(t('slotFailed'));
    }
  }

  function saveAssets(): void {
    if (!root) return;
    const host = api ?? getVsCodeApi();
    if (!host) {
      setError(t('bridgeUnavailable'));
      return;
    }
    const slug = assetName.trim();
    const label = accessibilityLabel.trim();
    if (!slug || !label) {
      setError(t('assetFieldsRequired'));
      return;
    }
    const requestId = `svg-macro-${Date.now()}-${requestSequence += 1}`;
    const templateSvg = serialize(root);
    const parsed = parseSanitizedSvgTemplate(templateSvg);
    const requiredArity = Math.max(0, ...parsed.slots.map((slot) => slot.index + 1));
    pendingRequest.current = { requestId, editorIdentity, slug, label, operationsJson: JSON.stringify(operations), sourceSvg: source, templateSvg, requiredArity, expected: expectedProjectionIdentity(slug, source, templateSvg, operations) };
    setSaved(false);
    setError('');
    host.postMessage({
      type: 'svgMacro.writeAssets', requestId, slug,
      sourceSvg: source, templateSvg,
      accessibilityLabel: label, operations
    });
  }

  return <section className="snl-svg-macro-editor" aria-label={t('editor')}>
    <div className="snl-svg-editor-controls" data-testid="svg-macro-controls">
    <label>{t('importFile')}
      <input type="file" accept="image/svg+xml,.svg" onChange={(event) => importFile(event.target.files?.[0])} />
    </label>
    {fileName ? <span>{fileName}</span> : null}
    <label>{t('source')}
      <textarea value={source} onChange={(event) => { setSource(event.target.value); localEditGeneration.current += 1; onDirty?.(); setSaved(false); }} />
    </label>
    <button type="button" onClick={load}>{t('load')}</button>
    {root && source !== loadedSource ? <p>{t('reloadRequired')}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p>{selected.length === 1 ? t('selectedOne') : t('selectedMany', { count: selected.length })}</p>
    <label>{t('slotIndex')}
      <input type="number" min="0" step="1" value={slotIndex} onChange={(event) => { setSlotIndex(event.target.value); localEditGeneration.current += 1; onDirty?.(); }} />
    </label>
    <button type="button" disabled={!root || selected.length === 0 || !selected.some((element) => element.parentElement?.localName === 'g')} onClick={selectParentGroups}>
      {t('selectGroup')}
    </button>
    <button type="button" disabled={!root || selected.length === 0} onClick={replaceWithSlot}>
      {t('replaceSlot')}
    </button>
    <button type="button" disabled={!root || selected.length === 0} onClick={mapSelectionToForeground}>
      {t('selectedForeground')}
    </button>
    <label>{t('exactColor')}
      <input value={exactColor} onChange={(event) => { setExactColor(event.target.value); localEditGeneration.current += 1; onDirty?.(); }} />
    </label>
    <button type="button" disabled={!root} onClick={mapExactColorToForeground}>
      {t('exactForeground')}
    </button>
    <button type="button" disabled={!root} onClick={mapExactColorToPaperKnockout}>
      {t('paperKnockout')}
    </button>
    <label>{t('assetName')}
      <input value={assetName} onChange={(event) => { setAssetName(event.target.value); setSaved(false); localEditGeneration.current += 1; onDirty?.(); }} />
    </label>
    <label>{t('accessibility')}
      <input value={accessibilityLabel} onChange={(event) => { setAccessibilityLabel(event.target.value); setSaved(false); localEditGeneration.current += 1; onDirty?.(); }} />
    </label>
    <button type="button" disabled={!root || source !== loadedSource} onClick={saveAssets}>{t('save')}</button>
    {saved ? <p role="status">{t('saved')}</p> : null}
    </div>
    <div className="snl-svg-editor-preview-column">
      <div className="snl-svg-macro-editor__preview" ref={previewRef} data-testid="svg-macro-preview" onClick={select} />
    </div>
  </section>;
}
