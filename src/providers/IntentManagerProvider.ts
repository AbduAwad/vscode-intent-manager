import * as vscode from 'vscode';
import * as fs from 'fs';

import fetch = require('node-fetch');
import base64 = require('base-64');
import nunjucks = require('nunjucks');

const DECORATION_WORKSPACE: vscode.FileDecoration = new vscode.FileDecoration(
	'', 'Intent Manager Plugin', new vscode.ThemeColor('list.focusForeground')
);

const DECORATION_SIGNED: vscode.FileDecoration = new vscode.FileDecoration(
	'🔒', 'IntentType: Signed', new vscode.ThemeColor('list.deemphasizedForeground')
);

const DECORATION_UNSIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'',	'IntentType: Unsigned',	new vscode.ThemeColor('list.warningForeground')
);

const DECORATION_MODULES: vscode.FileDecoration =    new vscode.FileDecoration(
	'☯', 'YANG Modules', new vscode.ThemeColor('list.warningForeground')
);

const DECORATION_RESOURCES: vscode.FileDecoration =    new vscode.FileDecoration(
	'📚', 'Resources', new vscode.ThemeColor('list.warningForeground')
);

const DECORATION_ALIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'✅', 'Intent: Aligned', new vscode.ThemeColor('list.warningForeground')
);

const DECORATION_MISALIGNED: vscode.FileDecoration =    new vscode.FileDecoration(
	'💔', 'Intent: Misaligned', new vscode.ThemeColor('list.errorForeground')
);

const DECORATION_INTENTS: vscode.FileDecoration =    new vscode.FileDecoration(
	'', 'Instances', new vscode.ThemeColor('list.highlightForeground')
);

const DECORATION_VIEWS: vscode.FileDecoration =    new vscode.FileDecoration(
	'', 'UI Customization', new vscode.ThemeColor('list.highlightForeground')
);

const myStatusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
myStatusBarItem.command = 'nokia-intent-manager.intentStatus';

/*
	Class implementing FileSystemProvider for Intent Manager
*/

export class IntentManagerProvider implements vscode.FileSystemProvider, vscode.FileDecorationProvider, vscode.CodeLensProvider {
	static scheme = 'im';

	extensionPath: string;
	extensionUri: vscode.Uri;

	nspAddr: string;
	username: string;
	password: string|undefined;
	port: string;
	authToken: any|undefined;

	timeout: number;
	fileIgnore: Array<string>;
	parallelOps: boolean;

	nspVersion: number[] | undefined;
	secretStorage: vscode.SecretStorage;

	serverLogs: vscode.OutputChannel;
	pluginLogs: vscode.LogOutputChannel;

	intentTypes: {
		[key: string]: {
			signed: boolean;
			timestamp: number;
			data:    {[key: string]: any};
			intents: {[target: string]: object};
			desired: {[target: string]: string};  // intent desired state: active, suspend, delete, saved, planned, deployed
			aligned: {[target: string]: boolean}; // intent aligned or misaligned
			views:   {[filename: string]: string};	
		}
	};

	public onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    private _eventEmiter: vscode.EventEmitter<vscode.Uri | vscode.Uri[]>;

	/**
	 * Create IntentManagerProvider
	 * 
	 * @param {vscode.ExtensionContext} context vsCode Extension Context
	 * 
	 */	
	
	constructor (context: vscode.ExtensionContext) {
		const config = vscode.workspace.getConfiguration('intentManager');
		this.nspAddr = config.get("activeServer") ?? "";
		this.secretStorage = context.secrets;
		this.port = "";
		this.timeout = config.get("timeout") ?? 90000;
		this.fileIgnore = config.get("ignoreLabels") ?? [];
		this.parallelOps = config.get("parallelOperations.enable") ?? false;
		this.extensionPath = context.extensionPath;
		this.extensionUri = context.extensionUri;

		console.debug("IntentManagerProvider("+this.nspAddr+")");

		this.nspVersion = undefined;

		this.serverLogs = vscode.window.createOutputChannel('nsp-server-logs/intents', 'log');
		this.pluginLogs = vscode.window.createOutputChannel('nsp-intent-manager-plugin', {log: true});

		this.authToken = undefined;

		this.intentTypes = {};

		this._eventEmiter = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._eventEmiter.event;
	}

	/**
	 * Graceful disposal of IntentManagerProvider.
	 * 
	 * Method disconnects from NSP (revokes auth-token) and cleans-up variables.
	 */	

	dispose() {
		this._revokeAuthToken();
		this.serverLogs.dispose();
		this.pluginLogs.dispose();
	}

	// --- SECTION: PRIVATE METHODS -----------------------------------------

	/**
	 * Retrieves auth-token from NSP. Implementation uses promises to ensure that only
	 * one token is used at any given moment of time. The token will automatically be
	 * revoked after 10min.
	 */	

