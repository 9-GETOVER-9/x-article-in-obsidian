import { Component, MarkdownRenderer, MarkdownView, Notice, TFile, requestUrl } from "obsidian";
import { buildPreviewMarkdown } from "../markdown";
import {
	getBrowserPublishFunctionTemplate,
	type PublishItem,
	type PublishImageAsset,
	type PublishPayload,
} from "../vendor/x-article-publish/template";
export type { PublishItem, PublishImageAsset, PublishPayload };
import type XArticleInObsidianPlugin from "../main";

const IMAGE_FETCH_CONCURRENCY = 4;

export async function copyPublishScript(plugin: XArticleInObsidianPlugin): Promise<void> {
	try {
		const script = await buildPublishScriptFromActiveNote(plugin);
		await navigator.clipboard.writeText(script);
		new Notice(plugin.t("notice.copyScriptSuccess"));
	} catch (error) {
		const message = error instanceof Error ? error.message : plugin.t("error.buildPublishScriptFailed");
		new Notice(message);
	}
}

export async function buildPublishScriptFromActiveNote(
	plugin: XArticleInObsidianPlugin,
): Promise<string> {
	const payload = await buildPublishPayloadFromActiveNote(plugin);
	return buildBrowserPublishScript(
		payload.html,
		payload.markdown,
		payload.items,
		payload.title,
		payload.cover,
		payload.autoApplyCover,
	);
}

export async function buildPublishFunctionFromActiveNote(
	plugin: XArticleInObsidianPlugin,
): Promise<string> {
	const payload = await buildPublishPayloadFromActiveNote(plugin);
	return buildBrowserPublishFunction(
		payload.html,
		payload.markdown,
		payload.items,
		payload.title,
		payload.cover,
		payload.autoApplyCover,
	);
}

export async function buildPublishFunctionForNote(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	rawMarkdown: string,
): Promise<string> {
	const payload = await buildPublishPayload(plugin, file, rawMarkdown);
	return buildBrowserPublishFunction(
		payload.html,
		payload.markdown,
		payload.items,
		payload.title,
		payload.cover,
		payload.autoApplyCover,
	);
}

async function buildPublishPayloadFromActiveNote(
	plugin: XArticleInObsidianPlugin,
): Promise<PublishPayload> {
	const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!markdownView?.file) {
		throw new Error(plugin.t("error.openMarkdownFirst"));
	}

	return buildPublishPayload(plugin, markdownView.file, markdownView.editor.getValue());
}

export async function buildPublishPayloadForNote(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	rawMarkdown: string,
): Promise<PublishPayload> {
	return buildPublishPayload(plugin, file, rawMarkdown);
}

