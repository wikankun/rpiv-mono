/**
 * rpiv-web-tools — body
 *
 * Provides `web_search` and `web_fetch` tools backed by the Brave Search API,
 * plus the `/web-search-config` slash command for API key entry.
 *
 * API key resolution precedence (first wins):
 *   1. BRAVE_SEARCH_API_KEY environment variable
 *   2. apiKey field in ~/.config/rpiv-web-tools/config.json
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Tunables and external surface
// ---------------------------------------------------------------------------

const BRAVE_SEARCH_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_API_KEY_ENV_VAR = "BRAVE_SEARCH_API_KEY";

const MIN_SEARCH_RESULTS = 1;
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_SEARCH_RESULTS = 5;

const SEARCH_RESULT_PREVIEW_LIMIT = 5;
const FETCH_PREVIEW_LINE_LIMIT = 15;
const API_KEY_MASK_VISIBLE_CHARS = 4;

const USER_AGENT = "Mozilla/5.0 (compatible; rpiv-pi/1.0)";
const FETCH_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5";

const FETCH_TEMP_DIR_PREFIX = "rpiv-fetch-";
const FETCH_TEMP_FILE_NAME = "content.txt";

const CONFIG_DIR = join(homedir(), ".config", "rpiv-web-tools");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const CONFIG_FILE_MODE = 0o600;

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const BINARY_CONTENT_TYPE_PREFIXES = ["image/", "video/", "audio/"];
const HTML_CONTENT_TYPE_TOKEN = "text/html";

const SEARCH_BACKEND_NAME = "brave";
const WEB_SEARCH_CONFIG_COMMAND_NAME = "web-search-config";
const SHOW_FLAG = "--show";
const UNSET_LABEL = "(not set)";

// ---------------------------------------------------------------------------
// Config file persistence
// ---------------------------------------------------------------------------

interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface WebToolsGuidance {
	web_search?: GuidanceFields;
	web_fetch?: GuidanceFields;
}

interface WebToolsConfig {
	apiKey?: string;
	guidance?: WebToolsGuidance;
}

function loadConfig(): WebToolsConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WebToolsConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: WebToolsConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	try {
		chmodSync(CONFIG_PATH, CONFIG_FILE_MODE);
	} catch {
		// chmod may fail on some filesystems — best effort only
	}
}

// ---------------------------------------------------------------------------
// Executor guidance — overrides + defaults
// ---------------------------------------------------------------------------

function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	return result;
}

export const DEFAULT_WEB_SEARCH_SNIPPET = "Search the web for up-to-date information via Brave";
export const DEFAULT_WEB_SEARCH_GUIDELINES: string[] = [
	"Use web_search for information beyond your training data — recent events, current library versions, live API documentation.",
	'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
	'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
	"Domain filtering is supported to include or block specific websites.",
	"If BRAVE_SEARCH_API_KEY is not set, ask the user to run /web-search-config before proceeding.",
];

export const DEFAULT_WEB_FETCH_SNIPPET = "Fetch and read content from a specific URL";
export const DEFAULT_WEB_FETCH_GUIDELINES: string[] = [
	"Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
	"web_fetch is complementary to web_search: search finds URLs, fetch reads them.",
	'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the fetched URL.',
	"Large responses are truncated and spilled to a temp file — the temp path is reported in the result details.",
];

// ---------------------------------------------------------------------------
// API key resolution + masking
// ---------------------------------------------------------------------------

function readApiKeyFromEnv(): string | undefined {
	const key = process.env[BRAVE_API_KEY_ENV_VAR];
	return key?.trim() || undefined;
}

function readApiKeyFromConfig(): string | undefined {
	return loadConfig().apiKey?.trim() || undefined;
}

function resolveApiKey(): string | undefined {
	return readApiKeyFromEnv() ?? readApiKeyFromConfig();
}

function maskApiKey(key: string | undefined): string {
	if (!key) return UNSET_LABEL;
	const head = key.slice(0, API_KEY_MASK_VISIBLE_CHARS);
	const tail = key.slice(-API_KEY_MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

// ---------------------------------------------------------------------------
// Brave Search API client
// ---------------------------------------------------------------------------

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearchResponse {
	query: string;
	results: SearchResult[];
}

function buildBraveSearchUrl(query: string, count: number): string {
	const url = new URL(BRAVE_SEARCH_API_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	return url.toString();
}

function buildBraveRequestHeaders(apiKey: string): Record<string, string> {
	return {
		Accept: "application/json",
		"Accept-Encoding": "gzip",
		"X-Subscription-Token": apiKey,
	};
}

interface BraveRawResponse {
	web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

function normalizeBraveResults(raw: BraveRawResponse): SearchResult[] {
	return (raw.web?.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

async function searchBrave(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const apiKey = resolveApiKey();
	if (!apiKey) {
		throw new Error(
			`${BRAVE_API_KEY_ENV_VAR} is not set. Run /${WEB_SEARCH_CONFIG_COMMAND_NAME} to configure, or export the env var.`,
		);
	}

	const res = await fetch(buildBraveSearchUrl(query, maxResults), {
		method: "GET",
		headers: buildBraveRequestHeaders(apiKey),
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Brave Search API error (${res.status}): ${text}`);
	}

	const raw = (await res.json()) as BraveRawResponse;
	return { query, results: normalizeBraveResults(raw) };
}

function clampSearchResultCount(requested: number | undefined): number {
	const value = requested ?? DEFAULT_SEARCH_RESULTS;
	return Math.min(Math.max(value, MIN_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
}

// ---------------------------------------------------------------------------
// HTML-to-text extraction
// ---------------------------------------------------------------------------

const SCRIPT_BLOCK_REGEX = /<script[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_REGEX = /<style[\s\S]*?<\/style>/gi;
const NOSCRIPT_BLOCK_REGEX = /<noscript[\s\S]*?<\/noscript>/gi;
const BLOCK_CLOSER_REGEX =
	/<\/(p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav|details|summary)>/gi;
const SELF_CLOSING_BR_REGEX = /<br\s*\/?>/gi;
const ANY_REMAINING_TAG_REGEX = /<[^>]+>/g;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;
const NUMERIC_HTML_ENTITY_REGEX = /&#(\d+);/g;
const HORIZONTAL_WHITESPACE_RUN = /[ \t]+/g;
const BLANK_LINE_RUN = /\n{3,}/g;

function stripNonContentBlocks(html: string): string {
	return html.replace(SCRIPT_BLOCK_REGEX, "").replace(STYLE_BLOCK_REGEX, "").replace(NOSCRIPT_BLOCK_REGEX, "");
}

function convertBlockTagsToNewlines(text: string): string {
	return text.replace(BLOCK_CLOSER_REGEX, "\n").replace(SELF_CLOSING_BR_REGEX, "\n");
}

function stripRemainingTags(text: string): string {
	return text.replace(ANY_REMAINING_TAG_REGEX, " ");
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(NUMERIC_HTML_ENTITY_REGEX, (_, code) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(text: string): string {
	return text.replace(HORIZONTAL_WHITESPACE_RUN, " ").replace(BLANK_LINE_RUN, "\n\n");
}

function htmlToText(html: string): string {
	let text = stripNonContentBlocks(html);
	text = convertBlockTagsToNewlines(text);
	text = stripRemainingTags(text);
	text = decodeHtmlEntities(text);
	text = collapseWhitespace(text);
	return text.trim();
}

function extractTitle(html: string): string | undefined {
	const match = html.match(TITLE_TAG_REGEX);
	if (!match) return undefined;
	return match[1].replace(ANY_REMAINING_TAG_REGEX, "").trim() || undefined;
}

// ---------------------------------------------------------------------------
// URL + content-type guards
// ---------------------------------------------------------------------------

function parseAndAssertHttpUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (!SUPPORTED_HTTP_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are supported.`);
	}
	return parsed;
}

function isBinaryContentType(contentType: string): boolean {
	return BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.includes(prefix));
}

function isHtmlContentType(contentType: string): boolean {
	return contentType.includes(HTML_CONTENT_TYPE_TOKEN);
}

function assertTextContentType(contentType: string): void {
	if (isBinaryContentType(contentType)) {
		throw new Error(`Unsupported content type: ${contentType}. web_fetch supports text pages only.`);
	}
}

// ---------------------------------------------------------------------------
// web_fetch helpers
// ---------------------------------------------------------------------------

interface FetchDetails {
	url: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function buildFetchRequestInit(signal: AbortSignal | undefined): RequestInit {
	return {
		signal,
		redirect: "follow",
		headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT_HEADER },
	};
}

async function fetchUrlOrThrow(url: string, signal: AbortSignal | undefined): Promise<Response> {
	const res = await fetch(url, buildFetchRequestInit(signal));
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
	}
	return res;
}

function parseContentLength(value: string | null): number | undefined {
	return value ? Number(value) : undefined;
}

interface ExtractedBody {
	text: string;
	title?: string;
}

async function extractBodyAsText(res: Response, contentType: string, raw: boolean): Promise<ExtractedBody> {
	const body = await res.text();
	if (!raw && isHtmlContentType(contentType)) {
		return { text: htmlToText(body), title: extractTitle(body) };
	}
	return { text: body };
}

async function spillFullContentToTempFile(content: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX));
	const tempFile = join(tempDir, FETCH_TEMP_FILE_NAME);
	await writeFile(tempFile, content, "utf8");
	return tempFile;
}

function formatTruncationFooter(truncation: TruncationResult, tempFile: string): string {
	const truncatedLines = truncation.totalLines - truncation.outputLines;
	const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
	return (
		`\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
		` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
		` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.` +
		` Full content saved to: ${tempFile}]`
	);
}

function formatFetchHeader(url: string, title: string | undefined, contentType: string): string {
	const lines = [`**Fetched:** ${url}`];
	if (title) lines.push(`**Title:** ${title}`);
	if (contentType) lines.push(`**Content-Type:** ${contentType}`);
	return `${lines.join("\n")}\n\n`;
}

// ---------------------------------------------------------------------------
// web_search result rendering
// ---------------------------------------------------------------------------

function formatSearchResultsBody(response: SearchResponse): string {
	let text = `**Search results for "${response.query}":**\n\n`;
	response.results.forEach((r, i) => {
		text += `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}\n\n`;
	});
	return text.trimEnd();
}

function buildEmptyResultsEnvelope(query: string) {
	return {
		content: [{ type: "text" as const, text: `No results found for "${query}".` }],
		details: { query, backend: SEARCH_BACKEND_NAME, resultCount: 0 },
	};
}

// ---------------------------------------------------------------------------
// Tool registrars
// ---------------------------------------------------------------------------

export function registerWebSearchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_search);

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information via the Brave Search API. Returns a list of results with titles, URLs, and snippets. Use when you need current information not in your training data.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_SEARCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_SEARCH_GUIDELINES,
		parameters: Type.Object({
			query: Type.String({
				description: "The search query. Be specific and use natural language.",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: `Maximum number of results to return (${MIN_SEARCH_RESULTS}-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}.`,
					default: DEFAULT_SEARCH_RESULTS,
					minimum: MIN_SEARCH_RESULTS,
					maximum: MAX_SEARCH_RESULTS,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const maxResults = clampSearchResultCount(params.max_results);

			onUpdate?.({
				content: [{ type: "text", text: `Searching Brave for: "${params.query}"...` }],
				details: { query: params.query, backend: SEARCH_BACKEND_NAME, resultCount: 0 },
			});

			const response = await searchBrave(params.query, maxResults, signal);

			if (response.results.length === 0) {
				return buildEmptyResultsEnvelope(params.query);
			}

			return {
				content: [{ type: "text", text: formatSearchResultsBody(response) }],
				details: {
					query: params.query,
					backend: SEARCH_BACKEND_NAME,
					resultCount: response.results.length,
					results: response.results,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebSearch "));
			text += theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}
			const details = result.details as { resultCount?: number; results?: SearchResult[] };
			const count = details?.resultCount ?? 0;
			let text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
			if (expanded && details?.results) {
				text += renderSearchResultsPreview(details.results, theme);
			}
			return new Text(text, 0, 0);
		},
	});
}

function renderSearchResultsPreview(results: SearchResult[], theme: Theme): string {
	let text = "";
	for (const r of results.slice(0, SEARCH_RESULT_PREVIEW_LIMIT)) {
		text += `\n  ${theme.fg("dim", `• ${r.title}`)}`;
	}
	if (results.length > SEARCH_RESULT_PREVIEW_LIMIT) {
		text += `\n  ${theme.fg("dim", `... and ${results.length - SEARCH_RESULT_PREVIEW_LIMIT} more`)}`;
	}
	return text;
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_fetch);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a specific URL. Returns text content for HTML pages (tags stripped), raw text for plain text or JSON. Supports http and https only. Content is truncated to avoid overwhelming the context window.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_FETCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_FETCH_GUIDELINES,
		parameters: Type.Object({
			url: Type.String({
				description: "The URL to fetch. Must be http or https.",
			}),
			raw: Type.Optional(
				Type.Boolean({
					description: "If true, return the raw HTML instead of extracted text. Default: false.",
					default: false,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url, raw = false } = params;
			parseAndAssertHttpUrl(url);

			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${url}...` }],
				details: { url } as FetchDetails,
			});

			const res = await fetchUrlOrThrow(url, signal);
			const contentType = res.headers.get("content-type") ?? "";
			assertTextContentType(contentType);

			const { text: bodyText, title } = await extractBodyAsText(res, contentType, raw);

			const truncation = truncateHead(bodyText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url,
				title,
				contentType,
				contentLength: parseContentLength(res.headers.get("content-length")),
			};

			let output = truncation.content;
			if (truncation.truncated) {
				const tempFile = await spillFullContentToTempFile(bodyText);
				details.truncation = truncation;
				details.fullOutputPath = tempFile;
				output += formatTruncationFooter(truncation, tempFile);
			}

			return {
				content: [{ type: "text", text: formatFetchHeader(url, title, contentType) + output }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebFetch "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as FetchDetails | undefined;
			let text = theme.fg("success", "✓ Fetched");
			if (details?.title) text += theme.fg("muted", `: ${details.title}`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					text += renderFetchedContentPreview(content.text, theme);
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

function renderFetchedContentPreview(content: string, theme: Theme): string {
	const lines = content.split("\n");
	const visible = lines.slice(0, FETCH_PREVIEW_LINE_LIMIT);
	let text = "";
	for (const line of visible) {
		text += `\n  ${theme.fg("dim", line)}`;
	}
	if (lines.length > FETCH_PREVIEW_LINE_LIMIT) {
		text += `\n  ${theme.fg("muted", "... (use read tool to see full content)")}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// /web-search-config command
// ---------------------------------------------------------------------------

function formatShowConfigMessage(current: WebToolsConfig): string {
	return (
		`Web search config:\n` +
		`  config file: ${CONFIG_PATH}\n` +
		`  apiKey: ${maskApiKey(current.apiKey)}\n` +
		`  ${BRAVE_API_KEY_ENV_VAR} env: ${maskApiKey(process.env[BRAVE_API_KEY_ENV_VAR])}`
	);
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WEB_SEARCH_CONFIG_COMMAND_NAME, {
		description: "Configure the Brave Search API key used by web_search/web_fetch",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`/${WEB_SEARCH_CONFIG_COMMAND_NAME} requires interactive mode`, "error");
				return;
			}

			const current = loadConfig();

			if (typeof args === "string" && args.includes(SHOW_FLAG)) {
				ctx.ui.notify(formatShowConfigMessage(current), "info");
				return;
			}

			const input = await ctx.ui.input(
				"Brave Search API key",
				current.apiKey ? "(leave empty to keep existing)" : "sk-...",
			);

			if (input === undefined || input === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const trimmed = input.trim();
			if (!trimmed) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			saveConfig({ ...current, apiKey: trimmed });
			ctx.ui.notify(`Saved Brave API key to ${CONFIG_PATH}`, "info");
		},
	});
}
