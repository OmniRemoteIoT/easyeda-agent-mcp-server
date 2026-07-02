import * as extensionConfig from '../../extension.json';
import { connectToMcpServer, disconnectFromMcpServer } from './ws-client';

let connected = false;

export function activate(status?: 'onStartupFinished', arg?: string): void {
	// Auto-connect on startup so no manual "Connect Claude" click is needed
	if (!connected) {
		try {
			connectToMcpServer(extensionConfig.uuid);
			connected = true;
		} catch {
			// Silently fail on startup — user can manually connect via menu
		}
	}
}

export function connectClaude(): void {
	// Always close first — the connection may have dropped silently (no onClose callback in the API)
	if (connected) {
		try {
			disconnectFromMcpServer(extensionConfig.uuid);
		} catch {
			// Ignore — may already be closed
		}
		connected = false;
	}
	try {
		connectToMcpServer(extensionConfig.uuid);
		connected = true;
	} catch (err: any) {
		eda.sys_Dialog.showErrorMessage(
			`Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
			'Connection Error',
		);
	}
}

export function disconnectClaude(): void {
	if (!connected) {
		eda.sys_Message.showWarningMessage('Not connected to Claude MCP Server');
		return;
	}
	disconnectFromMcpServer(extensionConfig.uuid);
	connected = false;
	eda.sys_Message.showMessage('Disconnected from Claude MCP Server');
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		`EasyEDA Agent - MCP Bridge for Claude Code\nVersion ${extensionConfig.version}`,
		'About',
	);
}
