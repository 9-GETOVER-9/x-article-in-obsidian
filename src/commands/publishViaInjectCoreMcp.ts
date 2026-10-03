import { MarkdownView, Notice, Platform, TFile, requestUrl } from "obsidian";
import { appendPublishLog } from "../logger";
import type XArticleInObsidianPlugin from "../main";
import type { XArticlePreviewSettings } from "../settings";
import { maskMarkdownCode } from "./copyPublishScript";
import { INJECT_CORE_RUNNER_SHA256, INJECT_CORE_RUNNER_SOURCE } from "../vendor/x-article-inject-core/runner";
import {
	detectPlaywrightRuntime,
	MCP_EVALUATE_TIMEOUT_MS,
	MCP_REQUEST_TIMEOUT_MS,
	normalizeEvaluateSource,
	normalizeMcpErrorMessage,
	parsePlaywrightToolResult,
	REQUIRED_PLAYWRIGHT_TOOLS,
	StdioMcpClient,
} from "./publishViaMcp";

type RunnerImageAsset =
	| {
			ok: true;
			base64: string;
			mime: string;
			fileName?: string;
	  }
	| {
			ok: false;
			error: string;
	  };

type RunnerImageMap = Record<string, RunnerImageAsset>;

type ImageReference = {
	raw: string;
	normalized: string;
	alt: string;
};

const IMAGE_FETCH_CONCURRENCY = 4;
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n*/;
const LEADING_HEADING_PATTERN = /^\s*#\s+/m;

export async function publishViaInjectCoreMcp(plugin: XArticleInObsidianPlugin): Promise<void> {
	if (!Platform.isDesktopApp) {
		new Notice(plugin.t("notice.publishDesktopOnly"));
		return;
	}

	const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!markdownView?.file) {
		new Notice(plugin.t("error.openMarkdownFirst"));
		return;
	}

	const file = markdownView.file;
	const markdown = buildInjectCoreMarkdown(file, markdownView.editor.getValue(), plugin.settings);

	try {
		const imageMap = await buildImageMap(plugin, file, markdown);
		await appendPublishLog(plugin, "publish.inject_core.prepare", {
			sourceNotePath: file.path,
			runnerSha256: INJECT_CORE_RUNNER_SHA256,
			stagedImages: Object.keys(imageMap).length,
		});

		const runtime = await detectPlaywrightRuntime(plugin);
		if (!runtime) {
			new Notice(plugin.t("notice.noBrowserBridge"));
			return;
		}

		const client = await StdioMcpClient.connect(runtime);
		try {
			await client.assertToolsAvailable(REQUIRED_PLAYWRIGHT_TOOLS);
			await client.callTool("browser_navigate", { url: "https://x.com/compose/articles" });
			await client.callTool("browser_wait_for", { time: 2 });
			await client.callTool(
				"browser_evaluate",
				{ function: normalizeEvaluateSource(CREATE_OR_FIND_EDITOR_FUNCTION) },
				MCP_EVALUATE_TIMEOUT_MS,
			);

			const publishResult = parsePlaywrightToolResult(
				await client.callTool(
					"browser_evaluate",
					{ function: normalizeEvaluateSource(buildInjectCoreEvaluateFunction(markdown, imageMap)) },
					MCP_EVALUATE_TIMEOUT_MS,
				),
			);

			if (!isOkResult(publishResult)) {
				throw new Error(`inject-core upload did not report ok: ${stringifyResult(publishResult)}`);
			}

			try {
				await client.callTool("browser_press_key", { key: "Backspace" }, MCP_REQUEST_TIMEOUT_MS);
			} catch {
				// Older Playwright MCP servers may not expose browser_press_key.
			}
			await client.callTool("browser_wait_for", { time: 3 });

			await appendPublishLog(plugin, "publish.inject_core.success", {
				sourceNotePath: file.path,
				runtimeSource: runtime.source,
				result: publishResult,
			});
			const summaryText = formatInjectCoreSummary(publishResult);
			new Notice(
				summaryText
					? `${plugin.t("notice.publishSuccess", { source: runtime.source })} · ${summaryText}`
					: plugin.t("notice.publishSuccess", { source: runtime.source }),
			);
		} finally {
			await client.close();
		}
	} catch (error) {
		await appendPublishLog(plugin, "publish.inject_core.error", {
			sourceNotePath: file.path,
			error,
			normalizedMessage: normalizeMcpErrorMessage(error, plugin),
		});
		new Notice(normalizeMcpErrorMessage(error, plugin));
	}
}

