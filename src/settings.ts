import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { detectAndPersistPlaywrightToken } from "./commands/publishViaMcp";
import { LocaleSetting } from "./i18n";
import { openPublishLogFile } from "./logger";
import XArticleInObsidianPlugin from "./main";

const PLAYWRIGHT_BRIDGE_STORE_URL =
	"https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm";
const NODEJS_DOWNLOAD_URL = "https://nodejs.org/en/download";

export type PublishMode = "api" | "menu";

export interface XArticlePreviewSettings {
	locale: LocaleSetting;
	playwrightToken: string;
	nodePath: string;
	enableDebugLog: boolean;
	autoRefresh: boolean;
	autoApplyCover: boolean;
	stripFrontmatter: boolean;
	useFilenameAsTitle: boolean;
	showDraftNotice: boolean;
	showWelcomeGuide: boolean;
	hasSeenWelcomeGuide: boolean;
	publishMode: PublishMode;
}

export const DEFAULT_SETTINGS: XArticlePreviewSettings = {
	locale: "auto",
	playwrightToken: "",
	nodePath: "",
	enableDebugLog: false,
	autoRefresh: true,
	autoApplyCover: true,
	stripFrontmatter: true,
	useFilenameAsTitle: false,
	showDraftNotice: true,
	showWelcomeGuide: true,
	hasSeenWelcomeGuide: false,
	publishMode: "api",
};

export class XArticleSettingTab extends PluginSettingTab {
	plugin: XArticleInObsidianPlugin;

	constructor(app: App, plugin: XArticleInObsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName(this.plugin.t("settings.heading.general")).setHeading();

		new Setting(containerEl)
			.setName(this.plugin.t("settings.language.name"))
			.setDesc(this.plugin.t("settings.language.desc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", this.plugin.t("settings.locale.auto"))
					.addOption("en", this.plugin.t("settings.locale.en"))
					.addOption("zh-CN", this.plugin.t("settings.locale.zh-CN"))
					.setValue(this.plugin.settings.locale)
					.onChange((value) => {
						this.plugin.settings.locale = value as LocaleSetting;
						void this.plugin.saveSettings().then(() => {
							this.display();
							void this.plugin.refreshPreviewViews();
						});
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.showWelcomeGuide.name"))
			.setDesc(this.plugin.t("settings.showWelcomeGuide.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showWelcomeGuide).onChange((value) => {
					this.plugin.settings.showWelcomeGuide = value;
					void this.plugin.saveSettings();
				}),
			)
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settings.showWelcomeGuide.open")).onClick(() => {
					this.plugin.openWelcomeGuide();
				}),
			);

		new Setting(containerEl).setName(this.plugin.t("settings.heading.publish")).setHeading();

