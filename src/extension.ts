/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
*/

'use strict';

import * as vscode from 'vscode';

import { IntentManagerProvider } from './providers';

export function activate(context: vscode.ExtensionContext) {

	// ensure alignement of NSP servers between Intent Manager and Workflow Manager upon activation
	let imConfig = vscode.workspace.getConfiguration('intentManager');
	let wfmConfig = vscode.workspace.getConfiguration('workflowManager');

	if (imConfig.get("NSPS") != wfmConfig.get("NSPS")) {
		let servers = wfmConfig.get("NSPS") ?? {};
		imConfig.update("NSPS", servers, vscode.ConfigurationTarget.Global);
	}

	if (imConfig.get("activeServer") != wfmConfig.get("activeServer")) {
		let server = wfmConfig.get("activeServer"); // update the active server on the current window only:
		imConfig.update("activeServer", server, vscode.ConfigurationTarget.Workspace);
	}

	const config = vscode.workspace.getConfiguration('intentManager');
	const addr : string = config.get("activeServer") ?? "";
	const secretStorage : vscode.SecretStorage = context.secrets;
	const imProvider = new IntentManagerProvider(context);

	// Beginning of implementation for status bar for either Intent Manager or Workflow Manager:
	const isStatusBarEnabledIM = config.get("intentManager.isStatusBar");
	const isStatusBarEnabledWFM = config.get("workflowManager.isStatusBar");

	// NSP - Multiple Server Support:
	const statusbar_server = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	statusbar_server.command = 'nokia-wfm.setServer';
	statusbar_server.tooltip = 'Set Workflow Manager NSP Server';
	statusbar_server.text = 'NSP: ' + addr ?? 'Select Server';
	statusbar_server.show();

	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('im', imProvider, { isCaseSensitive: true }));
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(imProvider));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.audit', async (...args) => imProvider.audit(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.sync',  async (...args) => imProvider.sync(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.logs',  async (...args) => imProvider.logs(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.state', async (...args) => imProvider.setState(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.lastAuditReport', async (...args) => imProvider.lastAuditReport(args)));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.openInBrowser', async (...args) => imProvider.openInBrowser(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.newIntent',     async (...args) => imProvider.newIntent(args)));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.uploadIntentType', async (...args) => imProvider.uploadIntentType(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.uploadIntents',    async (...args) => imProvider.uploadIntents(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.clone',            async (...args) => imProvider.clone(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.newVersion',       async (...args) => imProvider.newVersion(args)));
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.newIntentType',    async (...args) => imProvider.newIntentTypeFromTemplate(args)));
	
	vscode.commands.registerCommand('nokia-intent-manager.setPassword', async () => {
		const passwordInput: string = await vscode.window.showInputBox({password: true, title: "Password"}) ?? '';
		
		if(passwordInput !== '') {
			secretStorage.store(addr + '_password', passwordInput);
		}
	});

	function updateStatusBarItem(){
		const editor = vscode.window.activeTextEditor;
		const sbar = imProvider.getStatusBarItem();

		if (editor) {
			const document = editor.document;
			const parts = document.uri.toString().split('/').map(decodeURIComponent);

			if (parts[0]==="im:") {
				if (parts[2]==="intents") {
					sbar.text = parts[3]+" ["+imProvider.getState(document.uri)+"]";
					sbar.command = 'nokia-intent-manager.state';
				} else {
					sbar.text = parts[1];
					sbar.command = undefined;
				}
				sbar.show();
			} else sbar.hide();
		} else sbar.hide();
	}

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
		console.log("Configuration changed")
		if (e.affectsConfiguration('intentManager')) {
			imProvider.updateSettings(); // config has changed
		}
		if (e.affectsConfiguration('workflowManager')) {
			const wfmConfig = vscode.workspace.getConfiguration('workflowManager'); // update intenet Manager NSP's:
			let imConfig = vscode.workspace.getConfiguration('intentManager');
			if (imConfig.get("NSPS") != wfmConfig.get("NSPS")) {
				let servers = wfmConfig.get("NSPS") ?? {};
				console.log('wfmConfig servers: ', servers);
				imConfig.update("NSPS", servers, vscode.ConfigurationTarget.Global);
			}
			if (imConfig.get("activeServer") != wfmConfig.get("activeServer")) {
				let server = wfmConfig.get("activeServer"); // update the active server:
				imConfig.update("activeServer", server, vscode.ConfigurationTarget.Workspace);
				statusbar_server.text = 'NSP: ' + server;
			}
			imProvider.updateSettings();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.updateStatusBar', async () => updateStatusBarItem()));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
	context.subscriptions.push(imProvider.getStatusBarItem());
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({scheme: 'im'}, imProvider));

	const fileAssociations : {[key: string]: string} = vscode.workspace.getConfiguration('files').get('associations') || {};
	// --- Set Workflow Manager NSP Server when the user clicks the server button
	context.subscriptions.push(vscode.commands.registerCommand('nokia-wfm.setServer', async () => {
		let updatedConfig = vscode.workspace.getConfiguration('intentManager');
		imProvider.setServer(updatedConfig, statusbar_server, secretStorage); // set Active Workflow Manager NSP Server
	
	}));

	context.subscriptions.push
	let fileAssociations : {[key: string]: string} = vscode.workspace.getConfiguration('files').get('associations') || {};
	fileAssociations["/*_v*/views/*"] = "json";
	vscode.workspace.getConfiguration('files').update('associations', fileAssociations);

	vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.parse('im:/'), name: "Intent Manager" });
}