	private async _getAuthToken(): Promise<void> {
		this.pluginLogs.info("executing getAuthToken()")
        if (this.authToken) {
            if (!(await this.authToken)) {
                this.authToken = undefined;
            }
        }

		this.password = await this.secretStorage.get(this.nspAddr + "_password");
		this.username = await this.secretStorage.get(this.nspAddr + "_username");

        if (this.password && !this.authToken) {
            this.authToken = new Promise((resolve, reject) => {
                this.pluginLogs.warn("No valid auth-token; Getting a new one...");
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

				// for getting the auth-token, we are using a reduced timeout of 10sec
                const timeout = new AbortController();
                setTimeout(() => timeout.abort(), 10000);

                const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/token";
                fetch(url, {
                    method: "POST",
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache',
                        'Authorization': 'Basic ' + base64.encode(this.username+ ":" +this.password)
                    },
                    body: '{"grant_type": "client_credentials"}',
                    signal: timeout.signal
                }).then((response:any) => {
                    if (!response.ok) {
						vscode.window.showErrorMessage("NSP Authentication Error");
                        reject("Authentication Error!");
                        throw new Error("NSP Authentication Error!");
                    }
                    return response.json();
                }).then((json:any) => {
                    resolve(json.access_token);
                    // automatically revoke token after 10min
                    setTimeout(() => this._revokeAuthToken(), 600000);
                }).catch((error:any) => {
					if (error.message.includes('user aborted'))
						this.pluginLogs.error("No response for getting authToken within 10sec");
					else
						this.pluginLogs.error("Getting authToken failed with", error.message);
					vscode.window.showWarningMessage("NSP is not reachable");
                    resolve(undefined);
                });
            });
        }
    }

	/**
	 * Gracefully revoke NSP auth-token.
	 */	

	private async _revokeAuthToken(): Promise<void> {
		if (this.authToken) {
			const token = await this.authToken;
			this.pluginLogs.debug("_revokeAuthToken("+token+")");
			this.authToken = undefined;

			const url = "https://"+this.nspAddr+"/rest-gateway/rest/api/v1/auth/revocation";
			fetch(url, {
				method: "POST",
				headers: {
					"Content-Type":  "application/x-www-form-urlencoded",
					"Authorization": "Basic " + base64.encode(this.username+ ":" +this.password)
				},
				body: "token="+token+"&token_type_hint=token"
			})
			.then((response:any) => {
				this.pluginLogs.info("POST", url, response.status);
			});
		}
	}

	/**
	 * Private wrapper method to call NSP APIs. Method sets http request timeout.
	 * Common error handling and logging is centralized here.
	 * 
	 * @param {string} url API endpoint for http request
	 * @param {{method: string, body: string, headers: object, signal: AbortSignal}} options HTTP method, header, body
	 */	

	private async _callNSP(url:string, options:{method: string, body?: string, headers?: object, signal?: AbortSignal}): Promise<void> {
		const timeout = new AbortController();
        setTimeout(() => timeout.abort(), this.timeout);
		options.signal = timeout.signal;

		if (!('headers' in options)) {
			await this._getAuthToken();
			const token = await this.authToken;
			if (!token)
				throw vscode.FileSystemError.Unavailable('NSP is not reachable');

			if (url.startsWith('/restconf'))
				options.headers = {
					"Content-Type": "application/yang-data+json",
					"Accept": "application/yang-data+json",
					"Authorization": "Bearer " + token
				};
			else
				options.headers = {
					'Content-Type': "application/json",
					'Accept': "application/json",	
					"Authorization": "Bearer " + token
				};
		}

		if (!url.startsWith('https://')) {
			if (["443",""].includes(this.port))
				url = "https://"+this.nspAddr+url;
			else if (url.startsWith('/logviewer'))
				url = "https://"+this.nspAddr+url;
			else if (this.port != "8545")
				url = "https://"+this.nspAddr+":"+this.port+url;
			else if (url.startsWith('/restconf'))
				url = "https://"+this.nspAddr+":8545"+url;
			else
				// in case of /mdt/rest/...
				url = "https://"+this.nspAddr+":8547"+url;
		}

		const startTS = Date.now();
		const response: any = new Promise((resolve, reject) => {
			fetch(url, options).then((response:any) => {
				response.clone().text().then((body:string) => {
					const duration = Date.now()-startTS;

					this.pluginLogs.info(options.method, url, options.body??"", "finished within", duration, "ms");

					if (response.status >= 400)
						this.pluginLogs.warn("NSP response:", response.status, body);
					else if ((body.length < 1000) || (this.pluginLogs.logLevel == vscode.LogLevel.Trace))
						this.pluginLogs.info("NSP response:", response.status, body);
					else
						this.pluginLogs.info("NSP response:", response.status, body.substring(0,1000)+'...');
				});
				return response;
			})
			.then((response:any) => {
				resolve(response);
			})
			.catch((error:any) => {
				const duration = Date.now()-startTS;
				let errmsg = options.method+" "+url+" failed with "+error.message+" after "+duration.toString()+"ms!";
				if (error.message.includes("user aborted"))
					errmsg = "No response for "+options.method+" "+url+". Call terminated after "+duration.toString()+"ms.";

				this.pluginLogs.error(errmsg);
				vscode.window.showErrorMessage(errmsg);
				resolve(undefined);
			});
		});
		return response;
	}

	/**
	 * Cross launch NSP WebUI.
	 * Works with NSP New Navigation (since 23.11)
	 * 
	 * @param {string} url WebUI endpoint to open
	 */

	private async _openWebUI(url:string): Promise<void> {
		if (url.startsWith('/web/'))
			// New navigation since nsp23.11 uses standard https ports 443
			url = "https://"+this.nspAddr+url;
		else if (url.startsWith('/intent-manager/'))
			// Original WebUI until nsp23.8 uses mdt tomcat port 8547
			url = "https://"+this.nspAddr+":8547"+url;
		else
			url = "https://"+this.nspAddr+url;

		vscode.env.openExternal(vscode.Uri.parse(url));
	}

	/**
	 * Checks if NSP is running at least a specific release
	 * 
	 * @param {number} major Major NSP REL
	 * @param {number} minor Minor NSP REL
	 */

	private _fromRelease(major: number, minor:number): boolean {
		if (this.nspVersion) {
			if (this.nspVersion[0] > major) return true;
			if (this.nspVersion[0]===major && this.nspVersion[1]>=minor) return true;
		}
		return false;
	}

		/**
	 * Method to validate NSP credentials
	 * @param {string} ip - IP address of the NSP
	 * @param {string} username - NSP username
	 * @param {string} password - NSP password
	*/
	private async validateNSPCredentials(ip: string, username: string, password: string): Promise<boolean> {

		this.pluginLogs.info("Executing validateIpCredentials()");
		const fetch = require('node-fetch');
		const base64 = require('base-64');
		const timeout = new AbortController();
		setTimeout(() => timeout.abort(), this.timeout);

		const url = "https://"+ip+"/rest-gateway/rest/api/v1/auth/token";
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache',
					'Authorization': 'Basic ' + base64.encode(username+ ":" +password)
				},
				body: '{"grant_type": "client_credentials"}',
				signal: timeout.signal
			});

			if (!response.ok) {
				return false;
			}
			return true;
		} catch {
			return false;
		}
	}


	/**
	 * Retrieve and store NSP release in this.nspVersion.
	 * Release information will be shown to vsCode user.
	 * Note: currently used to select OpenSearch API version.
	*/

	private async _getNSPversion(): Promise<void> {
		this.pluginLogs.info("Requesting NSP version");
		const url = "https://"+this.nspAddr+"/internal/shared-app-banner-utils/rest/api/v1/appBannerUtils/release-version";

		const response: any = await this._callNSP(url, {method: "GET"});
		if (!response)
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		if (!response.ok)
			this._raiseRestconfError("Getting NSP release failed!", await response.json());
		
		const json = await response.json();

		const version = json["response"]["data"]["nspOSVersion"];		
		this.nspVersion = version.match(/\d+\.\d+\.\d+/)[0].split('.').map(parseInt);
		vscode.window.showInformationMessage("NSP version: "+version);
	}

	/**
	 * Get one or more URIs, dependend on how extension command was triggered.
	 * If triggered from virtual file-system, multi-select is supported.
	 * If launched via icon or command pallete, active editor is used.
	 * 
	 * @param {any[]} args context used when command was issued
	 */	

	private _getUriList(args:any[]): vscode.Uri[] {
		if (args.length === 2 && Array.isArray(args[1]))
			return args[1];

		if (args.length>0 && args[0] instanceof vscode.Uri)
			return [args[0]];

		if (vscode.window.activeTextEditor)
			return [vscode.window.activeTextEditor.document.uri];

		return [];
	}

	/**
	 * Convert RESTCONF model-path into human-friendly format, while using HTML tag (em).
	 * 
	 * Example:
	 *   input:  /nokia-conf:/configure/port=1%2F1%2Fc3%2F1/description
	 *   output: /nokia-conf:/configure/port=<em>1/1/c3/1</em>/description
	 *  
	 * @param {string} modelpath RESTCONF compliant model-path
	 * @returns {string} model-path in HTML format
	 */	

	private _modelPathHTML(modelpath: string): string {
		const parts = modelpath.split('/');
		const cparts = [];
		for (const part of parts) {
			const kvp = part.split('=');
			if (kvp.length===2)
				cparts.push(kvp[0]+"=<em>"+decodeURIComponent(kvp[1])+"</em>");
			else
				cparts.push(part);
		}
		return cparts.join('/');
	}

	/**
	 * Create webview to display audit report. Webview is rendered from nunjucks
	 * template (Jinja2) and contains HTML, CSS and JavaScript, therefore
	 * webview panel has scripting enabled.
	 *  
	 * @param {string} intent_type Intent-type name
	 * @param {string} target Intent target
	 * @param {{[key: string]: any}} report Audit report returned from Intent Manager
	 */	

	private async _auditReport(intent_type: string, target: string, report: {[key: string]: any}): Promise<void>  {
		const j2media = nunjucks.configure(vscode.Uri.joinPath(this.extensionUri, 'media').fsPath);

		if ('misaligned-attribute' in report)
				for (const object of report["misaligned-attribute"])
					object["name"] = this._modelPathHTML(object["name"]);

		if ('misaligned-object' in report)
			for (const object of report["misaligned-object"])
				object["object-id"] = this._modelPathHTML(object["object-id"]);

		if ('undesired-object' in report)
			for (const object of report["undesired-object"])
				object["object-id"] = this._modelPathHTML(object["object-id"]);

		const panel = vscode.window.createWebviewPanel('auditReport', 'Audit '+intent_type+'/'+target, vscode.ViewColumn.Active, {enableScripts: true});
		panel.webview.html = j2media.render('report.html.njk', {intent_type: intent_type, target: target, report: report});
		this.pluginLogs.info(panel.webview.html);
	}

	/**
	 * Extract error message from RESTCONF response and raise exception.
	 *  
	 * @param {string} errmsg Provide information about what failed
	 * @param {{[key: string]: any}} response HTTP response to extract error message
	 * @param {boolean} show Always show error message, for cases where vsCode is NOT handling exceptions
	 */		

	private _raiseRestconfError(errmsg: string, response: {[key: string]: any}, show:boolean=false) {
		if (Object.keys(response).includes("ietf-restconf:errors")) {
			while (response && (Object.keys(response)[0]!="error"))
				response = response[Object.keys(response)[0]];

			errmsg += "\n"+response["error"][0]["error-message"];
		}

		if (show)
			vscode.window.showErrorMessage(errmsg);

		throw vscode.FileSystemError.NoPermissions(errmsg);
	}

	/**
	 * Extract error message from RESTCONF response and show as warning popup.
	 *  
	 * @param {string} errmsg Provide information about what failed
	 * @param {{[key: string]: any}} response HTTP response to extract error message
	 */		

	private _printRestconfError(errmsg: string, response: {[key: string]: any}) {
		if (Object.keys(response).includes("ietf-restconf:errors")) {
			while (response && (Object.keys(response)[0]!="error"))
				response = response[Object.keys(response)[0]];

			vscode.window.showWarningMessage(errmsg+"\n"+response["error"][0]["error-message"]);
		} else
			vscode.window.showWarningMessage(errmsg);
	}

	/**
	 * Custom implementation of remove an object from an array by id.
	 * @param {Array} arr Array to remove object from
	 * @param {string} id ID of object to remove
	**/
	private removeObjectByIp(arr, id) {
		let index = arr.findIndex(obj => obj.ip === id);
		if (index !== -1) {
			arr.splice(index, 1);
		}
		return arr;	
	}

	// --- SECTION: vscode.FileSystemProvider implementation ----------------

	/**
	 * vsCode.FileSystemProvider method to read directory entries.
	 * 
	 * IntentManagerProvider uses this as main method to pull data from IM
	 * while storing it in memory (as cache).
	 * 
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 * 
	 */	

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const path = uri.toString();
		this.pluginLogs.debug("readDirectory("+path+")");

		let result:[string, vscode.FileType][] = [];

		if (!this.nspVersion)
			this._getNSPversion();

		if (path === "im:/") {
			// readDirectory() was executed with IM root folder
			//
			// Function will get and return the list of all intent-types
			// while labels to ignore are applied as blacklist.

			const url = "/restconf/operations/ibn-administration:search-intent-types";
			const body = {"ibn-administration:input": {"page-number": 0, "page-size": 1000}};
			const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});

			if (!response)
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			if (!response.ok)
				this._raiseRestconfError("Getting list of intent-types failed!", await response.json());

			const json = await response.json();
			if (json["ibn-administration:output"]["total-count"]>1000) {
				vscode.window.showWarningMessage("NSP has more than 1000 intent-types. Only showing the first 1000.");
			}

			let intentTypes = json["ibn-administration:output"]["intent-type"];
			for (const label of this.fileIgnore) {
				// apply blacklist for label(s) provided in extension settings
				intentTypes = intentTypes.filter((entry:any) => !entry.label.includes(label));
			}
			result = intentTypes.map((entry: { name: string; version: string; }) => [entry.name+"_v"+entry.version, vscode.FileType.Directory]);

			// Create missing intentType entries in cache
			for (const entry of intentTypes) {
				const intent_type_folder = entry.name+"_v"+entry.version;
				if (!(intent_type_folder in this.intentTypes))
					this.intentTypes[intent_type_folder] = {
						signed:  entry.label.includes('ArtifactAdmin'),
						timestamp: Date.now(), // We don't have the real timestamp yet!
						data:    {},
						intents: {},
						aligned: {},
						desired: {},
						views:   {}
					};
			}
		} else {
			const parts = path.split('/').map(decodeURIComponent);
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];

			if (parts.length===2) {
				// readDirectory() was executed on folder "im:/{intent-type}_v{version}".
				// Get intent-type defintion using IM API to create/update cache entry.

				const url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog/intent-type="+intent_type+","+intent_type_version;

				const response: any = await this._callNSP(url, {method: "GET"});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Getting intent-type details failed!", await response.json());

				const json = await response.json();
				const data = json["ibn-administration:intent-type"];

				if (intent_type_folder in this.intentTypes) {
					// update intent-type cache entry with data and timestamp
					this.intentTypes[intent_type_folder].data = data;
					this.intentTypes[intent_type_folder].timestamp = Date.parse(data.date);
				} else
					throw vscode.FileSystemError.Unavailable("internal issue, cache not initialized");

				// intent-type folder content

				result.push(['yang-modules', vscode.FileType.Directory]);
				result.push(['intent-type-resources', vscode.FileType.Directory]);
				result.push(['views', vscode.FileType.Directory]);
				result.push(['intents', vscode.FileType.Directory]);
				result.push(["meta-info.json", vscode.FileType.File]);
				if (data["mapping-engine"]==="js-scripted")
					result.push(["script-content.js", vscode.FileType.File]);
				else
					result.push(["script-content.mjs", vscode.FileType.File]);
			}

			else if (parts[2]==='intents') {
				// readDirectory() was executed with 3rd level folder for intents:
				// "im:/{intent-type}_v{version}/intents/"
				//
				// Function will get and return the list of all intents for
				// the selected intent-type/version

				const url = "/restconf/operations/ibn:search-intents";
				const body = {
					"ibn:input": {
						"filter": {
							"config-required": false,
							"intent-type-list": [
								{
									"intent-type": intent_type,
									"intent-type-version": intent_type_version
								}
							]
						},							
						"page-number": 0,
						"page-size": 1000
					}
				};

				const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Getting list of intents failed!", await response.json());

				const json = await response.json();
				const output = json["ibn:output"];

				if (output["total-count"]>1000)
					vscode.window.showWarningMessage("More than 1000 intents found. Only showing the first 1000.");

				if ('intent' in output.intents) {
					this.intentTypes[intent_type_folder].intents = output.intents.intent.reduce((intents: any, item: { [key: string]: any; target: string; }) => {
						return {...intents, [item.target]: item["intent-specific-data"]};
					}, {});
					this.intentTypes[intent_type_folder].aligned = output.intents.intent.reduce((intents: any, item: { [key: string]: any; target: string; }) => {
						return {...intents, [item.target]: item["aligned"]==="true"};
					}, {});
					this.intentTypes[intent_type_folder].desired = output.intents.intent.reduce((intents: any, item: { [key: string]: any; target: string; }) => {
						if (item["required-network-state"] === "custom")
							return {...intents, [item.target]: item["custom-required-network-state"]};
						else
							return {...intents, [item.target]: item["required-network-state"]};
					}, {});
					// result = output.intents.intent.map((entry: { target: string; }) => [entry.target, vscode.FileType.File]);
					// proposed change:
					result = output.intents.intent.map((entry: { target: string; }) => [encodeURIComponent(entry.target)+".json", vscode.FileType.File]);
				} else {
					this.intentTypes[intent_type_folder].intents = {};
				}
			}

			else if (parts[2]==='yang-modules') {
				result = this.intentTypes[intent_type_folder].data.module.map((entry: { name: string; }) => [entry.name, vscode.FileType.File]);
			}

			else if (parts[2]==='views') {
				// readDirectory() was executed with 3rd level folder for views:
				// "im:/{intent-type}_v{version}/views/"
				//
				// Function will get and return the list of all views for
				// the selected intent-type/version

				const url = "/restconf/data/nsp-intent-type-config-store:intent-type-config/intent-type-configs="+intent_type+","+intent_type_version;
				const response: any = await this._callNSP(url, {method: "GET"});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Getting list of views failed!", await response.json());
	
				const json = await response.json();

				this.intentTypes[intent_type_folder].views={};
				for (const view of json["nsp-intent-type-config-store:intent-type-configs"][0]["views"]) {
					result.push([view.name+".viewConfig", vscode.FileType.File]);
					this.intentTypes[intent_type_folder].views[view.name+".viewConfig"] = JSON.parse(view.viewconfig);

					result.push([view.name+".schemaForm", vscode.FileType.File]);
					this.intentTypes[intent_type_folder].views[view.name+".schemaForm"] = JSON.parse(view.schemaform);
				}
			}

			else if (parts[2]==='intent-type-resources') {
				const intentTypeData = this.intentTypes[intent_type_folder].data;

				if ('resource' in intentTypeData) {
					const folders = new Set<string>();
					const prefix = parts.slice(3).join("/")+'/';

					for (const resource of intentTypeData.resource)
						if (parts.length===3 || resource.name.startsWith(prefix)) {
							const relparts = resource.name.split('/').slice(parts.length - 3);
							
							if (relparts.length===1)
								result.push([relparts[0], vscode.FileType.File]);
							else
								folders.add(relparts[0]);
						}

					for (const folder of folders)
						result.push([folder, vscode.FileType.Directory]);
				}
			}

			else {
				// unknown folder, return nothing
			}
		}

		this.pluginLogs.info("readDirectory("+path+") returns", JSON.stringify(result));
		return result;
	}

	/**
	 * vsCode.FileSystemProvider method to read file content into
	 * an editor window.
	 * 
	 * IntentManagerProvider will not reach out to NSP to read files,
	 * instead is uses the copy stored in memory.
	 * 
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 * 
	 */

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)_v\d+$/;

		if (pattern.test(parts[1])) {
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];
	
			this.pluginLogs.debug("readFile("+path+")");
			if (!(intent_type_folder in this.intentTypes)) {
				this.pluginLogs.info("Intent-type",intent_type_folder, "not yet(?) in cache! Calling readDirectory(im:/) to populate/update cache.");
				await this.readDirectory(vscode.Uri.parse('im:/'));
			}

			if (intent_type_folder in this.intentTypes) {
				if (parts[2]==="meta-info.json") {
					// meta is deep-copy of cache-entry
					const meta = JSON.parse(JSON.stringify(this.intentTypes[intent_type_folder].data));

					meta["intent-type"] = intent_type;
					meta["version"] = intent_type_version;
					const forCleanup = ["default-version", "supports-health",	"skip-device-connectivity-check", "support-aggregated-request",	"resource",	"name",	"date",	"module", "script-content"];
					for (const parameter of forCleanup) delete meta[parameter];
					
					return Buffer.from(JSON.stringify(meta, null, '  '));
				}

				if (parts[2].startsWith('script-content'))
					return Buffer.from(this.intentTypes[intent_type_folder].data["script-content"]);

				if (parts[2]==="yang-modules") {
					for (const module of this.intentTypes[intent_type_folder].data.module)
						if (module.name === parts[3])
							return Buffer.from(module["yang-content"]);
				}

				if (parts[2]==="intent-type-resources") {
					for (const resource of this.intentTypes[intent_type_folder].data.resource)
						if (resource.name === parts.slice(3).join("/"))
							if (resource.name.endsWith('.viewConfig'))
								return Buffer.from(JSON.stringify(JSON.parse(resource.value), null, '  '));
							else 
								return Buffer.from(resource.value);
				}

				if (parts[2]==="intents") {
					const target = decodeURIComponent(parts[3].slice(0,-5));
					if (target in this.intentTypes[intent_type_folder].intents)
						return Buffer.from(JSON.stringify(this.intentTypes[intent_type_folder].intents[target], null, '  '));
				}

				if (parts[2]==="views")
					return Buffer.from(JSON.stringify(this.intentTypes[intent_type_folder].views[parts[3]], null, '  '));
			}
		}

		throw vscode.FileSystemError.FileNotFound('Unknown file!');
	}

	/**
	 * vsCode.FileSystemProvider method to get details about files and folders.
	 * Returns type (file/directory), timestamps (create/modify), file size,
	 * and access permissions (read/write).
	 * 
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 * 
	 */	

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)_v\d+$/;

		if (path==="im:/") {
			this.pluginLogs.debug("stat(im:/)");
			return {type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0, permissions: vscode.FilePermission.Readonly};
		}

		if (pattern.test(parts[1])) {
			this.pluginLogs.debug("stat("+path+")");

			const intent_type_folder = parts[1];
			if (!(intent_type_folder in this.intentTypes)) {
				this.pluginLogs.info("Intent-type", intent_type_folder, "not yet(?) in cache! Calling readDirectory(im:/) to populate/update cache.");
				await this.readDirectory(vscode.Uri.parse('im:/'));
			}

			if (intent_type_folder in this.intentTypes) {
				const timestamp = this.intentTypes[intent_type_folder].timestamp;
				const access = this.intentTypes[intent_type_folder].signed? vscode.FilePermission.Readonly : undefined;

				if (parts.length===2)
					return { type: vscode.FileType.Directory, ctime: 0, mtime: timestamp, size: 0 };
				
				if (parts[2]==="yang-modules") {
					if (parts.length===3)
						return {type: vscode.FileType.Directory, ctime: 0, mtime: timestamp, size: 0, permissions: vscode.FilePermission.Readonly};

					for (const module of this.intentTypes[intent_type_folder].data.module)
						if (module.name === parts[3])
							return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0, permissions: access};

					this.pluginLogs.warn("Module "+parts[3]+" not found!");				
				}
		
				if (parts[2]==="intent-type-resources") {
					const resourcename = parts.slice(3).join("/");
					if (parts.length===3) {
						return {type: vscode.FileType.Directory, ctime: 0, mtime: timestamp, size: 0, permissions: vscode.FilePermission.Readonly};
					}
					for (const resource of this.intentTypes[intent_type_folder].data.resource) {
						if (resource.name === resourcename)
							return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0, permissions: access};
						if (resource.name.startsWith(resourcename))
							return {type: vscode.FileType.Directory, ctime: 0, mtime: timestamp, size: 0, permissions: vscode.FilePermission.Readonly};
					}
					this.pluginLogs.warn("Resource "+resourcename+" not found!");
				}
		
				if (parts[2]==="views") {
					if (parts.length===3)
						return {type: vscode.FileType.Directory, ctime: 0, mtime: timestamp, size: 0, permissions: vscode.FilePermission.Readonly};

					if (parts[3] in this.intentTypes[intent_type_folder].views)
						if (parts[3].endsWith(".viewConfig"))
							return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0};
						else
							return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0, permissions: vscode.FilePermission.Readonly};

					this.pluginLogs.warn("View "+parts[3]+" not found!");
				}

				else if (parts[2]==="intents") {
					if (parts.length===3)
						return {type: vscode.FileType.Directory, ctime: 0, mtime: Date.now(), size: 0, permissions: vscode.FilePermission.Readonly};
					else if (decodeURIComponent(parts[3].slice(0,-5)) in this.intentTypes[intent_type_folder].intents)
						return {type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0};
					else
						this.pluginLogs.warn('Unknown intent', uri.toString());
				}

				if (parts[2].startsWith('script-content.'))
					return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0, permissions: access};

				if (parts[2]==="meta-info.json")
					return {type: vscode.FileType.File, ctime: 0, mtime: timestamp, size: 0};

				this.pluginLogs.warn('Unknown folder/file', uri.toString());
			} else {
				this.pluginLogs.warn('Unknown intent-type', uri.toString());
			}
		}
		throw vscode.FileSystemError.FileNotFound('Unknown resouce!');
	}

	/**
	 * vsCode.FileSystemProvider method to create or update files in  NSP virtual filesystem
	 * for Intent Manager. Support intent-types, intents and views.
	 * 
	 * @param {vscode.Uri} uri URI of the file to create/update
	 * @param {Uint8Array} content content of the file
	 * @param {object} options allow/enforce to create/overwrite
	 */	

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)_v\d+$/;

		if (pattern.test(parts[1])) {
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];

			let name_changed = false;
	
			this.pluginLogs.debug("writeFile("+path+")");
			if (!(intent_type_folder in this.intentTypes)) {
				this.pluginLogs.info("Intent-type",intent_type_folder, "not yet(?) in cache! Calling readDirectory(im:/) to populate/update cache.");
				await this.readDirectory(vscode.Uri.parse('im:/'));
			}

			// Note: We can only write files if the intent-type exists and is loaded.
			if (intent_type_folder in this.intentTypes) {
				
				if (parts[2]==="intents") {
					if (parts[3].endsWith('.json')) {
						let target = decodeURIComponent(parts[3].slice(0,-5));

						if (target.endsWith(" copy") && target.slice(0,-5) in this.intentTypes[intent_type_folder].intents) {
							name_changed = true;
							target = target.slice(0,-5);
						}

						if (target in this.intentTypes[intent_type_folder].intents) {
							this.pluginLogs.info("update intent", intent_type, target);
							const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type+"/intent-specific-data";
							const body = {"ibn:intent-specific-data": JSON.parse(content.toString())};
							const response: any = await this._callNSP(url, {method: "PUT", body: JSON.stringify(body)});
							if (!response)
								throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
							if (response.ok) {
								vscode.window.showInformationMessage("Intent succesfully updated");
								this.intentTypes[intent_type_folder].intents[target] = JSON.parse(content.toString());
								this.intentTypes[intent_type_folder].aligned[target] = false;
								this._eventEmiter.fire(uri);
							} else
								this._raiseRestconfError("Update intent failed!", await response.json());
						} else {
							this.pluginLogs.info("Create new intent", intent_type, target);

							let intent : string | undefined = content.toString();
							if (!intent) {
								intent = await vscode.window.showInputBox({
									prompt: "Enter intent-specific data",
									title: "Create new intent",
									value: '{"'+intent_type+':'+intent_type+'": { [INTENT SPECIFIC DATA] }}',
									valueSelection: [intent_type.length*2+8, intent_type.length*2+30]
								});
							}
							if (!intent)
								throw vscode.FileSystemError.Unavailable('Intent creation cancelled!');

							const url = "/restconf/data/ibn:ibn";
							const body = {
								"ibn:intent": {
									"ibn:intent-specific-data": JSON.parse(intent),
									"target": target,
									"intent-type": intent_type,
									"intent-type-version": intent_type_version,
									"required-network-state": "active"
								}
							};
							
							const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
							if (!response)
								throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
							if (response.ok) {
								vscode.window.showInformationMessage("Intent succesfully created");
								this.intentTypes[intent_type_folder].intents[target] = JSON.parse(intent);
								this.intentTypes[intent_type_folder].desired[target] = "active";
								this.intentTypes[intent_type_folder].aligned[target] = false;
							} else
								this._raiseRestconfError("Intent creation failed!", await response.json());
						}
					} else throw vscode.FileSystemError.NoPermissions("Upload intent failed! Only .json files are supported");
				}

				else if (parts[2]==="views") {
					if (parts[3].endsWith('.viewConfig')) {
						const viewname = parts[3].slice(0,-11);
						let viewjson = content.toString();

						if (!viewjson) {
							// vsCode user has execute "New File..."
							// initialize with empty JSON to pass NSP validation
							viewjson = "{}";
						}

						const url = "/restconf/data/nsp-intent-type-config-store:intent-type-config/intent-type-configs="+intent_type+","+intent_type_version;
						const body = {
							"nsp-intent-type-config-store:intent-type-configs":[{
								"views": [{
									"name": viewname,
									"viewconfig": viewjson
								}]
							}]
						};
						const response: any = await this._callNSP(url, {method: "PATCH", body: JSON.stringify(body)});
						if (!response)
							throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
						if (response.ok) {
							vscode.window.showInformationMessage("View "+intent_type_folder+"/"+viewname+"succesfully saved");
							this.intentTypes[intent_type_folder].views[viewname+".viewConfig"] = JSON.parse(viewjson);
						} else this._raiseRestconfError("Save viewConfig failed!", await response.json());
					}
					else if (parts[3].endsWith('.schemaForm'))
						throw vscode.FileSystemError.NoPermissions('You can only upload .viewConfig file! SchemaForm is auto-generated.');
					else
						throw vscode.FileSystemError.NoPermissions("Upload view failed! Only .viewConfig files are supported");
				}
				
				else {
					let data : {[key: string]: any} = {};

					if (parts[2]==="meta-info.json") {
						data = JSON.parse(content.toString());

						// adding back module, resource, script-content
						data.module = this.intentTypes[intent_type_folder].data.module;
						data.resource = this.intentTypes[intent_type_folder].data.resource;
						data['script-content'] = this.intentTypes[intent_type_folder].data['script-content'];

						data.name = intent_type;
						data.version = intent_type_version;

						delete data["intent-type"];
					} else {
						// deep-copy of what we've got in the cache
						data = JSON.parse(JSON.stringify(this.intentTypes[intent_type_folder].data));

						// update data based on file provided
						if (parts[2].startsWith("script-content")) {
							data['script-content']=content.toString();
						}
						else if (parts[2]==="intent-type-resources") {
							let updated = false;
							const resourcename = parts.slice(3).join("/");
							for (const resource of data.resource) {
								if (resource.name === resourcename) {
									resource.value=content.toString();
									updated = true;
								}
							}
							if (!updated) {
								data.resource.push({name: resourcename, value: content.toString()});
							}
						}
						else if (parts[2]==="yang-modules") {
							let updated = false;
							for (const module of data.module) {
								if (module.name === parts[3]) {
									module['yang-content']=content.toString();
									updated = true;
								}
							}
							if (!updated) {
								data.module.push({name: parts[3], "yang-content": content.toString()});
							}
						}

						const forCleanup = ["default-version"];
						for (const parameter of forCleanup) delete data[parameter];		
					}

					const url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog/intent-type="+intent_type+","+intent_type_version;
					const response: any = await this._callNSP(url, {method: "PUT", body: JSON.stringify({"ibn-administration:intent-type": data})});
					if (!response)
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					if (response.ok) {
						vscode.window.showInformationMessage(intent_type_folder+" succesfully saved");

						this.pluginLogs.info("Update intentType entry in cache");
						this.intentTypes[intent_type_folder].signed = data.label.includes('ArtifactAdmin');
						this.intentTypes[intent_type_folder].data = data;

						if (parts[2]==="meta-info.json") {
							// update decorations, just in case we've toggled between signed vs unsigned
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder));
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/meta-info.json"));
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/script-content.js"));
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/script-content.mjs"));
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/intent-type-resources"));
							this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/yang-modules"));
						}
					} else
						this._raiseRestconfError("Save intent-type failed!", await response.json());
				}

				if (name_changed) {
					this.pluginLogs.warn("Filename adjusted to match Intent Manager conventions!");
					vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
					throw vscode.FileSystemError.Unavailable("Operation was successful! Filename adjusted to match Intent Manager conventions! ");
				}

				// if .viewConfig file was successfully written,
				// refresh explorer to ensure .schemaForm is displayed correctly:

				if (parts[2]==="views")
					vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");

			} else throw vscode.FileSystemError.Unavailable("Save file failed! Unknown intent-type "+intent_type_folder+"!"); 
		} else throw vscode.FileSystemError.Unavailable("Save file failed! Unsupported folder/file!");
	}

	/**
	 * vsCode.FileSystemProvider method to delete files in  NSP virtual filesystem
	 * for Intent Manager. Support intent-types, intents and views.
	 * 
	 * @param {vscode.Uri} uri URI of the file to delete
	 */	

	async delete(uri: vscode.Uri): Promise<void> {
		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)_v\d+$/;

		if (pattern.test(parts[1])) {
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];
	
			this.pluginLogs.debug("delete("+path+")");
			if (!(intent_type_folder in this.intentTypes)) {
				this.pluginLogs.info("Intent-type",intent_type_folder, "not yet(?) in cache! Calling readDirectory(im:/) to populate/update cache.");
				await this.readDirectory(vscode.Uri.parse('im:/'));
			}

			if (intent_type_folder in this.intentTypes) {
				if (parts.length===3) {
					throw vscode.FileSystemError.NoPermissions("Deletion of "+path+" is prohibited");
				}

				let url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog/intent-type="+intent_type+","+intent_type_version;

				if (parts.length>3) {
					if (parts[2]==="intents") {
						const target = decodeURIComponent(parts[3].slice(0,-5)); // remove .json extension and decode
						url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type;
						this.pluginLogs.info("delete intent", intent_type, target);
					} else if (parts[2]==="intent-type-resources") {
						const resourcename = parts.slice(3).join("/");
						url = url+"/resource="+encodeURIComponent(resourcename);
						this.pluginLogs.info("delete resource", intent_type, resourcename);
					} else if (parts[2]==="yang-modules") {
						const modulename = parts[3];
						url = url+"/module="+modulename;
						this.pluginLogs.info("delete module", intent_type, modulename);
					} else if (parts[2]==="views") {
						const viewname = parts[3].slice(0,-11); // remove .viewConfig extension
						url = "/restconf/data/nsp-intent-type-config-store:intent-type-config/intent-type-configs="+intent_type+","+intent_type_version+"/views="+viewname;
						this.pluginLogs.info("delete view", intent_type, viewname);
					}
				} else {
					this.pluginLogs.info("delete intent-type", intent_type);

					if (Object.keys(this.intentTypes[intent_type_folder].intents).length===0)
						await this.readDirectory(vscode.Uri.joinPath(uri, "intents"));

					const targets = Object.keys(this.intentTypes[intent_type_folder].intents);
					if (targets.length > 0) {
						const selection = await vscode.window.showWarningMessage("Intent-type "+parts[1]+" is in-use! "+targets.length.toString()+" intents exist!", "Proceed","Cancel");
						if (selection === 'Proceed') {
							this.pluginLogs.info("delete all intents for", intent_type);

							for (const target of targets) {
								this.pluginLogs.info("delete intent", intent_type, target);
								const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type;

								const response: any = await this._callNSP(url, {method: "DELETE"});
								if (!response)
									throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
								if (response.ok) {
									delete this.intentTypes[intent_type_folder].aligned[target];
									delete this.intentTypes[intent_type_folder].desired[target];
									delete this.intentTypes[intent_type_folder].intents[target];																
								} else this._printRestconfError("Delete intent failed!", await response.json());
							}
						} else throw vscode.FileSystemError.NoPermissions('Operation cancelled!');	
					}
				}

				const response: any = await this._callNSP(url, {method: "DELETE"});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Delete intent-type failed!", await response.json());

				// Deletion was successful, let's update the cache
				if (parts.length>3) {
					if (parts[2]==="intents") {
						const target = decodeURIComponent(parts[3].slice(0,-5));
						delete this.intentTypes[intent_type_folder].aligned[target];
						delete this.intentTypes[intent_type_folder].desired[target];
						delete this.intentTypes[intent_type_folder].intents[target];					
					} else if (parts[2]==="intent-type-resources") {
						const resourcename = parts.slice(3).join("/");
						this.intentTypes[intent_type_folder].data.resource = this.intentTypes[intent_type_folder].data.resource.filter((resource:{name:string, value:string}) => resource.name!=resourcename);
					} else if (parts[2].includes("yang-modules")) {
						const modulename = parts[3];
						this.intentTypes[intent_type_folder].data.module = this.intentTypes[intent_type_folder].data.module.filter((module:{name:string, value:string}) => module.name!=modulename);
					} else if (parts[2].includes("views")) {
						delete this.intentTypes[intent_type_folder].views[parts[3]];
						delete this.intentTypes[intent_type_folder].views[parts[3].slice(0,-11)+".schemaForm"];
						vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer"); // needed to remove schemaForm
					}
				} else {
					delete this.intentTypes[intent_type_folder];
				}
			
				vscode.window.showInformationMessage("Succesfully deleted");
			} else throw vscode.FileSystemError.Unavailable("Delete "+path+" failed! Unknown intent-type!");
		} else throw vscode.FileSystemError.Unavailable("Delete "+path+" failed! Unsupported folder/file!");
	}

	/**
	 * vsCode.FileSystemProvider method to rename folders and files.
	 * 
	 * @param {vscode.Uri} oldUri URI of the file or folder to rename
	 * @param {vscode.Uri} newUri new file/folder name to be used
	 * @param {{overwrite: boolean}} options additional options
	*/	

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
		this.pluginLogs.debug("rename(", oldUri, newUri, ")");
		throw vscode.FileSystemError.NoPermissions('Unsupported operation!');	
	}

	/**
	 * vsCode.FileSystemProvider method to create folders.
	 * 
	 * @param {vscode.Uri} uri URI of the folder to be created
	*/	

	async createDirectory(uri: vscode.Uri): Promise<void> {
		this.pluginLogs.debug("createDirectory(", uri, ")");

		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)(_v\d+)?$/;

		if (parts.length===2 && pattern.test(parts[1])) {
			await this.newIntentTypeFromTemplate([uri]);
		} else throw vscode.FileSystemError.NoPermissions('Unsupported operation!');
	}	

	// --- SECTION: vscode.FileDecorationProvider implementation ------------

	/**
	 * vscode.FileDecorationProvider method to get decorations for files and folders.
	 * Used by IntentManagerProvider to indicate signature, alignment state, ...
	 * 
	 * @param {vscode.Uri} uri URI of the folder to retrieve from NSP
	 * 
	 */

	async provideFileDecoration( uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
		const path = uri.toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)_v\d+$/;

		if (path==="im:/") {
			this.pluginLogs.debug("provideFileDecoration(im:/)");
			return DECORATION_WORKSPACE;
		}

		if (parts[0]==="im:" && pattern.test(parts[1])) {
			this.pluginLogs.debug("provideFileDecoration("+path+")");

			const intent_type_folder = parts[1];
			if (!(intent_type_folder in this.intentTypes)) {
				this.pluginLogs.info("Intent-type",intent_type_folder, "not yet(?) in cache! Calling readDirectory(im:/) to populate/update cache.");
				await this.readDirectory(vscode.Uri.parse('im:/'));
			}

			if (intent_type_folder in this.intentTypes) {
				if (parts.length===2)
					if (this.intentTypes[intent_type_folder].signed)
						return DECORATION_SIGNED;
					else
						return DECORATION_UNSIGNED;

				if (parts[2]==="views") return DECORATION_VIEWS;

				if (parts[2]==="intents") {
					if (parts.length==4) {
						const target = decodeURIComponent(parts[3].slice(0,-5));
						
						if (this.intentTypes[intent_type_folder].aligned[target])
							return DECORATION_ALIGNED;
						else
							return DECORATION_MISALIGNED;
					} else return DECORATION_INTENTS;
				}

				if (parts.length===3) {
					if (this.intentTypes[intent_type_folder].signed)
						return DECORATION_SIGNED;
					if (parts[2]==="intent-type-resources")
						return DECORATION_RESOURCES;
					if (parts[2]==="yang-modules")
						return DECORATION_MODULES;
				}
			}
		}
	}

	// --- SECTION: IntentManagerProvider specific public methods implementation ---

	async setServer(config: vscode.WorkspaceConfiguration, statusbar_server: vscode.StatusBarItem, secretStorage: vscode.SecretStorage): Promise<void> {
	
		this.pluginLogs.info('Executing SetServer()');
		let updatedServers : Array<{id: string, ip: string}> = config.get("NSPS") ?? [];
		let quickPickServers = []
		updatedServers.forEach(function (server) {
			quickPickServers.push(server.id + " | " + server.ip);
		});

		const quickPick = vscode.window.createQuickPick();
		quickPick.placeholder = 'Select NSP Server...';
		quickPick.items = quickPickServers.map(server => ({ label: server , iconPath: new vscode.ThemeIcon('vm-connect')}));
		quickPick.buttons = [ { iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Reset Credentials for an NSP...'}, { iconPath: new vscode.ThemeIcon('add'), tooltip: 'Add Server'}, { iconPath: new vscode.ThemeIcon('remove'), tooltip: 'Remove Server'}];
		quickPick.show();
		await quickPick.onDidTriggerButton(async button => { // add a server
			if ((button.iconPath as vscode.ThemeIcon).id === 'add') {
				await this.addServer(updatedServers, config);
			} else if ((button.iconPath as vscode.ThemeIcon).id === 'remove') { // remove a server
				await this.removeServer(quickPickServers, updatedServers, config);
			} else if ((button.iconPath as vscode.ThemeIcon).id === 'gear') { // re-enter credentials for an NSP
				await this.resetConnectionDetails(quickPickServers, secretStorage, config);
			}
			await this.updateSettings();
		});

		quickPick.onDidChangeSelection(async selection => { // when a server is selected
			
			let ip = selection[0].label;

			const ipRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
			const match = ip.match(ipRegex);
			if (match) {
				ip =  match[0];
			} else {
				throw new Error("No IP address found in the input string");
			}

			if (await secretStorage.get(ip + '_username') != undefined && await secretStorage.get(ip + '_password') != undefined) {	
				
				const portConfig = vscode.workspace.getConfiguration('intentManager');
	
				let serverList:any = portConfig.get("NSPS");
				if (!(await this.isPortAssociated(serverList, ip))) {
					let is_standard_port = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Connect to standard port?' });
					if (is_standard_port == 'Yes') {
						await this.setStandardPort(serverList, ip, config);
					} else {	
						await this.updateWFMPort();
						await this.updateIMPort();	
					}
				}
				await config.update('activeServer', ip, vscode.ConfigurationTarget.Workspace);
				statusbar_server.text = 'NSP: ' + ip;
				quickPick.hide();
				quickPick.dispose();
				vscode.window.showInformationMessage('Connecting to NSP: ' + ip);	
				await this.updateSettings();
			} else { // If the username and password are not cached, prompt the user for the username and password
				const usernameInput: string = await vscode.window.showInputBox({ prompt: 'Enter Username...'}) ?? '';
				const passwordInput: string = await vscode.window.showInputBox({ password: true, prompt: 'Enter Password...'}) ?? '';

				if (await this.validateNSPCredentials(ip, usernameInput, passwordInput)) {
					secretStorage.store(ip + '_username', usernameInput);
					secretStorage.store(ip + '_password', passwordInput);
					
					const portConfig = vscode.workspace.getConfiguration('intentManager');
					let serverList:any = portConfig.get("NSPS");
					
					
					if (!(await this.isPortAssociated(serverList, ip))) {
						let is_standard_port = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Connect to standard port?' });
						if (is_standard_port == 'Yes') {
							await this.setStandardPort(serverList, ip, portConfig);
						} else {	
							await this.updateWFMPort();
							await this.updateIMPort();			
						}
					}
					await config.update('activeServer', ip, vscode.ConfigurationTarget.Workspace);	
					statusbar_server.text = 'NSP: ' + ip;
					quickPick.hide();
					quickPick.dispose();
					vscode.window.showInformationMessage('Connecting to NSP: ' + ip);
					await this.updateSettings();
				} else {
					vscode.window.showErrorMessage('Invalid Credentials');
				}
			}
		});
	}

	/** 
	 * Method to add a server to the NSP List with the VsCode UI and update the global config
	 * @param {Array} updatedServers - The current list of servers
	 * @param {vscode.WorkspaceConfiguration} config - The configuration object
	*/
	public async addServer(updatedServers: Array<any>, config: vscode.WorkspaceConfiguration) {
		this.pluginLogs.info('Executing addServer()');

		const id = await vscode.window.showInputBox({ prompt: 'Enter an identifier for your NSP' });
		const ip = await vscode.window.showInputBox({ prompt: 'Enter NSP IP Address' });

		if (!id || !ip) {
			vscode.window.showErrorMessage('Please enter a valid ID and IP');
			return;
		}

		let server = {id: '', ip: ''};
		server['id'] = id;
		server['ip'] = ip;

		if (updatedServers.some(e => e.id === id) || updatedServers.some(e => e.ip === ip)) { // check if updatedServers already has this id:
			vscode.window.showErrorMessage('Server with ID or IP already exists');
		} else {
			updatedServers.push(server);
			config.update('NSPS', updatedServers, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('Server: ' + id + ' | ' + ip + ' added!');
		}
	}

		/** 
	 * Method to remove a server from the NSP List with the VsCode UI and update the global config.
	 * @param {Array} updatedServers - The current list of updated servers.
	 * @param {Array} quickPickServers - The current list of quick pick servers in format 'id | ip'.
	 * @param {vscode.WorkspaceConfiguration} config - The configuration object.
	*/
	public async removeServer(quickPickServers: Array<any>, updatedServers: Array<any>, config: vscode.WorkspaceConfiguration) {
		this.pluginLogs.info('Executing removeServer()');

		const removeQuickPick = vscode.window.createQuickPick();
		removeQuickPick.placeholder = 'Select Server to Remove...';
		removeQuickPick.items = quickPickServers.map(server => ({ label: server , iconPath: new vscode.ThemeIcon('vm-active')}));
		removeQuickPick.show();
		await removeQuickPick.onDidChangeSelection(async selection => {
			if (selection[0]) {
				let ip = selection[0].label;
				const ipRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
				const match = ip.match(ipRegex);
				if (match) {
					ip =  match[0];
				} else {
					vscode.window.showErrorMessage("No IP address found in the input string");
					return;
				}
				await vscode.window.showWarningMessage('Are you sure you want to remove ' + selection[0].label + '?', 'Yes', 'No').then(async (value) => {
					if (value === 'Yes') {
						updatedServers = this.removeObjectByIp(updatedServers, ip);
						config.update('NSPS', updatedServers, vscode.ConfigurationTarget.Global);
						vscode.window.showWarningMessage('Server: ' + ip + ' removed');
						return;
					}
				});
			}
		});
	}

	/**
	 * Method to reset the user, pass, port, of an NSP server saved in the global config's NSP List
	 * @param {Array} quickPickServers - The current list of servers in the quick pick format 'id | ip'
	 * @param {vscode.SecretStorage} secretStorage - The secret storage storing cached credentials
	 * @param {vscode.WorkspaceConfiguration} config - The configuration object
	*/
	public async resetConnectionDetails(quickPickServers: Array<any>, secretStorage: vscode.SecretStorage, config: vscode.WorkspaceConfiguration) {
		this.pluginLogs.info('Executing resetConnectionDetails()');

		const resetQuickPick = vscode.window.createQuickPick();
		resetQuickPick.placeholder = 'Select a Server To Reset Its Credentials ... ';
		resetQuickPick.items = quickPickServers.map(server => ({ label: server , iconPath: new vscode.ThemeIcon('vm-active')}));
		resetQuickPick.show();
		
		await resetQuickPick.onDidChangeSelection(async selection => {
			if (selection[0]) {
				let ip = selection[0].label;
				const ipRegex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
				const match = ip.match(ipRegex);
				if (match) {
					ip =  match[0];
				} else {
					throw new Error("No IP address found in the input string");
				}

				const usernameInput: string = await vscode.window.showInputBox({ prompt: 'Enter Username...' }) ?? '';
				const passwordInput: string = await vscode.window.showInputBox({ password: true,  prompt: 'Enter Password...' }) ?? '';
				
				if (await this.validateNSPCredentials(ip, usernameInput, passwordInput)) {
					await secretStorage.delete(ip + '_username');
					await secretStorage.delete(ip + '_password');
					await secretStorage.store(ip + '_username', usernameInput);
					await secretStorage.store(ip + '_password', passwordInput);
					vscode.window.showInformationMessage('Success! Credentials for ' + ip + ' updated');
				} else {
					vscode.window.showErrorMessage('Invalid User/Pass Credentials');
				}

				let portConfig = vscode.workspace.getConfiguration('workflowManager');
				let serverList:any = portConfig.get("NSPS");
				let is_standard_port = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Connect to standard port?' });
				
				if (is_standard_port == 'Yes') {
					await this.setStandardPort(serverList, ip, config);
				} else {
					await this.updateWFMPort();
					await this.updateIMPort();
				}
			}
		});
	}


	/**
	 * Utility Method to check wether a port is associated with an IP in the global config's NSP List
	 * @param {Array<any>} serverList - The list of servers from the global config
	 * @param {string} ip - The ip address of the server to check if it has a port
	*/
	public async isPortAssociated(serverList: Array<any>, ip: string) {
		for (let i = 0; i < serverList.length; i++) {
			if (serverList[i].ip === ip) {
				if (serverList[i].port != undefined) {
					return true;
				} 
				return false;
			}
		}
		return false;
	}

	/**
	 * Method to set a server to the standard port (443) in the global config's NSP list
	 * @param {Array<any>} serverList - The list of servers from the global config
	 * @param {string} ip - The ip address of the server to set the standard port (443)
	 * @param {vscode.WorkspaceConfiguration} config  - The configuration object
	*/
	public async setStandardPort(serverList: Array<any>, ip: string, config: vscode.WorkspaceConfiguration) {
		this.pluginLogs.info('Executing setStandardPort()');

		const server = serverList.find(server => server.ip === ip);
		if (server) {
			server.port = '443';
		}
		config.update('NSPS', serverList, vscode.ConfigurationTarget.Global);
	}

	/*
	 * Method to update the WFM NSP Lists (global config) port when the user selects a non-standard port
	*/
	public async updateWFMPort() {
		this.pluginLogs.info("Executing updateWFMPort()");

		const portConfig = vscode.workspace.getConfiguration('workflowManager');
		if (portConfig) {
			let wfmPort = await vscode.window.showInputBox({ prompt: 'Enter Port for NSP Workflow Manager...' });
			let serverList:any = portConfig.get("NSPS");
			let activeServer = portConfig.get("activeServer");

			const server = serverList.find(server => server.ip === activeServer);
			if (server) {
				server.port = wfmPort;
			}
			portConfig.update('NSPS', serverList, vscode.ConfigurationTarget.Global);
		}
	}

	/* 
	 * Method to update the IM NSP Lists (global config) port when the user selects a non-standard port
	*/
	public async updateIMPort() {
		this.pluginLogs.info("Executing updateIMPort()");

		const imConfig = vscode.workspace.getConfiguration('intentManager');
		let imPort = await vscode.window.showInputBox({ prompt: 'Enter Port for NSP Intent Manager...' });
		let serverList:any = imConfig.get("NSPS");
		let activeServer = imConfig.get("activeServer");
		
		const server = serverList.find(server => server.ip === activeServer);
		if (server) {
			server.port = imPort;
		}
		imConfig.update('NSPS', serverList, vscode.ConfigurationTarget.Global);
	}
				
	/**
	 * Update IntentManagerProvider after configuration changes
	 * 
	*/	
	public async updateSettings() {
		this.pluginLogs.info("Updating IntentManagerProvider after configuration change");
		const config = vscode.workspace.getConfiguration('intentManager');
		this.timeout = config.get("timeout") ?? 90000;
		this.fileIgnore = config.get("ignoreLabels") ?? [];
		this.parallelOps = config.get("parallelOperations.enable") ?? false;
		const nsp:string = config.get("activeServer") ?? "";
		
		let port = "";
		let serverList: any[] = config.get("NSPS") ?? [];
		const server = serverList.find(server => server.ip === nsp);
		if (server) {
			port = server.port;
		}
		
		if (nsp !== this.nspAddr || port !== this.port) {
			this.pluginLogs.warn("Disconnecting from NSP", this.nspAddr);
			await this._revokeAuthToken();
			this.nspAddr = nsp;
			this.port = port;
			await this._getNSPversion();
		}
		this.intentTypes = {};
		vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
	}

	/**
	 * Provide user-friendly representation of desired state for an intent.
	 * 
	 * @param {vscode.Uri} uri URI of an intent instance
	 * 
	 */		
	public getState(uri: vscode.Uri): string {
		const path = uri.toString();
		this.pluginLogs.debug("getState("+path+")");

		const localize: {[value: string]: string} = {
			"active":	"Active",
			"suspend":	"Suspended",
			"delete":	"Not Present",
			"saved":	"Saved",
			"planned":	"Planned",
			"deployed":	"Deployed"
		};

		const parts = path.split('/').map(decodeURIComponent);
		const intent_type_folder = parts[1];
		const target = decodeURIComponent(parts[3].slice(0,-5));
		const state = this.intentTypes[intent_type_folder].desired[target];
		return localize[state];
	}

	/**
	 * Update the network status for a intent instance(s) provided.
	 * If no intent instance is provided use the intent opened in the editor.
	 * 
	 * @param {any[]} args context used to issue command
	 * 
	 */		

	public async setState(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);

		const states: {[value: string]: string} = {
			"Active":      "active",
			"Suspended":   "suspend",
			"Not Present": "delete",
			"Saved":       "saved",
			"Planned":     "planned",
			"Deployed":    "deployed"	
		};		

		const actual = new Set();
		for (const entry of uriList) {
			actual.add(this.getState(entry));
		}

		const items = [];
		for (const state of Object.keys(states))
			if (actual.has(state))
				items.push({label:state, description:"✔"});
			else
				items.push({label:state, description:""});

		await vscode.window.showQuickPick(items).then( async selection => {
			if (selection) {
				const state = states[selection.label];
				let body={};
				if (["active", "suspend", "delete"].includes(state))
					body = {"ibn:intent": {"required-network-state": state}};
				else
					body = {"ibn:intent": {"required-network-state": "custom", "custom-required-network-state": state}};

				for (const entry of uriList) {
					this.pluginLogs.debug("setState(", entry.toString(), ")");

					const parts = entry.toString().split('/').map(decodeURIComponent);
					const target = decodeURIComponent(parts[3].slice(0,-5));
					const intent_type_folder = parts[1];
					const intent_type = intent_type_folder.split('_v')[0];

					if (this.intentTypes[intent_type_folder].desired[target] !== state) {
						const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type;
						const response: any = await this._callNSP(url, {method: "PATCH", body: JSON.stringify(body)});
						if (!response)
							throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
						if (response.ok) {
							this.intentTypes[intent_type_folder].desired[target] = state;
							vscode.window.showInformationMessage("Desired state for "+intent_type+"/"+target+" updated to '"+selection.label+"'!");
						}
					}
				}
				await vscode.commands.executeCommand("nokia-intent-manager.updateStatusBar");
			}
		});
	}

	/**
	 * Upload an intent-type from a local workspace folder to NSP Intent Manager.
	 * This is only allowed from the meta-info or script-content at this stage.
	 * 
	 * If meta-info does not contain intent-type name/version, user is prompted
	 * to provide name and version manually.
	 * 
	 * Intent-type resources can be contained in subfolder structures, as per
	 * IBN engine support. Intent-script can be called `script-content.js`
	 * (NashornJS, default) or `script-content.mjs` (GraalJS), based on the
	 * javascript engine being used.
	 * 
	 * Remind, files must be saved to disk before uploading. Unsaved changes
	 * will not be considered for uploading the intent-type.
	 * 
	 * Parameter will be URI of meta-info or script-content.
	 * 
	 * @param {any[]} args context used to issue command
	 * 
	 */	

	public async uploadIntentType(args:any[]): Promise<void> {
		const matchIntentType = /^([a-z][a-z0-9_-]+_v\d+)$/;
		const matchImportedIntentType = /^intent-([a-z][a-z0-9_-]+-v\d+)$/;

		const uri:vscode.Uri = this._getUriList(args)[0];
		const allparts = uri.toString().split('/');
		const parts:string[] = [];
		for (const part of allparts) {
			parts.push(part);
			if (matchIntentType.test(part) || matchImportedIntentType.test(part))
				break;
		}
		const path = vscode.Uri.parse(parts.join("/"));
		let intent_type_folder = parts.pop() ?? "";

		if (matchImportedIntentType.test(intent_type_folder))
			intent_type_folder = intent_type_folder.slice(7).replace(/-v(?=\d+)/, "_v"); 

		if (matchIntentType.test(intent_type_folder))
			this.pluginLogs.debug("uploadIntentType("+path.fsPath+")");
		else {
			vscode.window.showErrorMessage("Intent-type must be stored in directory {intent_type}_v{version} or intent-{intent_type}-v{version}");
			throw vscode.FileSystemError.FileNotFound("Intent-type must be stored in directory {intent_type}_v{version} or intent-{intent_type}-v{version}");
		}

		// load meta, script, resource-files, yang modules and views

		let meta:{[key:string]: any};
		if (fs.existsSync(vscode.Uri.joinPath(path, "meta-info.json").fsPath))
			meta = JSON.parse(fs.readFileSync(vscode.Uri.joinPath(path, "meta-info.json").fsPath, {encoding:'utf8', flag:'r'}));
		else {
			vscode.window.showErrorMessage("meta-info.json not found");
			throw vscode.FileSystemError.FileNotFound("meta-info.json not found");
		}

		if (fs.existsSync(vscode.Uri.joinPath(path, "script-content.js").fsPath))
			meta["script-content"] = fs.readFileSync(vscode.Uri.joinPath(path, "script-content.js").fsPath, {encoding:'utf8', flag:'r'});
		else if (fs.existsSync(vscode.Uri.joinPath(path, "script-content.mjs").fsPath))
			meta["script-content"] = fs.readFileSync(vscode.Uri.joinPath(path, "script-content.mjs").fsPath, {encoding:'utf8', flag:'r'});
		else {
			vscode.window.showErrorMessage("script-content not found");
			throw vscode.FileSystemError.FileNotFound("script-content not found");
		}

		const modules:string[] = [];
		if (fs.existsSync(vscode.Uri.joinPath(path, "yang-modules").fsPath)) {
			fs.readdirSync(vscode.Uri.joinPath(path, "yang-modules").fsPath).forEach((filename: string) => {
				if (fs.lstatSync(vscode.Uri.joinPath(path, "yang-modules", filename).fsPath).isFile() && !filename.startsWith('.')) modules.push(filename);
			});
			this.pluginLogs.info("modules: " + JSON.stringify(modules));
		} else {
			vscode.window.showErrorMessage("YANG modules not found");
			throw vscode.FileSystemError.FileNotFound("YANG modules not found");
		}

		const resources:string[] = [];
		if (fs.existsSync(vscode.Uri.joinPath(path, "intent-type-resources").fsPath)) {
			// @ts-expect-error fs.readdirSync() returns string[] for utf-8 encoding (default)
			fs.readdirSync(vscode.Uri.joinPath(path, "intent-type-resources").fsPath, {recursive: true}).forEach((filename: string) => {
				if (fs.lstatSync(vscode.Uri.joinPath(path, "intent-type-resources", filename).fsPath).isFile() && !filename.startsWith('.') && !filename.includes('/.'))
					resources.push(filename);
			});
			this.pluginLogs.info("resources: " + JSON.stringify(resources));
		} else
			vscode.window.showWarningMessage("Intent-type has no resources");

		const views:string[] = [];
		if (fs.existsSync(vscode.Uri.joinPath(path, "views").fsPath)) {
			fs.readdirSync(vscode.Uri.joinPath(path, "views").fsPath).forEach((filename: string) => {
				if (filename.endsWith(".viewConfig")) views.push(filename);
			});
			this.pluginLogs.info("views: " + JSON.stringify(views));
		}

		const intents:string[] = [];
		if (fs.existsSync(vscode.Uri.joinPath(path, "intents").fsPath)) {
			fs.readdirSync(vscode.Uri.joinPath(path, "intents").fsPath).forEach((filename: string) => {
				if (filename.endsWith(".json")) intents.push(filename);
			});
			this.pluginLogs.info("intents: " + JSON.stringify(intents));
		}

		// Intent-type meta-info.json may contain the parameter "intent-type" and "version"
		//   We always use intent-type-name and version from foldername
		//   RESTCONF API requires "name" to be added (and intent-type to be removed)
		//   RESTCONF API required "version" to be a number

		const intent_type = intent_type_folder.split('_v')[0];
		const intent_type_version = intent_type_folder.split('_v')[1];
	
		if ('intent-type' in meta && 'version' in meta && intent_type_folder!==meta["intent-type"]+"_v"+meta.version)
			vscode.window.showWarningMessage("Mismatch with meta-info: "+meta["intent-type"]+"_v"+meta.version+"! Uploading under: "+intent_type_folder);

		delete meta["intent-type"];
		meta.name = intent_type;
		meta.version = parseInt(intent_type_version);

		// IBN expects targetted-device to contain an index as key, which is not contained in exported intent-types (ZIP)
		if ('targetted-device' in meta) {
			let index=0;
			for (const entry of meta["targetted-device"]) {
				if (!('index' in entry))
					entry.index = index;
				index+=1;
			}
		}

		meta["module"]=[];
		for (const module of modules) {
			meta["module"].push({"name": module, "yang-content": fs.readFileSync(vscode.Uri.joinPath(path, "yang-modules", module).fsPath, {encoding: 'utf8', flag: 'r'})});
		}

		meta["resource"]=[];
		for (const resource of resources) {
			meta["resource"].push({"name": resource, "value": fs.readFileSync(vscode.Uri.joinPath(path, "intent-type-resources", resource).fsPath, {encoding: 'utf8', flag: 'r'})});
		}

		// Parameters "resourceDirectory" and "supported-hardware-types" are not supported in the
		// RESTCONF API payload, and must be removed.

		const undesiredAttributes = ['resourceDirectory', 'supported-hardware-types'];
		for (const key of undesiredAttributes) delete meta[key];

		// Parameter "custom-field" is provided as native JSON in "meta", but must be converted
		// to JSON string to comply to the RESTCONF API.

		if ('custom-field' in meta)
			meta["custom-field"] = JSON.stringify(meta["custom-field"]);

		if (intent_type_folder in this.intentTypes) {
			const body = {"ibn-administration:intent-type": meta};
			const url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog/intent-type="+intent_type+","+intent_type_version;

			this.pluginLogs.info("update intent-type", intent_type);
			const response: any = await this._callNSP(url, {method: "PUT", body: JSON.stringify(body)});
			if (!response)
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			if (!response.ok)
				this._raiseRestconfError("Update intent-type failed!", await response.json(), true);

			this.pluginLogs.info("Update intentType entry in cache");
			this.intentTypes[intent_type_folder].signed = meta.label.includes('ArtifactAdmin');
			this.intentTypes[intent_type_folder].data = meta;
		} else {
			const body = {"ibn-administration:intent-type": meta};
			const url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog";

			this.pluginLogs.info("create intent-type", intent_type);
			const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
			if (!response)
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			if (!response.ok)
				this._raiseRestconfError("Create intent-type failed!", await response.json(), true);

			this.pluginLogs.info("Create missing intentType entry in cache");
			this.intentTypes[intent_type_folder] = {
				signed:  meta.label.includes('ArtifactAdmin'),
				timestamp: Date.now(), // We don't have the real timestamp yet!
				data:    meta,
				intents: {},
				aligned: {},
				desired: {},
				views:   {}
			};
		}
		vscode.window.showInformationMessage("Intent-Type "+intent_type_folder+" successfully uploaded");

		// update decorations, just in case we've toggled between signed vs unsigned
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder));
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/meta-info.json"));
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/script-content.js"));
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/script-content.mjs"));
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/intent-type-resources"));
		this._eventEmiter.fire(vscode.Uri.parse("im:/"+intent_type_folder+"/yang-modules"));

		// Upload views

		for (const view of views) {
			const viewname = view.slice(0,-11);			
			const content = fs.readFileSync(vscode.Uri.joinPath(path, "views", view).fsPath, {encoding:'utf8', flag:'r'});

			const url = "/restconf/data/nsp-intent-type-config-store:intent-type-config/intent-type-configs="+intent_type+","+intent_type_version;
			const body = {
				"nsp-intent-type-config-store:intent-type-configs": [{
					"views": [{
						"name": viewname,
						"viewconfig": content
					}]
				}]
			};
			this.pluginLogs.info("upload view ", intent_type, viewname);
			const response: any = await this._callNSP(url, {method: "PATCH", body: JSON.stringify(body)});
			if (!response)
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			if (response.ok) {
				vscode.window.showInformationMessage("View "+intent_type_folder+"/"+viewname+" successfully uploaded");
				this.intentTypes[intent_type_folder].views[view] = JSON.parse(content);
			} else this._printRestconfError("Upload view(s) failed!", await response.json());
		}

		// Upload intents

		for (const filename of intents) {
			const target = decodeURIComponent(filename.slice(0,-5));
			const content = fs.readFileSync(vscode.Uri.joinPath(path, "intents", filename).fsPath, {encoding:'utf8', flag:'r'});

			if (target in this.intentTypes[intent_type_folder].intents) {
				const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type+"/intent-specific-data";
				const body = {"ibn:intent-specific-data": JSON.parse(content)};
				this.pluginLogs.info("update intent", intent_type, target);
				const response: any = await this._callNSP(url, {method: "PUT", body: JSON.stringify(body)});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (response.ok) {
					vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" successfully updated");
					this.intentTypes[intent_type_folder].intents[target] = JSON.parse(content);
					this.intentTypes[intent_type_folder].aligned[target] = false;
					this._eventEmiter.fire(vscode.Uri.parse('im:/'+intent_type_folder+'/intents/'+filename));
				} else this._printRestconfError("Update intent failed!", await response.json());
			} else {
				const url = "/restconf/data/ibn:ibn";
				const body = {
					"ibn:intent": {
						"target": target,
						"intent-type": intent_type,
						"intent-type-version": intent_type_version,
						"ibn:intent-specific-data": JSON.parse(content),
						"required-network-state": "active"
					}
				};
				this.pluginLogs.info("create intent", intent_type, target);
				const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (response.ok) {
					vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" successfully uploaded");
					this.intentTypes[intent_type_folder].intents[target] = JSON.parse(content);
					this.intentTypes[intent_type_folder].aligned[target] = false;
					this.intentTypes[intent_type_folder].desired[target] = "active";
				} else this._printRestconfError("Create intent failed!", await response.json());
			}
		}

		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");		
	}

	/**
	 * Upload an intents from a local workspace folder to NSP Intent Manager.
	 * 
	 * @param {any[]} args context used to issue command
	 * 
	 */	

	public async uploadIntents(args:any[]): Promise<void> {
		const matchIntentType = /^([a-z][a-z0-9_-]+_v\d+)$/;

		const uriList:vscode.Uri[] = this._getUriList(args);
		for (const entry of uriList) {
			const parts = entry.toString().split('/');
			const filename           = parts.pop();
			const intent_folder      = parts.pop();
			const intent_type_folder = parts.pop();

			if (intent_type_folder && matchIntentType.test(intent_type_folder) && intent_folder &&  intent_folder==="intents" && filename && filename.endsWith(".json")) {
				const intent_type = intent_type_folder.split('_v')[0];
				const intent_type_version = intent_type_folder.split('_v')[1];
				const target = decodeURIComponent(decodeURIComponent(filename.slice(0,-5)));
				const content = fs.readFileSync(entry.fsPath, {encoding:'utf8', flag:'r'});
		
				if (target in this.intentTypes[intent_type_folder].intents) {
					const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type+"/intent-specific-data";
					const body = {"ibn:intent-specific-data": JSON.parse(content)};
					this.pluginLogs.info("update intent", intent_type, target);
					const response: any = await this._callNSP(url, {method: "PUT", body: JSON.stringify(body)});
					if (!response)
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					if (response.ok) {
						vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" successfully updated");
						this.intentTypes[intent_type_folder].intents[target] = JSON.parse(content);
						this.intentTypes[intent_type_folder].aligned[target] = false;
						this._eventEmiter.fire(vscode.Uri.parse('im:/'+intent_type_folder+'/intents/'+filename));
					} else this._printRestconfError("Update intent failed!", await response.json());
				} else {
					const url = "/restconf/data/ibn:ibn";
					const body = {
						"ibn:intent": {
							"target": target,
							"intent-type": intent_type,
							"intent-type-version": intent_type_version,
							"ibn:intent-specific-data": JSON.parse(content),
							"required-network-state": "active"
						}
					};
					this.pluginLogs.info("create intent", intent_type, target);
					const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
					if (!response)
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					if (response.ok) {
						vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" successfully uploaded");
						this.intentTypes[intent_type_folder].intents[target] = JSON.parse(content);
						this.intentTypes[intent_type_folder].aligned[target] = false;
						this.intentTypes[intent_type_folder].desired[target] = "active";
					} else this._printRestconfError("Create intent failed!", await response.json());
				}
			} else {
				this.pluginLogs.warn("uploadIntent(", filename, ") failed! URI does not match expected folder structure!");
				vscode.window.showErrorMessage("Failed to upload "+entry.toString()+"! Intents must be stored in directory {intent_type}_v{version}/intents/{target}.json"); 
			}
		}
		
		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
	}

	/**
	 * Get server logs for the intent script execution from OpenSearch. Filtering is applied
	 * based on intent-type(s) or intent instances being selected.
	 * 
	 * Collection will be limited to cover the last 10min only respectively 1000 log entries.
	 * 
	 * Whenever there is a pause between two adjacent log entries for 30sec or more, an empty
	 * line will be added. This is to provide better separation between disjoint intent
	 * operations.
	 * 
	 * Logs are reordered (sorted) by the timestamp generated by the IBN engine. In some cases
	 * adjacent log entries contain the same timestamp, while displaying logs in the correct
	 * order can not be granted.
	 * 
	 * If no intent-type/intent URI is provided, all execution logs from last 10 minutes
	 * are queried.
	 * 
	 * @param {any[]} args context used to issue command
	 */	

	public async logs(args:any[]): Promise<void> {
		this.pluginLogs.debug("logs()");
		
		const query : {[key: string]: any} = {"bool": {"must": [
			{"range": {"@datetime": {"gte": "now-10m"}}},
			{"match_phrase": {"log": "\"category\":\"com.nokia.fnms.controller.ibn.impl.ScriptedEngine\""}},
			{"bool": {"should": []}}
		]}};

		const uriList:vscode.Uri[] = this._getUriList(args);
		for (const entry of uriList) {
			const parts = entry.toString().split('/').map(decodeURIComponent);

			if (parts[0]==='im:') {
				this.pluginLogs.info("get logs for "+entry.toString());
				const intent_type_folder = parts[1];
				const intent_type_version = intent_type_folder.split('_v')[1];
				const intent_type = intent_type_folder.split('_v')[0];
	
				const qentry = {"bool": {"must": [
					{"match_phrase": {"log": "\"intent_type\":\""+intent_type+"\""}},
					{"match_phrase": {"log": "\"intent_type_version\":\""+intent_type_version+"\""}}
				]}};

				if (parts.length===4 && parts[2]==="intents")
					qentry.bool.must.push({"match_phrase": {"log": "\"target\":\""+decodeURIComponent(parts[3].slice(0,-5))+"\""}});

				query.bool.must.at(2).bool.should.push(qentry);
			}
		}

		// get auth-token
		await this._getAuthToken();
		const token = await this.authToken;
		if (!token) {
			throw vscode.FileSystemError.Unavailable('NSP is not reachable');
		}

		const url = "/logviewer/api/console/proxy?path=nsp-mdt-logs-*/_search&method=GET";
		const body = {"query": query, "sort": {"@datetime": "desc"}, "size": 1000};
		
		let osdver = "2.6.0";
		if (this._fromRelease(23,11)) osdver="2.10.0";

		const response: any = await this._callNSP(url, {
			method: "POST",
			headers: {
				"Content-Type":  "application/json",
				"Cache-Control": "no-cache",
				"Osd-Version":   osdver,
				"Authorization": "Bearer " + token
			},
			body: JSON.stringify(body)
		});

		if (!response)
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		if (!response.ok)
			this._raiseRestconfError("Getting logs failed!", await response.json(), true);
		const json: any = await response.json();

		const data : {[key: string]: any}[] = json["hits"]["hits"];
		if (data.length === 0 ) {
			vscode.window.showWarningMessage("No intent operation logs for the last 10 minutes");
		} else {
			const logs : Array<any> = [];
			for (const entry of data) {
				logs.push(JSON.parse(entry['_source'].log));
			}
			logs.sort((a,b) => a['date']-b['date']);

			this.serverLogs.clear();
			this.serverLogs.show(true);

			let pdate = logs[0]['date'];
			for (const logentry of logs) {
				const timestamp = new Date(logentry['date']);
				const level = logentry['level'];
				const target = logentry['target'];
				const intent_type = logentry['intent_type'];
				const intent_type_version = logentry['intent_type_version'];
				const intent_type_folder = intent_type+"_v"+intent_type_version;

				let message = logentry['message'].slice(logentry['message'].indexOf("]")+1).trim();
				
				// insert empty line, if more than 30sec between two log entries
				if (logentry['date'] > pdate+30000)
					this.serverLogs.appendLine("");

				// avoid duplication of logging intent-type/version/target (from sf-logger.js)
				message = message.replace("["+intent_type+"]", "").replace("["+intent_type_version+"]", "").replace("["+target+"]", "").trim();

				this.serverLogs.appendLine(timestamp.toISOString().slice(-13) + " " + level+ "\t[" + intent_type_folder + ' ' + target + "] " + message);
				pdate = logentry['date'];
			}
		}
	}

	/**
	 * Execute an audit of the selected intent instance(s).
	 * Pulls the result(s) to update the intent decoration.
	 * Show details, if intent is misaligned.
	 * 
	 * @param {any[]} args context used to issue command
	 */		

	public async audit(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);
		for (const entry of uriList) {
			const parts = entry.toString().split('/').map(decodeURIComponent);

			if (parts.length===4 && parts[2]==="intents") {
				const target = decodeURIComponent(parts[3].slice(0,-5));
				const intent_type_folder = parts[1];
				const intent_type = intent_type_folder.split('_v')[0];
				const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type+"/audit";

				if (this.parallelOps && uriList.length>1) {
					this.pluginLogs.warn("parallel audit(", entry.toString(), "), EXPERIMENTAL!");

					this._callNSP(url, {method: "POST", body: ""})
					.then((response:any) => {
						if (response.ok)
							response.json().then((json:any) => {
								const report = json["ibn:output"]["audit-report"];
								if (Object.keys(report).includes("misaligned-attribute") || Object.keys(report).includes("misaligned-object") || Object.keys(report).includes("undesired-object")) {
									this.intentTypes[intent_type_folder].aligned[target]=false;
									if (uriList.length===1)
										vscode.window.showWarningMessage("Intent "+intent_type+"/"+target+" is misaligned!","Details","Cancel").then (
											async (selectedItem) => {if ('Details' === selectedItem) this._auditReport(intent_type, target, report);}
										);
									else
										vscode.window.showWarningMessage("Intent "+intent_type+"/"+target+" is misaligned!");
								} else {
									this.intentTypes[intent_type_folder].aligned[target]=true;
									vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" is aligned!");
								}
								this._eventEmiter.fire(entry);
							});
						else
							response.json().then((json:any) => this._printRestconfError("Audit intent failed!", json));
					})
					.catch((error:any) => {
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					});	
				} else {
					this.pluginLogs.debug("audit(", entry.toString(), ")");

					const response: any = await this._callNSP(url, {method: "POST", body: ""});
					if (!response)
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					if (response.ok) {
						const json : any = await response.json();
						const report = json["ibn:output"]["audit-report"];
					
						if (Object.keys(report).includes("misaligned-attribute") || Object.keys(report).includes("misaligned-object") || Object.keys(report).includes("undesired-object")) {
							this.intentTypes[intent_type_folder].aligned[target]=false;

							if (uriList.length===1)
								vscode.window.showWarningMessage("Intent "+intent_type+"/"+target+" is misaligned!","Details","Cancel").then(
									async (selectedItem) => {if ('Details' === selectedItem) this._auditReport(intent_type, target, report);}
								);
							else
								vscode.window.showWarningMessage("Intent "+intent_type+"/"+target+" is misaligned!");
						} else {
							this.intentTypes[intent_type_folder].aligned[target]=true;
							vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" is aligned!");
						}					
						this._eventEmiter.fire(entry);
					} else this._printRestconfError("Audit intent failed!", await response.json());	
				}
			}
		}
	}

	/**
	 * Pulls the result(s) of last audit to display.
	 * 
	 * @param {any[]} args context used to issue command
	 */		

	public async lastAuditReport(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);
		for (const entry of uriList) {
			this.pluginLogs.debug("lastAuditReport(", entry.toString(), ")");
			const parts = entry.toString().split('/').map(decodeURIComponent);

			if (parts.length===4 && parts[2]==="intents") {
				const target = decodeURIComponent(parts[3].slice(0,-5));
				const intent_type_folder = parts[1];
				const intent_type = intent_type_folder.split('_v')[0];
				const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type;

				const response: any = await this._callNSP(url, {method: "GET"});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Getting intent details failed!", await response.json(), true);

				const json : any = await response.json();
				const report = json["ibn:intent"]["last-audit-report"];

				if (Object.keys(report).includes("misaligned-attribute") || Object.keys(report).includes("misaligned-object") || Object.keys(report).includes("undesired-object")) {
					this._auditReport(intent_type, target, report);
				} else {
					vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" is aligned!");
				}
			}
		}
	}


	/**
	 * Execute a synchronize of the selected intent instance(s).
	 * 
	 * @param {any[]} args context used to issue command
	 */		

	public async sync(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);
		for (const entry of uriList) {
			const parts = entry.toString().split('/').map(decodeURIComponent);

			if (parts.length===4 && parts[2]==="intents") {
				const target = decodeURIComponent(parts[3].slice(0,-5));
				const intent_type_folder = parts[1];
				const intent_type = intent_type_folder.split('_v')[0];
				const url = "/restconf/data/ibn:ibn/intent="+encodeURIComponent(target)+","+intent_type+"/synchronize";

				if (this.parallelOps && uriList.length>1) {
					this.pluginLogs.warn("parallel sync(", entry.toString(), "), EXPERIMENTAL!");

					this._callNSP(url, {method: "POST", body: ""})
					.then((response:any) => {
						if (response.ok) {
							vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" synchronized!");
							this.intentTypes[intent_type_folder].aligned[target]=true;
							this._eventEmiter.fire(entry);
						} else
							response.json().then((response:any) => this._printRestconfError("Synchronize intent "+intent_type+"/"+target+" failed!", response));
					})
					.catch((error:any) => {
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					});
				} else {
					this.pluginLogs.debug("sync(", entry.toString(), ")");			

					const response: any = await this._callNSP(url, {method: "POST", body: ""});
					if (!response)
						throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
					if (response.ok) {
						vscode.window.showInformationMessage("Intent "+intent_type+"/"+target+" synchronized!");
						this.intentTypes[intent_type_folder].aligned[target]=true;
						this._eventEmiter.fire(entry);
					} else {
						this._printRestconfError("Synchronize intent failed!", await response.json());
						this.intentTypes[intent_type_folder].aligned[target]=false;
					}
				}
			}
		}
	}

	/**
	 * Open NSP WebUI Intent Manager for an intent or intent-type
	 * 
	 * @param {any[]} args context used to issue command
	 */		

	public async openInBrowser(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);

		if (uriList.length>0) {
			const path = uriList[0].toString();
			this.pluginLogs.debug("openInBrowser(", path, ")");

			if (path === "im:/") {
				if (this._fromRelease(23,11))
					// URL for new navigation since nsp23.11
					this._openWebUI("/web/intent-manager/intent-types");
				else
					this._openWebUI("/intent-manager/intentTypes");
			} else {
				const parts = path.split('/').map(decodeURIComponent);
				const intent_type_folder = parts[1];
				const intent_type_version = intent_type_folder.split('_v')[1];
				const intent_type = intent_type_folder.split('_v')[0];
					
				if (parts.length>3 && parts[2]==='intents') {
					const target = decodeURIComponent(parts[3].slice(0,-5));
					if (this._fromRelease(23,11))
						// URL for new navigation since nsp23.11
						this._openWebUI("/web/intent-manager/intent-types/intents-list/intent-details?intentTypeId="+intent_type+"&version="+intent_type_version+"&intentTargetId="+encodeURIComponent(target));
					else
						this._openWebUI("/intent-manager/intentTypes/"+intent_type+"/"+intent_type_version+"/intents/"+encodeURIComponent(target));
				} else {
					if (this._fromRelease(23,11))
						// URL for new navigation since nsp23.11
						this._openWebUI("/web/intent-manager/intent-types/intents-list?intentTypeId="+intent_type+"&version="+intent_type_version);
					else
						this._openWebUI("/intent-manager/intentTypes/"+intent_type+"/"+intent_type_version+"/intents");
				}
			}
		}
	}

	/**
	 * Open NSP WebUI Intent Manager to allow user to create new intents.
	 * 
	 * @param {any[]} args context used to issue command
	 */

	public async newIntent(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);

		if (uriList.length>0) {
			const path = uriList[0].toString();
			const parts = path.split('/').map(decodeURIComponent);
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];

			this.pluginLogs.debug("newIntent(", path, ")");

			if (this._fromRelease(23,11))
				// URL for new navigation since nsp23.11
				this._openWebUI("/web/intent-manager/intent-types/create-intent?intentTypeId="+intent_type+"&version="+intent_type_version);
			else
				this._openWebUI("/intent-manager/intentTypes/"+intent_type+"/"+intent_type_version+"/intents/createIntent");
		}
	}

	/**
	 * Creates a new intent-type version for the selected intent-type.
	 * 
	 * @param {any[]} args context used to issue command
	 */

	public async newVersion(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);

		if (uriList.length>0) {
			const path = uriList[0].toString();
			const parts = path.split('/').map(decodeURIComponent);
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];

			this.pluginLogs.debug("newVersion(", path, ")");
	
			const url = "/mdt/rest/ibn/save/"+intent_type+"/"+intent_type_version;
			const response: any = await this._callNSP(url, {method: "POST", body: "{}"});
			if (!response)
				throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
			if (!response.ok)
				this._raiseRestconfError("Intent-type version creation failed!", await response.json(), true);

			vscode.window.showInformationMessage("New version created for intent-type "+intent_type);
			vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
		}
	}

	/**
	 * Cloning selected intent-type.
	 * 
	 * @param {any[]} args context used to issue command
	 */
	
	public async clone(args:any[]): Promise<void> {
		const uriList:vscode.Uri[] = this._getUriList(args);

		if (uriList.length>0) {
			const path = uriList[0].toString();
			const parts = path.split('/').map(decodeURIComponent);
			const intent_type_folder = parts[1];
			const intent_type_version = intent_type_folder.split('_v')[1];
			const intent_type = intent_type_folder.split('_v')[0];

			this.pluginLogs.debug("clone(", path, ")");

			const new_intent_type = await vscode.window.showInputBox({
				placeHolder: "Intent Name",
				prompt: "Provide a name for the new intent-type",
				value: intent_type+"_copy"
			});

			if (new_intent_type) {
				if ((new_intent_type+"_v1") in this.intentTypes) {
					vscode.window.showErrorMessage("The intent-type "+new_intent_type+" already exists!");
					throw vscode.FileSystemError.FileExists("The intent-type "+new_intent_type+" already exists!");
				}

				const url = "/mdt/rest/ibn/save/"+intent_type+"/"+intent_type_version+"?newIntentTypeName="+new_intent_type;		
				const response: any = await this._callNSP(url, {method: "POST", body: "{}"});
				if (!response)
					throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
				if (!response.ok)
					this._raiseRestconfError("Intent-type cloning failed!", await response.json(), true);

				vscode.window.showInformationMessage("New intent-type "+new_intent_type+" created!");
				vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
			}
		}
	}

	/**
	 * Interactive creation of new intent-type from template.
	 * 
	 * @param {any[]} args context used to issue command (not used yet)
	 */

	public async newIntentTypeFromTemplate(args:any[]): Promise<void> {
		const path = this._getUriList(args)[0].toString();
		const parts = path.split('/').map(decodeURIComponent);
		const pattern = /^([a-z][a-z0-9_-]+)(_v\d+)?$/;

		let intent_type_name = "default";
		if (parts.length===2 && pattern.test(parts[1]))
			intent_type_name = parts[1].replace(/_v\d+$/, "");

		const data:{
			intent_type: string|undefined,
			author:string|undefined,
			template:string|undefined,
			date:string|undefined
		} = {
			intent_type: intent_type_name,
			author: "NSP DevOps",
			template: "none",
			date: new Date().toISOString().slice(0,10)
		};

		// todo: Using multi-step input using QuickPick and InputBox
		//   https://github.com/microsoft/vscode-extension-samples/tree/main/quickinput-sample
		//
		// desired improvements:
		//   navigation between the steps (forward/backward)
		//   instant validation (intent-types exist, all small caps, ...)

		data.intent_type = await vscode.window.showInputBox({
			title: "Create intent-type | Step 1 NAME",
			prompt: "Provide a name for the new intent-type!",
			value: data.intent_type
		});
		if (!data.intent_type) return;

		if ((data.intent_type+"_v1") in this.intentTypes)
			throw vscode.FileSystemError.FileExists("Intent-type already exists! Use unique intent-type name!");

		data.author = await vscode.window.showInputBox({
			title: "Create intent-type | Step 2 AUTHOR",
			prompt: "Provide an author for the new intent",
			value: data.author
		});
		if (!data.author) return;

		const templatesInfoPath = vscode.Uri.joinPath(this.extensionUri, 'templates', 'templates.json').fsPath;
		const items:{label:string, description:string}[] = JSON.parse(fs.readFileSync(templatesInfoPath, {encoding:'utf8', flag:'r'})).templates;

        const selection = await vscode.window.showQuickPick(items, { title: "Create intent-type | Step 3 TEMPLATE" });
        if (selection) data.template = selection.label; else return;

		const templatePath = vscode.Uri.joinPath(this.extensionUri, 'templates', data.template);
		if (!fs.existsSync(vscode.Uri.joinPath(templatePath, 'meta-info.json').fsPath)) {
			vscode.window.showErrorMessage("meta-info.json not found");
			return;
		}
		const j2root = nunjucks.configure(templatePath.fsPath);
		const meta:{[key:string]: any} = JSON.parse(j2root.render('meta-info.json', data));

		if (!('mapping-engine' in meta))
			meta["mapping-engine"] = 'js-scripted';

		let script: string|undefined;
		switch(meta["mapping-engine"]) {
			case 'js-scripted':
				script = 'script-content.js';
				break;
			case 'js-scripted-graal':
				script = 'script-content.mjs';
				break;
		}
		if (!script) {
			vscode.window.showErrorMessage("Unsupported mapping-engine "+meta["mapping-engine"]+"!");
			return;
		}
		if (!fs.existsSync(vscode.Uri.joinPath(templatePath, script).fsPath)) {
			vscode.window.showErrorMessage(script+" not found");
			return;
		}
		meta["script-content"] = j2root.render(script, data);

		if (!fs.existsSync(vscode.Uri.joinPath(templatePath, "yang-modules").fsPath)) {
			vscode.window.showErrorMessage("YANG modules not found");
			return;
		}
		if (!fs.existsSync(vscode.Uri.joinPath(templatePath, "yang-modules", "[intent_type].yang").fsPath)) {
			vscode.window.showErrorMessage("Intent-type templates must have '[intent_type].yang' module!");
			return;
		}

		const modulesPath = vscode.Uri.joinPath(templatePath, "yang-modules").fsPath;
		const j2modules = nunjucks.configure(modulesPath);

		if (!('module' in meta)) meta.module=[];
		fs.readdirSync(modulesPath).forEach((filename: string) => {
			const fullpath = vscode.Uri.joinPath(templatePath, "yang-modules", filename).fsPath;
			if (!fs.lstatSync(fullpath).isFile())
				this.pluginLogs.info("ignore "+filename+" (not a file)");
			else if (filename.startsWith('.'))
				this.pluginLogs.info("ignore hidden file "+filename);
			else if (filename!="[intent_type].yang")
				meta.module.push({name: filename, "yang-content": fs.readFileSync(fullpath, {encoding: 'utf8', flag: 'r'})});
			else
				meta.module.push({name: data.intent_type+".yang", "yang-content": j2modules.render(filename, data)});
		});

		const resourcesPath = vscode.Uri.joinPath(templatePath, "intent-type-resources").fsPath;
		const j2resources = nunjucks.configure(resourcesPath);

		const resourcefiles:string[] = [];
		if (!('resource' in meta)) meta.resource=[];
		if (fs.existsSync(resourcesPath))
			// @ts-expect-error fs.readdirSync() returns string[] for utf-8 encoding (default)
			fs.readdirSync(resourcesPath, {recursive: true}).forEach((filename: string) => {
				const fullpath = vscode.Uri.joinPath(templatePath, "intent-type-resources", filename).fsPath;
				if (!fs.lstatSync(fullpath).isFile())
					this.pluginLogs.info("ignore "+filename+" (not a file)");
				else if (filename.startsWith('.') || filename.includes('/.'))
					this.pluginLogs.info("ignore hidden file/folder "+filename);
				else
					meta.resource.push({name: filename, value: j2resources.render(filename, data)});

				resourcefiles.push(filename);
			});
		else vscode.window.showWarningMessage("Intent-type template has no resources");

		// merge common resources

		if (fs.existsSync(vscode.Uri.joinPath(templatePath, "merge_common_resources").fsPath)) {
			const commonsPath = vscode.Uri.joinPath(this.extensionUri, 'templates', 'common-resources');
			const j2resources = nunjucks.configure(commonsPath.fsPath);

			// @ts-expect-error fs.readdirSync() returns string[] for utf-8 encoding (default)
			fs.readdirSync(commonsPath.fsPath, {recursive: true}).forEach((filename: string) => {
				const fullpath = vscode.Uri.joinPath(commonsPath, filename).fsPath;
				if (!fs.lstatSync(fullpath).isFile())
					this.pluginLogs.info("ignore "+filename+" (not a file)");
				else if (filename.startsWith('.') || filename.includes('/.'))
					this.pluginLogs.info("ignore hidden file/folder "+filename);
				else if (resourcefiles.includes(filename))
					this.pluginLogs.info(filename+" (common) skipped, overwritten in template");
				else
					meta.resource.push({name: filename, value: j2resources.render(filename, data)});
			});
		}
	
		// Intent-type "meta" may contain the parameter "intent-type"
		// RESTCONF API required parameter "name" instead

		meta.name = data.intent_type;
		meta.version = 1;
		delete meta["intent-type"];

		// IBN expects targetted-device to contain an index as key, which is not contained in exported intent-types (ZIP)
		if ('targetted-device' in meta) {
			let index=0;
			for (const entry of meta["targetted-device"]) {
				if (!('index' in entry)) entry.index = index;
				index+=1;
			}
		}
	
		vscode.window.showInformationMessage("Creating new Intent-Type");
		const body = {"ibn-administration:intent-type": meta};
		const url = "/restconf/data/ibn-administration:ibn-administration/intent-type-catalog";
		const response: any = await this._callNSP(url, {method: "POST", body: JSON.stringify(body)});
		if (!response)
			throw vscode.FileSystemError.Unavailable("Lost connection to NSP");
		if (!response.ok)
			this._raiseRestconfError("Create intent-type failed!", await response.json(), true);

		vscode.window.showInformationMessage("Intent-Type "+data.intent_type+" successfully created!");
		vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");			
	}

	public getStatusBarItem(): vscode.StatusBarItem {
		return myStatusBarItem;
	}

	// --- SECTION: vscode.CodeLensProvider implementation ----------------

	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		const topOfDocument = new vscode.Range(0, 0, 0, 0);

		const command = {
			title: 'Intent Manager at '+this.nspAddr+' by NOKIA',
			command: 'nokia-intent-manager.openInBrowser'
		};
	
		const codeLens = new vscode.CodeLens(topOfDocument, command);
		return [codeLens];
	}

	// --- SECTION: Manage file events --------------------------------------

	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	watch(_resource: vscode.Uri): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}	
}