async function buildPublishPayload(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	rawMarkdown: string,
): Promise<PublishPayload> {
	const markdown = buildPreviewMarkdown(file, rawMarkdown, plugin.settings);
	const extraction = await extractPublishItems(plugin, file, markdown);
	const html = await renderMarkdownToHtml(plugin, file, extraction.processedMarkdown);
	const title = getArticleFrontmatterString(plugin, file, ["title", "Title"]);
	const coverTarget = getArticleFrontmatterString(plugin, file, ["cover", "Cover"]);
	const cover = coverTarget
		? await resolveImageAsset(plugin, file, normalizeFrontmatterImageTarget(coverTarget), "")
		: null;
	return {
		html,
		markdown: extraction.processedMarkdown,
		items: extraction.items,
		title,
		cover,
		autoApplyCover: plugin.settings.autoApplyCover,
	};
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

function getFrontmatterString(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	keys: string[],
): string | null {
	const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	if (!frontmatter) {
		return null;
	}

	for (const key of keys) {
		const value = frontmatter[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function getArticleFrontmatterString(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	keys: string[],
): string | null {
	const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	const formatter = frontmatter?.formatter;

	if (isFrontmatterObject(formatter)) {
		const formatterValue = getStringFromRecord(formatter, keys);
		if (formatterValue) {
			return formatterValue;
		}
	}

	return getFrontmatterString(plugin, file, keys);
}

function isFrontmatterObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function normalizeFrontmatterImageTarget(value: string): string {
	return value
		.replace(/^!\[\[|\]\]$/g, "")
		.replace(/^!\[[^\]]*\]\((.+)\)$/u, "$1")
		.trim();
}

async function extractPublishItems(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	markdown: string,
): Promise<{ processedMarkdown: string; items: PublishItem[] }> {
	const segments: Array<{
		type: "code" | "image" | "divider" | "post";
		start: number;
		end: number;
		language?: string;
		code?: string;
		alt?: string;
		target?: string;
		url?: string;
	}> = [];

	const codePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	while ((match = codePattern.exec(markdown)) !== null) {
		const wholeMatch = match[0];
		const language = match[1] ?? "";
		const code = match[2] ?? "";
		segments.push({
			type: "code",
			start: match.index,
			end: match.index + wholeMatch.length,
			language: language.trim(),
			code: code.replace(/\n$/, ""),
		});
	}

	const dividerPattern = /^(?: {0,3})(?:(?:-{3,})|(?:\*{3,})|(?:_{3,}))(?:[ \t]*)$/gm;
	while ((match = dividerPattern.exec(markdown)) !== null) {
		const wholeMatch = match[0];
		const start = match.index;
		const end = match.index + wholeMatch.length;
		if (segments.some((segment) => start >= segment.start && start < segment.end)) {
			continue;
		}
		segments.push({
			type: "divider",
			start,
			end,
		});
	}

	const postUrlPattern =
		/^(?: {0,3})(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\s]+)?)\s*$/gm;
	while ((match = postUrlPattern.exec(markdown)) !== null) {
		const wholeMatch = match[0];
		const postUrl = match[1] ?? "";
		const start = match.index;
		const end = match.index + wholeMatch.length;
		if (segments.some((segment) => start >= segment.start && start < segment.end)) {
			continue;
		}
		segments.push({
			type: "post",
			start,
			end,
			url: postUrl.trim(),
		});
	}

	const postMarkdownLinkPattern =
		/\[(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^\]\s]+)?)\]\((https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+(?:\?[^)\s]+)?)\)/g;
	while ((match = postMarkdownLinkPattern.exec(markdown)) !== null) {
		const wholeMatch = match[0];
		const hrefUrl = match[2] ?? match[1] ?? "";
		const start = match.index;
		const end = match.index + wholeMatch.length;
		if (segments.some((segment) => start >= segment.start && start < segment.end)) {
			continue;
		}
		segments.push({
			type: "post",
			start,
			end,
			url: hrefUrl.trim(),
		});
	}

	const imagePatterns: Array<{
		kind: "markdown" | "wikilink";
		pattern: RegExp;
	}> = [
		{ kind: "markdown", pattern: /!\[([^\]]*)\]\(([^)]+)\)/g },
		{ kind: "wikilink", pattern: /!\[\[([^\]]+)\]\]/g },
	];

	for (const imagePattern of imagePatterns) {
		while ((match = imagePattern.pattern.exec(markdown)) !== null) {
			const wholeMatch = match[0];
			const firstGroup = match[1] ?? "";
			const secondGroup = match[2] ?? "";
			const start = match.index;
			const end = match.index + wholeMatch.length;
			if (segments.some((segment) => start >= segment.start && start < segment.end)) {
				continue;
			}

			if (imagePattern.kind === "markdown") {
				segments.push({
					type: "image",
					start,
					end,
					alt: firstGroup.trim(),
					target: secondGroup.trim(),
				});
			} else {
				segments.push({
					type: "image",
					start,
					end,
					alt: "",
					target: firstGroup.trim(),
				});
			}
		}
	}

	segments.sort((left, right) => left.start - right.start);

	let processedMarkdown = markdown;
	const imageTasks = new Map<
		string,
		Promise<
			(Omit<Extract<PublishItem, { type: "image" }>, "type" | "marker" | "alt"> & {
				alt: string;
			}) | null
		>
	>();
	const limitImageFetch = createConcurrencyLimiter(IMAGE_FETCH_CONCURRENCY);

	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const segment = segments[index];
		if (!segment) {
			continue;
		}
		const marker = `MPH_MARKER_${index + 1}`;
		const replacement = `\n${marker}\n`;
		processedMarkdown =
			processedMarkdown.slice(0, segment.start) + replacement + processedMarkdown.slice(segment.end);

		if (segment.type === "image") {
			imageTasks.set(
				marker,
				limitImageFetch(() =>
					resolveImageAsset(plugin, file, segment.target ?? "", segment.alt ?? ""),
				),
			);
		}
	}

	const items: PublishItem[] = [];
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment) {
			continue;
		}

		const marker = `MPH_MARKER_${index + 1}`;
		if (segment.type === "code") {
			items.push({
				type: "code",
				marker,
				language: segment.language ?? "",
				code: segment.code ?? "",
			});
			continue;
		}

		if (segment.type === "divider") {
			items.push({
				type: "divider",
				marker,
			});
			continue;
		}

		if (segment.type === "post") {
			items.push({
				type: "post",
				marker,
				url: segment.url ?? "",
			});
			continue;
		}

		const imageAsset = await imageTasks.get(marker);
		if (imageAsset) {
			items.push({ type: "image", marker, ...imageAsset });
		}
	}

	return { processedMarkdown, items };
}

