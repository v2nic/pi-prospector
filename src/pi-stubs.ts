/**
 * Local type stubs for @earendil-works/pi-coding-agent.
 *
 * The real package is a private peer dependency not available in CI.
 * These stubs let us compile without it. At runtime, Pi provides the real types.
 *
 * Types derived from pi-coding-agent v0.74+ ExtensionAPI.
 */

import type { Static, TSchema } from "typebox";

// ── Theme stub (sufficient for our needs) ──

export interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

// ── UI Context ──

export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;
	/** Set the working/loading message shown during streaming. */
	setWorkingMessage(message?: string): void;
	/** Set a widget to display above or below the editor. */
	setWidget(key: string, content: string[] | undefined): void;
	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;
	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
	/** Get the current theme for styling. */
	readonly theme: Theme;
}

export interface ExtensionUIDialogOptions {
	/** timeout in ms */
	timeout?: number;
}

// ── Model stubs ──

export interface Model {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface AuthStorage {
	resolveApiKey(provider: string): Promise<string | undefined>;
}

export interface ModelRegistry {
	/** Find a model by provider name and model ID pattern. */
	find(provider: string, pattern: string): Model | undefined;
	/** Get API key for a provider. */
	getApiKey(provider: string): string | undefined;
	/** Auth storage for runtime API key resolution. */
	authStorage: AuthStorage;
	/** List all available models. */
	listModels(): Model[];
}

// ── Session Manager (read-only subset) ──

export interface ReadonlySessionManager {
	getEntries(): SessionEntry[];
	getBranch(): string;
	getLeafId(): string;
}

export interface SessionEntry {
	id: string;
	type: string;
	content: unknown;
	timestamp: number;
}

// ── Context Types ──

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	model: Model | undefined;
	isIdle(): boolean;
	signal: AbortSignal | undefined;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getContextUsage(): ContextUsage | undefined;
	compact(options?: { customInstructions?: string }): void;
	getSystemPrompt(): string;
}

export interface ExtensionCommandContext extends ExtensionContext {
	waitForIdle(): Promise<void>;
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: unknown) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
}

// ── Tool Definition ──

export interface ToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mediaType: string }>;
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

// ── Command Registration ──

export interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ── Event handler types ──

export type ExtensionHandler<TEvent = unknown, TResult = void> = (
	event: TEvent,
	ctx: ExtensionContext,
) => Promise<TResult | undefined | void> | TResult | undefined | void;

// ── Extension API ──

export interface ExtensionAPI {
	// Event subscriptions
	on(event: "session_start", handler: ExtensionHandler): void;
	on(event: "session_shutdown", handler: ExtensionHandler): void;
	on(event: "tool_call", handler: ExtensionHandler): void;
	on(event: "tool_result", handler: ExtensionHandler): void;
	on(event: "before_agent_start", handler: ExtensionHandler): void;
	on(event: "agent_start", handler: ExtensionHandler): void;
	on(event: "agent_end", handler: ExtensionHandler): void;
	on(event: "model_select", handler: ExtensionHandler): void;
	on(event: string, handler: ExtensionHandler): void;

	// Tool registration
	registerTool<TParams extends TSchema = TSchema>(tool: {
		name: string;
		label: string;
		description: string;
		parameters: TParams;
		execute: (
			toolCallId: string,
			params: Static<TParams>,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: ExtensionContext,
		) => Promise<ToolResult>;
	}): void;

	// Command registration
	registerCommand(name: string, options: RegisteredCommand): void;

	// Keyboard shortcuts
	registerShortcut(shortcut: string, options: {
		description?: string;
		handler: (ctx: ExtensionContext) => Promise<void> | void;
	}): void;

	// CLI flags
	registerFlag(name: string, options: {
		description?: string;
		type: "boolean" | "string";
		default?: boolean | string;
	}): void;
	getFlag(name: string): boolean | string | undefined;

	// Messaging
	sendUserMessage(content: string, options?: {
		deliverAs?: "steer" | "followUp";
	}): void;

	// Session persistence
	appendEntry<T = unknown>(customType: string, data?: T): void;
	setSessionName(name: string): void;
	getSessionName(): string | undefined;

	// Shell execution
	exec(command: string, args: string[], options?: {
		signal?: AbortSignal;
		timeout?: number;
		cwd?: string;
	}): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

	// Tool management
	getActiveTools(): string[];
	getAllTools(): Array<{ name: string; description: string; parameters: unknown }>;

	// Model management
	setModel(model: Model): Promise<boolean>;

	// Provider registration
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
}

// ── Provider Config ──

export type Api = "openai-completions" | "anthropic-messages" | "openai-responses" | string;

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
}

export interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model, context: unknown, options?: unknown) => unknown;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: unknown): Promise<unknown>;
		refreshToken(credentials: unknown): Promise<unknown>;
		getApiKey(credentials: unknown): string;
	};
}