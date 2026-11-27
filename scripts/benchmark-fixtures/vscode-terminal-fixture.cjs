const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

exports.activate = context => {
  const fixture = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'fixture.json'), 'utf8'));
  let visible;
  for (let index = 0; index < fixture.count; index += 1) {
    visible = vscode.window.createTerminal({
      name: 'Benchmark ' + (index + 1),
      shellPath: fixture.wsl,
      shellArgs: fixture.args,
      cwd: fixture.workspace,
    });
    context.subscriptions.push(visible);
  }
  visible?.show(true);
};