function buildInjectCoreMarkdown(
	file: TFile,
	rawMarkdown: string,
	settings: XArticlePreviewSettings,
): string {
	let output = rawMarkdown.replace(/\r\n/g, "\n").trim();
	if (settings.useFilenameAsTitle && !hasFrontmatterTitle(output) && !LEADING_HEADING_PATTERN.test(stripFrontmatter(output))) {
		output = `# ${file.basename}\n\n${output}`;
	}
	return output;
}

async function buildImageMap(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	markdown: string,
): Promise<RunnerImageMap> {
	const references = collectImageReferences(markdown);
	const map: RunnerImageMap = {};
	const limit = createConcurrencyLimiter(IMAGE_FETCH_CONCURRENCY);
	await Promise.all(
		references.map((reference) =>
			limit(async () => {
				const asset = await resolveImageAsset(plugin, file, reference);
				if (!asset.ok) {
					throw new Error(`Unable to load image ${reference.normalized}: ${asset.error}`);
				}
				addImageMapEntry(map, reference.raw, asset);
				addImageMapEntry(map, reference.normalized, asset);
			}),
		),
	);
	return map;
}

function collectImageReferences(markdown: string): ImageReference[] {
	const references: ImageReference[] = [];
	const seen = new Set<string>();
	const add = (raw: string, alt: string): void => {
		const normalized = normalizeImageTarget(raw);
		// The runner decodes data URI images itself; they are not vault files.
		if (!normalized || /^data:/i.test(normalized)) {
			return;
		}
		const key = `${raw}\n${normalized}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		references.push({ raw, normalized, alt });
	};

	// Code examples contain literal image syntax, not required upload assets.
	const body = maskMarkdownCode(stripFrontmatter(markdown));
	let match: RegExpExecArray | null;
	const markdownImagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
	while ((match = markdownImagePattern.exec(body)) !== null) {
		add(match[2] ?? "", match[1] ?? "");
	}

	const wikiImagePattern = /!\[\[([^\]]+)\]\]/g;
	while ((match = wikiImagePattern.exec(body)) !== null) {
		add(match[1] ?? "", "");
	}

	const cover = extractFrontmatterCover(markdown);
	if (cover) {
		add(cover, "");
	}

	return references;
}

async function resolveImageAsset(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	reference: ImageReference,
): Promise<RunnerImageAsset> {
	if (isRemoteImageTarget(reference.normalized)) {
		return resolveRemoteImageAsset(reference.normalized, reference.alt);
	}

	const linkedFile =
		plugin.app.metadataCache.getFirstLinkpathDest(reference.normalized, file.path) ??
		plugin.app.vault.getAbstractFileByPath(reference.normalized);
	if (!(linkedFile instanceof TFile)) {
		return { ok: false, error: `local image not found: ${reference.normalized}` };
	}

	const binary = await plugin.app.vault.readBinary(linkedFile);
	return {
		ok: true,
		fileName: linkedFile.name,
		mime: getMimeType(linkedFile.extension),
		base64: arrayBufferToBase64(binary),
	};
}

async function resolveRemoteImageAsset(target: string, alt: string): Promise<RunnerImageAsset> {
	try {
		const response = await requestUrl({
			url: target,
			method: "GET",
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			return { ok: false, error: `remote image ${response.status}: ${target}` };
		}

		const contentType = response.headers["content-type"] ?? response.headers["Content-Type"];
		const mime = inferRemoteMimeType(target, contentType);
		return {
			ok: true,
			fileName: extractRemoteFileName(target, mime, alt),
			mime,
			base64: arrayBufferToBase64(response.arrayBuffer),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function createConcurrencyLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let activeCount = 0;
	const queue: Array<{
		run: () => Promise<unknown>;
		resolve: (value: unknown) => void;
		reject: (reason?: unknown) => void;
	}> = [];

	const next = (): void => {
		if (activeCount >= limit || queue.length === 0) {
			return;
		}
		const task = queue.shift();
		if (!task) {
			return;
		}
		activeCount += 1;
		void Promise.resolve()
			.then(task.run)
			.then(task.resolve, task.reject)
			.finally(() => {
				activeCount -= 1;
				next();
			});
	};

	return <T>(run: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			queue.push({
				run: run as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			next();
		});
}

function addImageMapEntry(map: RunnerImageMap, key: string, asset: RunnerImageAsset): void {
	const trimmed = key.trim();
	if (!trimmed) {
		return;
	}
	map[trimmed] = asset;
	const decoded = safeDecodeUri(trimmed);
	if (decoded !== trimmed) {
		map[decoded] = asset;
	}
}

function normalizeImageTarget(target: string): string {
	const trimmed = target.trim();
	if (trimmed.length === 0) {
		return "";
	}

	const pipeIndex = trimmed.indexOf("|");
	const withoutAlias = pipeIndex >= 0 ? trimmed.slice(0, pipeIndex) : trimmed;
	return withoutAlias.replace(/^</, "").replace(/>$/, "").trim();
}

function extractFrontmatterCover(markdown: string): string | null {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match?.[1]) {
		return null;
	}
	for (const line of match[1].split("\n")) {
		const index = line.indexOf(":");
		if (index < 0) {
			continue;
		}
		const key = line.slice(0, index).trim();
		if (key !== "cover" && key !== "Cover" && key !== "封面") {
			continue;
		}
		const value = line
			.slice(index + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		return normalizeFrontmatterImageTarget(value);
	}
	return null;
}

function normalizeFrontmatterImageTarget(value: string): string {
	return value
		.replace(/^!\[\[|\]\]$/g, "")
		.replace(/^!\[[^\]]*\]\(([^)]+)\)$/u, "$1")
		.trim();
}

function hasFrontmatterTitle(markdown: string): boolean {
	const match = markdown.match(FRONTMATTER_PATTERN);
	if (!match?.[1]) {
		return false;
	}
	return match[1]
		.split("\n")
		.some((line) => /^(title|Title|标题)\s*:\s*\S/.test(line.trim()));
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_PATTERN, "");
}

function isRemoteImageTarget(target: string): boolean {
	return /^https?:\/\//i.test(target);
}

function getMimeType(extension: string): string {
	switch (extension.toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "svg":
			return "image/svg+xml";
		default:
			return "image/png";
	}
}

function inferRemoteMimeType(target: string, contentType: string | undefined): string {
	const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
	if (normalized && normalized.startsWith("image/")) {
		return normalized;
	}

	const cleanUrl = target.split("?")[0] ?? target;
	const extension = cleanUrl.split(".").pop() ?? "";
	return getMimeType(extension);
}

function extractRemoteFileName(target: string, mime: string, alt: string): string {
	const cleanUrl = target.split("?")[0] ?? target;
	const lastSegment = cleanUrl.split("/").pop()?.trim();
	if (lastSegment) {
		return lastSegment;
	}

	const fallbackExtension = mime.split("/")[1] ?? "png";
	const fallbackName = alt.trim() || "remote-image";
	return `${fallbackName}.${fallbackExtension}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function safeDecodeUri(value: string): string {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
}

function buildInjectCoreEvaluateFunction(markdown: string, imageMap: RunnerImageMap): string {
	const runnerSource = JSON.stringify(INJECT_CORE_RUNNER_SOURCE);
	const markdownSource = JSON.stringify(markdown);
	const imageMapSource = JSON.stringify(imageMap);
	return `async () => {
		const runnerSource = ${runnerSource};
		const markdown = ${markdownSource};
		const imageMap = ${imageMapSource};
		(0, eval)(runnerSource);
		const api = window.__xArticleInjectCore;
		if (!api || typeof api.runMarkdown !== "function") {
			throw new Error("inject-core runner did not install.");
		}
		return api.runMarkdown({ markdown, imageMap });
	}`;
}

const CREATE_OR_FIND_EDITOR_FUNCTION = `async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	function isVisible(el) {
		if (!el) return false;
		const s = window.getComputedStyle(el);
		if (s.display === "none" || s.visibility === "hidden") return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}
	function findEditor() {
		return document.querySelector("[data-contents='true'] [contenteditable='true']")
			|| document.querySelector("[contenteditable='true']");
	}
	async function ensureArticleListPage() {
		if (!/\\/compose\\/articles\\/edit\\//.test(location.pathname)) return;
		const target = "/compose/articles";
		history.pushState(null, "", target);
		window.dispatchEvent(new PopStateEvent("popstate"));
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (!/\\/compose\\/articles\\/edit\\//.test(location.pathname)) return;
			await sleep(150);
		}
		location.href = target;
		await sleep(1200);
	}
	function findCreateButton() {
		const ariaTerms = new Set([
			"create","compose","write","draft","new article","撰写","新建","创建",
			"新規","作成","作成する","redactar","écrire","créer","escribir","schreiben",
			"verfassen","escrever","새 글 작성","글 작성","記事を作成"
		].map((s) => s.toLowerCase()));
		for (const btn of document.querySelectorAll("button, a[role='button'], [role='link']")) {
			if (!isVisible(btn)) continue;
			const aria = (btn.getAttribute("aria-label") || "").toLowerCase().trim();
			if (aria && ariaTerms.has(aria)) return btn;
		}
		const empty = document.querySelector("a[data-testid='empty_state_button_text']");
		if (empty && isVisible(empty)) return empty;
		for (const a of document.querySelectorAll("a[href*='/compose/articles']")) {
			if (isVisible(a)) return a;
		}
		for (const btn of document.querySelectorAll("button")) {
			if (!isVisible(btn)) continue;
			for (const p of btn.querySelectorAll("svg path[d]")) {
				const d = p.getAttribute("d") || "";
				if (d.startsWith("M14.543 5.04297")) return btn;
			}
		}
		return null;
	}
	await ensureArticleListPage();
	const button = findCreateButton();
	if (!button) throw new Error("Create button not found.");
	button.click();
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (findEditor()) return true;
		await sleep(200);
	}
	throw new Error("Editor did not become ready after clicking create.");
}`;

function isOkResult(result: unknown): result is { ok: true } {
	if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
		return false;
	}
	const summary = (result as { summary?: unknown }).summary;
	if (!summary || typeof summary !== "object") return true;
	const mainSummary = (summary as { mainSummary?: unknown }).mainSummary;
	if (!mainSummary || typeof mainSummary !== "object") return true;
	const main = mainSummary as Record<string, unknown>;
	return Number(main.imgFail ?? 0) === 0 && Number(main.atomicFail ?? 0) === 0;
}

function formatInjectCoreSummary(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	const summary = (result as { summary?: unknown }).summary;
	if (!summary || typeof summary !== "object") {
		return null;
	}
	const mainSummary = (summary as { mainSummary?: unknown }).mainSummary;
	if (!mainSummary || typeof mainSummary !== "object") {
		return null;
	}
	const main = mainSummary as Record<string, unknown>;
	const atomicFail = Number(main.atomicFail ?? 0);
	const imgFail = Number(main.imgFail ?? 0);
	const markersCleaned = Number(main.markersCleaned ?? 0);
	const atomicOk = Number(main.atomicOk ?? 0);
	const imgOk = Number(main.imgOk ?? 0);
	return `inject-core: atomicOk=${atomicOk}, atomicFail=${atomicFail}, imgOk=${imgOk}, imgFail=${imgFail}, markersCleaned=${markersCleaned}`;
}

function stringifyResult(result: unknown): string {
	try {
		const serialized = JSON.stringify(result);
		if (!serialized) {
			return String(result);
		}
		return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
	} catch {
		return String(result);
	}
}