async function resolveImageAsset(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	rawTarget: string,
	alt: string,
): Promise<Omit<Extract<PublishItem, { type: "image" }>, "type" | "marker" | "alt"> & { alt: string } | null> {
	const target = normalizeImageTarget(rawTarget);
	if (!target) {
		return null;
	}

	if (isRemoteImageTarget(target)) {
		return resolveRemoteImageAsset(target, alt);
	}

	const linkedFile =
		plugin.app.metadataCache.getFirstLinkpathDest(target, file.path) ??
		plugin.app.vault.getAbstractFileByPath(target);
	if (!(linkedFile instanceof TFile)) {
		return null;
	}

	const binary = await plugin.app.vault.readBinary(linkedFile);
	return {
		alt,
		fileName: linkedFile.name,
		mimeType: getMimeType(linkedFile.extension),
		base64: arrayBufferToBase64(binary),
	};
}

async function resolveRemoteImageAsset(
	target: string,
	alt: string,
): Promise<Omit<Extract<PublishItem, { type: "image" }>, "type" | "marker" | "alt"> & { alt: string } | null> {
	try {
		const response = await requestUrl({
			url: target,
			method: "GET",
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			return null;
		}

		const arrayBuffer = response.arrayBuffer;
		const mimeType = inferRemoteMimeType(target, response.headers["content-type"]);
		return {
			alt,
			fileName: extractRemoteFileName(target, mimeType),
			mimeType,
			base64: arrayBufferToBase64(arrayBuffer),
		};
	} catch {
		return null;
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

function extractRemoteFileName(target: string, mimeType: string): string {
	const cleanUrl = target.split("?")[0] ?? target;
	const lastSegment = cleanUrl.split("/").pop()?.trim();
	if (lastSegment) {
		return lastSegment;
	}

	const fallbackExtension = mimeType.split("/")[1] ?? "png";
	return `remote-image.${fallbackExtension}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

async function renderMarkdownToHtml(
	plugin: XArticleInObsidianPlugin,
	file: TFile,
	markdown: string,
): Promise<string> {
	const container = document.createElement("div");
	const renderComponent = new Component();
	try {
		await MarkdownRenderer.render(plugin.app, markdown, container, file.path, renderComponent);
	} finally {
		renderComponent.unload();
	}
	cleanupRenderedHtml(container);
	return container.innerHTML;
}

function cleanupRenderedHtml(container: HTMLElement): void {
	const removableSelectors = [
		".frontmatter",
		".markdown-preview-sizer",
		".internal-query",
		".callout-fold",
	];
	for (const selector of removableSelectors) {
		container.querySelectorAll(selector).forEach((element) => element.remove());
	}

	container.querySelectorAll("*").forEach((element) => {
		for (const attr of Array.from(element.attributes)) {
			if (
				attr.name === "href" ||
				attr.name === "src" ||
				attr.name === "alt" ||
				attr.name === "title"
			) {
				continue;
			}

			if (attr.name.startsWith("data-") || attr.name === "class" || attr.name === "style") {
				element.removeAttribute(attr.name);
			}
		}
	});
}

function buildBrowserPublishScript(
	html: string,
	markdown: string,
	items: PublishItem[],
	title?: string | null,
	cover?: PublishImageAsset | null,
	autoApplyCover = true,
): string {
	return `(${buildBrowserPublishFunction(html, markdown, items, title, cover, autoApplyCover)})();`;
}

function buildBrowserPublishFunction(
	html: string,
	markdown: string,
	items: PublishItem[],
	title?: string | null,
	cover?: PublishImageAsset | null,
	autoApplyCover = true,
): string {
	const payload: PublishPayload = {
		html,
		markdown,
		items,
		title: title ?? null,
		cover: cover ?? null,
		autoApplyCover,
	};
	return getBrowserPublishFunctionTemplate(payload);
}
