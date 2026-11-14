import * as vscode from 'vscode';
import { buildPanelHtml } from './panelUtil';
import { fetchRemoteReader, remoteReaderOrigin, validRemoteReaderToken } from './remoteReaderClient';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const LAST_ENDPOINT = 'snlDoc.remoteReader.endpoint';
const messages = defineHostMessages({
  title: 'SNL Remote Reader',
  origin: 'Enter the HTTPS origin of the Toolkit Reader service',
  invalidOrigin: 'Enter an HTTPS origin without a path or credentials.',
  token: 'Enter the Reader token',
  savedToken: 'Enter a new token, or leave blank to use the saved token',
  invalidToken: 'Use a token of 32 to 256 base64url characters.',
  badRequest: 'Could not process this Reader request.',
  connection: 'Could not connect to the Reader service. Check the address and TLS certificate.',
  response: 'Invalid Reader response.',
}, {
  title: 'SNL 远程阅读器',
  origin: '输入 Toolkit 远程阅读服务的 HTTPS 地址',
  invalidOrigin: '请输入不含路径或凭据的 HTTPS 地址。',
  token: '输入阅读器令牌',
  savedToken: '输入新令牌，或留空使用已保存的令牌',
  invalidToken: '令牌须为 32 至 256 个 base64url 字符。',
  badRequest: '无法处理此阅读请求。',
  connection: '无法连接阅读器服务。请检查地址和 TLS 证书。',
  response: '远程阅读器响应无效。',
});

export async function openRemoteReader(context: vscode.ExtensionContext): Promise<void> {
  const t = createHostTranslator(read_extension_preferences().language, messages);
  const title = t('title');
  const endpoint = await vscode.window.showInputBox({
    title,
    prompt: t('origin'),
    value: context.globalState.get<string>(LAST_ENDPOINT),
    ignoreFocusOut: true,
    validateInput: value => {
      try { remoteReaderOrigin(value); return undefined; }
      catch { return t('invalidOrigin'); }
    }
  });
  if (endpoint === undefined) return;
  const origin = remoteReaderOrigin(endpoint);
  const secretKey = 'snlDoc.remoteReader.token:' + origin;
  const saved = await context.secrets.get(secretKey);
  const token = await vscode.window.showInputBox({
    title, password: true, ignoreFocusOut: true,
    prompt: t(saved ? 'savedToken' : 'token'),
    validateInput: value => (saved && !value) || validRemoteReaderToken(value) ? undefined
      : t('invalidToken')
  });
  if (token === undefined) return;
  const credential = token || saved;
  if (!credential) return;
  if (token) await context.secrets.store(secretKey, token);
  await context.globalState.update(LAST_ENDPOINT, origin);

  const panel = vscode.window.createWebviewPanel('snlDoc.remoteReader', title, vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  const requests = new Map<number, AbortController>();
  const subscription = panel.webview.onDidReceiveMessage(async message => {
    if (!message || !Number.isSafeInteger(message.id) || message.id < 1) return;
    const id: number = message.id;
    if (message.type === 'remoteReader.cancel') {
      requests.get(id)?.abort();
      requests.delete(id);
      return;
    }
    if (message.type !== 'remoteReader.request' || requests.has(id)) return;
    if (requests.size >= 4 || (message.library !== undefined &&
      (typeof message.library !== 'string' || !message.library || message.library.length > 256))) {
      await panel.webview.postMessage({ type: 'remoteReader.response', id, error: t('badRequest') });
      return;
    }
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      const value = await fetchRemoteReader(origin, credential, message.library, controller.signal);
      if (!controller.signal.aborted) await panel.webview.postMessage({ type: 'remoteReader.response', id, value });
    } catch (error) {
      if (!controller.signal.aborted) await panel.webview.postMessage({
        type: 'remoteReader.response', id,
        error: error instanceof Error && error.name === 'TypeError'
          ? t('connection')
          : (error instanceof Error && error.name !== 'SyntaxError' ? error.message : t('response')),
      });
    } finally {
      if (requests.get(id) === controller) requests.delete(id);
    }
  });
  panel.onDidDispose(() => {
    subscription.dispose();
    for (const request of requests.values()) request.abort();
    requests.clear();
  });
  panel.webview.html = buildPanelHtml(context.extensionUri, panel.webview, 'remoteReader', title, undefined, { detached: true });
}
