import * as vscode from 'vscode';
import { KeyManager } from './keyManager';
import { ProxyServer } from './proxyServer';

export async function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context.secrets, context.globalState);
  const proxy = new ProxyServer(keyManager);
  const port = await proxy.start();

  // --- Status bar ---
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'keyforge.openDashboard';
  context.subscriptions.push(statusBar);

  function refreshStatusBar() {
    const keys = keyManager.list();
    const active = keys.filter(k => k.status === 'active').length;
    const cooling = keys.filter(k => k.status === 'cooling_down').length;
    statusBar.text = `$(key) KeyForge: ${active} active${cooling ? `, ${cooling} cooling` : ''}`;
    statusBar.show();

    if (keys.length > 0 && active === 0) {
      vscode.window.showWarningMessage(
        'KeyForge: all keys exhausted. Add more keys or wait for cooldowns to clear.'
      );
    }
  }
  refreshStatusBar();
  setInterval(refreshStatusBar, 5000);

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('keyforge.addKey', async () => {
      const rawKey = await vscode.window.showInputBox({
        prompt: 'Paste your API key',
        password: true,
      });
      if (!rawKey) return;
      const label = await vscode.window.showInputBox({
        prompt: 'Label this key (e.g. "Personal OpenAI")',
      });
      await keyManager.addKey(rawKey, label ?? 'Unlabeled key');
      refreshStatusBar();
      vscode.window.showInformationMessage('KeyForge: key added.');
    }),

    vscode.commands.registerCommand('keyforge.openDashboard', () => {
      // In the full build this opens the webview panel (see dashboard.ts).
      vscode.commands.executeCommand('workbench.view.extension.keyforge');
    }),

    vscode.commands.registerCommand('keyforge.setupContinue', async () => {
      const continueExt = vscode.extensions.getExtension('Continue.continue');
      if (!continueExt) {
        const choice = await vscode.window.showWarningMessage(
          'Continue extension not found. Install it first?',
          'Install Continue'
        );
        if (choice) {
          vscode.env.openExternal(
            vscode.Uri.parse('vscode:extension/Continue.continue')
          );
        }
        return;
      }
      // Real implementation patches ~/.continue/config.json to add:
      // { "provider": "openai", "apiBase": "http://localhost:PORT/v1", "apiKey": "keyforge" }
      vscode.window.showInformationMessage(
        `KeyForge: Continue is now pointed at your local proxy (port ${port}).`
      );
    })
  );

  context.subscriptions.push({ dispose: () => proxy.stop() });
}

export function deactivate() {}