		new Setting(containerEl)
			.setName(this.plugin.t("settings.playwrightToken.name"))
			.setDesc(this.plugin.t("settings.playwrightToken.desc"))
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.t("settings.playwrightToken.placeholder"))
					.setValue(this.plugin.settings.playwrightToken)
					.onChange((value) => {
						const trimmed = value.trim();
						const tokenPrefix = "PLAYWRIGHT_MCP_EXTENSION_TOKEN=";
						this.plugin.settings.playwrightToken = trimmed.startsWith(tokenPrefix)
							? trimmed.slice(tokenPrefix.length)
							: trimmed;
						void this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settings.playwrightToken.detect")).onClick(() => {
					void detectAndPersistPlaywrightToken(this.plugin).then(() => this.display());
				}),
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip(this.plugin.t("settings.playwrightToken.clear"))
					.onClick(() => {
						this.plugin.settings.playwrightToken = "";
						void this.plugin.saveSettings().then(() => this.display());
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.playwrightBridge.name"))
			.setDesc(this.plugin.t("settings.playwrightBridge.desc"))
			.addButton((button) =>
				button
					.setButtonText(this.plugin.t("settings.playwrightBridge.link"))
					.onClick(() => window.open(PLAYWRIGHT_BRIDGE_STORE_URL, "_blank", "noopener,noreferrer")),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.nodejs.name"))
			.setDesc(this.plugin.t("settings.nodejs.desc"))
			.addButton((button) =>
				button
					.setButtonText(this.plugin.t("settings.nodejs.link"))
					.onClick(() => window.open(NODEJS_DOWNLOAD_URL, "_blank", "noopener,noreferrer")),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.nodePath.name"))
			.setDesc(this.plugin.t("settings.nodePath.desc"))
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.t("settings.nodePath.placeholder"))
					.setValue(this.plugin.settings.nodePath)
					.onChange((value) => {
						this.plugin.settings.nodePath = value.trim();
						void this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settings.nodePath.test")).onClick(() => {
					void testNodePath(this.plugin);
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.publishMode.name"))
			.setDesc(this.plugin.t("settings.publishMode.desc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("api", this.plugin.t("settings.publishMode.api"))
					.addOption("menu", this.plugin.t("settings.publishMode.menu"))
					.setValue(this.plugin.settings.publishMode)
					.onChange((value) => {
						this.plugin.settings.publishMode = value === "menu" ? "menu" : "api";
						void this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.autoApplyCover.name"))
			.setDesc(this.plugin.t("settings.autoApplyCover.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoApplyCover).onChange((value) => {
					this.plugin.settings.autoApplyCover = value;
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.debugLog.name"))
			.setDesc(this.plugin.t("settings.debugLog.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableDebugLog).onChange((value) => {
					this.plugin.settings.enableDebugLog = value;
					void this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.logFile.name"))
			.setDesc(this.plugin.t("settings.logFile.desc"))
			.addButton((button) =>
				button.setButtonText(this.plugin.t("settings.logFile.open")).onClick(() => {
					void openPublishLogFile(this.plugin);
				}),
			);

		new Setting(containerEl).setName(this.plugin.t("settings.heading.preview")).setHeading();

		new Setting(containerEl)
			.setName(this.plugin.t("settings.autoRefresh.name"))
			.setDesc(this.plugin.t("settings.autoRefresh.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRefresh).onChange((value) => {
					this.plugin.settings.autoRefresh = value;
					void this.plugin.saveSettings().then(() => this.plugin.refreshPreviewViews());
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.stripFrontmatter.name"))
			.setDesc(this.plugin.t("settings.stripFrontmatter.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stripFrontmatter).onChange((value) => {
					this.plugin.settings.stripFrontmatter = value;
					void this.plugin.saveSettings().then(() => this.plugin.refreshPreviewViews());
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.useFilenameAsTitle.name"))
			.setDesc(this.plugin.t("settings.useFilenameAsTitle.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useFilenameAsTitle).onChange((value) => {
					this.plugin.settings.useFilenameAsTitle = value;
					void this.plugin.saveSettings().then(() => this.plugin.refreshPreviewViews());
				}),
			);

		new Setting(containerEl)
			.setName(this.plugin.t("settings.showDraftNotice.name"))
			.setDesc(this.plugin.t("settings.showDraftNotice.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showDraftNotice).onChange((value) => {
					this.plugin.settings.showDraftNotice = value;
					void this.plugin.saveSettings().then(() => this.plugin.refreshPreviewViews());
				}),
			);
	}
}

type NodeRequireLike = (id: string) => unknown;
type RequireContainer = typeof globalThis & { require?: NodeRequireLike };
type ChildStdoutChunk = string | Uint8Array;

async function testNodePath(plugin: XArticleInObsidianPlugin): Promise<void> {
	const binary = plugin.settings.nodePath.trim() || "node";
	try {
		const req = getNodeRequire();
		const childProcess = req("node:child_process") as typeof import("node:child_process");
		const bufferModule = req("node:buffer") as typeof import("node:buffer");
		const proc = childProcess.spawn(binary, ["--version"], { stdio: "pipe" });
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stringify = (chunk: ChildStdoutChunk): string =>
			typeof chunk === "string" ? chunk : bufferModule.Buffer.from(chunk).toString("utf8");
		proc.stdout.on("data", (chunk: ChildStdoutChunk) => stdout.push(stringify(chunk)));
		proc.stderr.on("data", (chunk: ChildStdoutChunk) => stderr.push(stringify(chunk)));
		const result = await new Promise<{ code: number | null; signal: string | null; error?: Error }>((resolve) => {
			proc.on("error", (error) => resolve({ code: null, signal: null, error }));
			proc.on("close", (code, signal) => resolve({ code, signal }));
		});
		const output = stdout.join("").trim() || stderr.join("").trim();
		if (result.code === 0) {
			new Notice(plugin.t("settings.nodePath.testSuccess", { version: output || "node --version ok" }));
			return;
		}
		const reason = result.error?.message ?? stderr.join("").trim() ?? `exit ${result.code ?? result.signal ?? "unknown"}`;
		new Notice(plugin.t("settings.nodePath.testFailed", { error: reason }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(plugin.t("settings.nodePath.testFailed", { error: message }));
	}
}

function getNodeRequire(): NodeRequireLike {
	const maybeRequire = (globalThis as RequireContainer).require;
	if (typeof maybeRequire === "function") {
		return maybeRequire;
	}
	throw new Error("Node require is not available in this environment.");
}
