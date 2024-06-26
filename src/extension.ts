/**
 * Copyright 2023 Nokia
 * Licensed under the BSD 3-Clause License.
 * SPDX-License-Identifier: BSD-3-Clause
*/

'use strict';

import * as vscode from 'vscode';

import { IntentManagerProvider } from './providers';

export async function activate(context: vscode.ExtensionContext) {

	let imConfig = await vscode.workspace.getConfiguration('intentManager');
	let wfmConfig = await vscode.workspace.getConfiguration('workflowManager');

	const nspServerStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
	nspServerStatusBar.command = 'nokia-intent-manager.setServer';
	nspServerStatusBar.tooltip = 'Set NSP Server';
	nspServerStatusBar.text = 'NSP: ' + imConfig.get('activeServer');

	const wfmExtension = vscode.extensions.getExtension('Nokia.nokia-wfm');
	if (wfmExtension?.isActive) {
		nspServerStatusBar.hide();
	} else {
		nspServerStatusBar.show();
	}

	if (wfmConfig.get("activeServer") !== undefined) {
		const wfmConfig = vscode.workspace.getConfiguration('workflowManager');
		let imConfig = vscode.workspace.getConfiguration('intentManager');
	
		let wfmNSPS:any = wfmConfig.get("NSPS") ?? [];
		let imNSPS:any = imConfig.get("NSPS") ?? [];

		let imNSPSMap = new Map();
		imNSPS.forEach(item => {
			imNSPSMap.set(item.id, item);
		});
		wfmNSPS.forEach(wfmItem => {
			let imItem = imNSPSMap.get(wfmItem.id);
			if (imItem) {
				if (wfmItem.port === "443") {
					imItem.port = wfmItem.port;
				}
			} else {
				imNSPS.push(wfmItem);
			}
		});

		imConfig.update("NSPS", imNSPS, vscode.ConfigurationTarget.Global);

		if (imConfig.get("activeServer") != wfmConfig.get("activeServer")) {
			let server = wfmConfig.get("activeServer"); // update the active server on the current window only:
			if (imConfig.get("activeServer") != undefined) {
				imConfig.update("activeServer", server, vscode.ConfigurationTarget.Workspace);
			}
			nspServerStatusBar.text = 'NSP: ' + server;
		}
	}

	const config = vscode.workspace.getConfiguration('intentManager');
	const addr : string = config.get("activeServer") ?? "";
	const secretStorage : vscode.SecretStorage = context.secrets;
	const imProvider = new IntentManagerProvider(context);

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
	
		if (e.affectsConfiguration('intentManager')) {
			console.log("imNSPs1: ", imConfig.get("NSPS") ?? []);
			console.log("wfmNSPs1: ", wfmConfig.get("NSPS") ?? []);
			await imProvider.updateSettings(); // config has changed
			console.log("imNSPs2: ", imConfig.get("NSPS") ?? []);
			console.log("wfmNSPs2: ", wfmConfig.get("NSPS") ?? []);
		}
		if (e.affectsConfiguration('workflowManager')) {
			const wfmConfig = vscode.workspace.getConfiguration('workflowManager'); // update intenet Manager NSP's:
			let imConfig = vscode.workspace.getConfiguration('intentManager');

			if (e.affectsConfiguration("workflowManager.NSPS")) {
				let wfmNSPS:any = wfmConfig.get("NSPS") ?? [];
				let imNSPS:any = imConfig.get("NSPS") ?? [];
		
				let imNSPSMap = new Map();
				imNSPS.forEach(item => {
					imNSPSMap.set(item.id, item);
				});
				wfmNSPS.forEach(wfmItem => {
					let imItem = imNSPSMap.get(wfmItem.id);
					if (imItem) {
						if (wfmItem.port === "443") {
							imItem.port = wfmItem.port;
						}
					} else {
						imNSPS.push(wfmItem);
					}
				});
		
				imConfig.update("NSPS", imNSPS, vscode.ConfigurationTarget.Global);
			}
			if (imConfig.get("activeServer") != wfmConfig.get("activeServer")) {
				let server = wfmConfig.get("activeServer"); // update the active server:
				imConfig.update("activeServer", server, vscode.ConfigurationTarget.Workspace);
				nspServerStatusBar.text = 'NSP: ' + server;
			}
			imProvider.updateSettings();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.updateStatusBar', async () => updateStatusBarItem()));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
	context.subscriptions.push(imProvider.getStatusBarItem());
	context.subscriptions.push(vscode.languages.registerCodeLensProvider({scheme: 'im'}, imProvider));

	const fileAssociations : {[key: string]: string} = vscode.workspace.getConfiguration('files').get('associations') || {};
	fileAssociations["/*_v*/views/*"] = "json";
	vscode.workspace.getConfiguration('files').update('associations', fileAssociations);
	
	// --- Set Workflow Manager NSP Server when the user clicks the server button
	context.subscriptions.push(vscode.commands.registerCommand('nokia-intent-manager.setServer', async () => {
		let updatedConfig = vscode.workspace.getConfiguration('intentManager');
		imProvider.setServer(updatedConfig, nspServerStatusBar, secretStorage); // set Active Workflow Manager NSP Server
	
	}));
	vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.parse('im:/'), name: "Intent Manager" });
}

export function deactivate(context: vscode.ExtensionContext) { // function from its main module to perform cleanup tasks on VS Code shutdow
   return;
}