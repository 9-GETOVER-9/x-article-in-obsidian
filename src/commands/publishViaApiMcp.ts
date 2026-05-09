import { MarkdownView, Notice, TFile } from "obsidian";
import { appendPublishLog } from "../logger";
import type XArticleInObsidianPlugin from "../main";
import {
	StdioMcpClient,
	detectPlaywrightRuntime,
	REQUIRED_PLAYWRIGHT_TOOLS,
	normalizeMcpErrorMessage,
	normalizeEvaluateSource,
	parsePlaywrightToolResult,
	MCP_EVALUATE_TIMEOUT_MS,
	MCP_REQUEST_TIMEOUT_MS,
	type PublishSourceNote,
} from "./publishViaMcp";
import {
	buildPublishFunctionForNote,  // unused but ensures module is loaded
	buildPublishPayloadForNote,
	type PublishItem,
} from "./copyPublishScript";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

type TextSegment = {
	type: "text";
	kind:
		| "unstyled"
		| "header-one"
		| "header-two"
		| "header-three"
		| "header-four"
		| "header-five"
		| "header-six"
		| "blockquote"
		| "unordered-list-item"
		| "ordered-list-item";
	text: string;
	inlineStyleRanges: Array<{ offset: number; length: number; style: "Bold" | "Italic" | "Strikethrough" }>;
	links: Array<{ offset: number; length: number; url: string }>;
};
type ImageSegment = { type: "image"; alt: string; fileName: string; mimeType: string; base64: string };
type CodeSegment = { type: "code"; language: string; code: string };
type DividerSegment = { type: "divider" };
type TweetSegment = { type: "tweet"; tweetId: string };
type Segment = TextSegment | ImageSegment | CodeSegment | DividerSegment | TweetSegment;

// ───────────────────────────────────────────────────────────────────────────
// Markdown → ordered segments
// ───────────────────────────────────────────────────────────────────────────

function processedMarkdownToSegments(processedMarkdown: string, items: PublishItem[]): Segment[] {
	const itemByMarker = new Map<string, PublishItem>(items.map((i) => [i.marker, i]));
	const out: Segment[] = [];
	const lines = processedMarkdown.split("\n");
	let textBuf: string[] = [];

	const flushText = (): void => {
		if (!textBuf.length) return;
		const chunk = textBuf.join("\n").trim();
		textBuf = [];
		if (chunk) out.push(...textChunkToSegments(chunk));
	};

	for (const line of lines) {
		const trimmed = line.trim();
		const markerOnly = /^MPH_MARKER_\d+$/.test(trimmed);
		if (markerOnly) {
			flushText();
			const item = itemByMarker.get(trimmed);
			if (item) {
				if (item.type === "code") {
					out.push({ type: "code", language: item.language, code: item.code });
				} else if (item.type === "divider") {
					out.push({ type: "divider" });
				} else if (item.type === "post") {
					const m = (item.url || "").match(/\/status\/(\d+)/);
					if (m && m[1]) out.push({ type: "tweet", tweetId: m[1] });
				} else if (item.type === "image") {
					out.push({
						type: "image",
						alt: item.alt,
						fileName: item.fileName,
						mimeType: item.mimeType,
						base64: item.base64,
					});
				}
			}
			continue;
		}
		textBuf.push(line);
	}
	flushText();
	return out;
}

function textChunkToSegments(chunk: string): TextSegment[] {
	const lines = chunk.split("\n");
	const segs: TextSegment[] = [];
	let para: string[] = [];
	const flushPara = (): void => {
		if (!para.length) return;
		const text = para.join("\n").trim();
		para = [];
		if (text) segs.push(makeTextSeg("unstyled", text));
	};
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flushPara();
			continue;
		}
		let m: RegExpMatchArray | null;
		if ((m = trimmed.match(/^(#{1,6})\s+(.+)$/)) && m[1] && m[2]) {
			flushPara();
			const kindMap = ["", "header-one", "header-two", "header-three", "header-four", "header-five", "header-six"] as const;
			segs.push(makeTextSeg(kindMap[m[1].length] as TextSegment["kind"], m[2].trim()));
			continue;
		}
		if ((m = trimmed.match(/^>\s+(.+)$/)) && m[1]) {
			flushPara();
			segs.push(makeTextSeg("blockquote", m[1].trim()));
			continue;
		}
		if ((m = trimmed.match(/^[-*+]\s+(.+)$/)) && m[1]) {
			flushPara();
			segs.push(makeTextSeg("unordered-list-item", m[1].trim()));
			continue;
		}
		if ((m = trimmed.match(/^\d+\.\s+(.+)$/)) && m[1]) {
			flushPara();
			segs.push(makeTextSeg("ordered-list-item", m[1].trim()));
			continue;
		}
		para.push(trimmed);
	}
	flushPara();
	return segs;
}

function makeTextSeg(kind: TextSegment["kind"], rawText: string): TextSegment {
	const out: TextSegment = { type: "text", kind, text: "", inlineStyleRanges: [], links: [] };
	let i = 0;
	const n = rawText.length;
	while (i < n) {
		const c = rawText[i];
		if (c === "[") {
			const m = rawText.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
			if (m && m[1] && m[2]) {
				const start = out.text.length;
				out.text += m[1];
				out.links.push({ offset: start, length: m[1].length, url: m[2] });
				i += m[0].length;
				continue;
			}
		}
		if (rawText.startsWith("***", i)) {
			const end = rawText.indexOf("***", i + 3);
			if (end > 0) {
				const inner = rawText.slice(i + 3, end);
				const start = out.text.length;
				out.text += inner;
				out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Bold" });
				out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Italic" });
				i = end + 3;
				continue;
			}
		}
		if (rawText.startsWith("**", i)) {
			const end = rawText.indexOf("**", i + 2);
			if (end > 0) {
				const inner = rawText.slice(i + 2, end);
				const start = out.text.length;
				out.text += inner;
				out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Bold" });
				i = end + 2;
				continue;
			}
		}
		if (rawText.startsWith("~~", i)) {
			const end = rawText.indexOf("~~", i + 2);
			if (end > 0) {
				const inner = rawText.slice(i + 2, end);
				const start = out.text.length;
				out.text += inner;
				out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Strikethrough" });
				i = end + 2;
				continue;
			}
		}
		if ((c === "*" || c === "_") && rawText[i + 1] !== c) {
			const end = rawText.indexOf(c, i + 1);
			if (end > 0 && rawText[end + 1] !== c) {
				const inner = rawText.slice(i + 1, end);
				const start = out.text.length;
				out.text += inner;
				out.inlineStyleRanges.push({ offset: start, length: inner.length, style: "Italic" });
				i = end + 1;
				continue;
			}
		}
		if (c === "`") {
			const end = rawText.indexOf("`", i + 1);
			if (end > 0) {
				out.text += rawText.slice(i + 1, end);
				i = end + 1;
				continue;
			}
		}
		out.text += c;
		i += 1;
	}
	return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Segments + media map → X RawDraftContentState
// ───────────────────────────────────────────────────────────────────────────

type MediaInfo = { mediaId: string; entityKey: string; localMediaId: string; mediaCategory: string };

function genKey(): string {
	return Math.random().toString(36).slice(2, 7);
}

function buildContentState(segments: Segment[], mediaInfoBySegmentIndex: Map<number, MediaInfo>): {
	blocks: unknown[];
	entity_map: Array<{ key: string; value: { data: unknown; type: string; mutability: "Immutable" | "Mutable" } }>;
} {
	const blocks: unknown[] = [];
	const entityMap: ReturnType<typeof buildContentState>["entity_map"] = [];
	const pushEntity = (value: (typeof entityMap)[number]["value"]): number => {
		const idx = entityMap.length;
		entityMap.push({ key: String(idx), value });
		return idx;
	};
	const atomicBlock = (entIdx: number) => ({
		key: genKey(),
		type: "atomic",
		text: " ",
		data: {},
		entity_ranges: [{ key: entIdx, offset: 0, length: 1 }],
		inline_style_ranges: [],
	});

	segments.forEach((seg, idx) => {
		if (seg.type === "text") {
			const block = {
				key: genKey(),
				type: seg.kind,
				text: seg.text,
				data: {},
				entity_ranges: [] as Array<{ key: number; offset: number; length: number }>,
				inline_style_ranges: seg.inlineStyleRanges,
			};
			for (const link of seg.links || []) {
				const entIdx = pushEntity({ data: { url: link.url }, type: "LINK", mutability: "Mutable" });
				block.entity_ranges.push({ key: entIdx, offset: link.offset, length: link.length });
			}
			blocks.push(block);
		} else if (seg.type === "divider") {
			blocks.push(atomicBlock(pushEntity({ data: {}, type: "DIVIDER", mutability: "Immutable" })));
		} else if (seg.type === "code") {
			const md = "```" + (seg.language || "") + "\n" + (seg.code || "") + "\n```";
			blocks.push(atomicBlock(pushEntity({ data: { markdown: md }, type: "MARKDOWN", mutability: "Mutable" })));
		} else if (seg.type === "tweet") {
			blocks.push(
				atomicBlock(pushEntity({ data: { tweet_id: seg.tweetId }, type: "TWEET", mutability: "Immutable" })),
			);
		} else if (seg.type === "image") {
			const info = mediaInfoBySegmentIndex.get(idx);
			if (!info) return;
			blocks.push(
				atomicBlock(
					pushEntity({
						data: {
							entity_key: info.entityKey,
							media_items: [
								{ local_media_id: info.localMediaId, media_category: info.mediaCategory, media_id: info.mediaId },
							],
						},
						type: "MEDIA",
						mutability: "Immutable",
					}),
				),
			);
		}
	});

	if (blocks.length === 0 || (blocks[blocks.length - 1] as { type: string }).type === "atomic") {
		blocks.push({ key: genKey(), type: "unstyled", text: "", data: {}, entity_ranges: [], inline_style_ranges: [] });
	}
	return { blocks, entity_map: entityMap };
}

// ───────────────────────────────────────────────────────────────────────────
// MCP bridge — small helpers around StdioMcpClient
// ───────────────────────────────────────────────────────────────────────────

function makeBridge(client: StdioMcpClient) {
	const FN_PREFIX = "async () => { try { const __r = await (";
	const FN_SUFFIX =
		"); return __r === undefined ? null : __r; } catch (e) { return { __evalError: String(e?.message || e) }; } }";
	async function evalJS(jsExpr: string, timeoutMs = MCP_EVALUATE_TIMEOUT_MS): Promise<unknown> {
		const wrapped = `${FN_PREFIX}${jsExpr}${FN_SUFFIX}`;
		const raw = parsePlaywrightToolResult(
			await client.callTool("browser_evaluate", { function: normalizeEvaluateSource(wrapped) }, timeoutMs),
		);
		let val = raw;
		if (typeof val === "string") {
			try {
				val = JSON.parse(val);
			} catch {
				/* keep string */
			}
		}
		if (val && typeof val === "object" && "__evalError" in val) {
			throw new Error(`browser eval error: ${(val as { __evalError: string }).__evalError}`);
		}
		return val;
	}
	async function press(key: string): Promise<void> {
		try {
			await client.callTool("browser_press_key", { key }, MCP_REQUEST_TIMEOUT_MS);
		} catch {
			// browser_press_key may not be available on older Playwright MCP
		}
	}
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	return { evalJS, press, sleep };
}

type Bridge = ReturnType<typeof makeBridge>;

// ───────────────────────────────────────────────────────────────────────────
// Image upload via editor's React props.onFilesAdded
// ───────────────────────────────────────────────────────────────────────────

// MCP runs over stdio JSON-RPC — no cmdline size limit, so we can stage
// the entire base64 payload in a single browser_evaluate call. (The
// upstream bb-browser variant chunked because of cmd.exe's 32 KB limit.)
async function stageBytes(bridge: Bridge, base64: string): Promise<void> {
	await bridge.evalJS(
		`(()=>{window.__imgB64=${JSON.stringify(base64)};return window.__imgB64.length})()`,
		MCP_EVALUATE_TIMEOUT_MS,
	);
}

async function uploadOneImage(bridge: Bridge, image: ImageSegment): Promise<MediaInfo> {
	await stageBytes(bridge, image.base64);
	const filenameJs = JSON.stringify(image.fileName || "image.png");
	const mimeJs = JSON.stringify(image.mimeType || "image/png");

	const callJs = `(async()=>{
    try {
      const b64 = window.__imgB64 || '';
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i=0; i<bin.length; i++) u[i] = bin.charCodeAt(i);
      const blob = new Blob([u], { type: ${mimeJs} });
      const file = new File([blob], ${filenameJs}, { type: ${mimeJs} });
      function getFiber(n){const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$'));return k?n[k]:null}
      const ed = document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")
              || document.querySelector("[contenteditable='true']");
      if (!ed) return {ok:false, step:'no editor'};
      let f = getFiber(ed), depth = 0, onFilesAdded = null;
      while (f && depth < 50) {
        const props = f.memoizedProps || f.stateNode?.props;
        if (props && typeof props.onFilesAdded === 'function') { onFilesAdded = props.onFilesAdded; break; }
        f = f.return; depth++;
      }
      if (!onFilesAdded) return {ok:false, step:'no onFilesAdded'};
      function findDraft(node){let f=getFiber(node),d=0;while(f&&d<60){const sn=f.stateNode;if(sn?.props?.editorState)return sn;f=f.return;d++;}return null;}
      const editor = findDraft(ed);
      const csBefore = editor?.props?.editorState?.getCurrentContent?.();
      const before = new Set();
      csBefore?.getBlockMap()?.forEach((b)=>{
        if(b.getType()==='atomic'){
          b.findEntityRanges(c=>!!c.getEntity(),(s)=>{
            const ek=b.getCharacterList().get(s)?.getEntity?.();
            if(ek) before.add(ek);
          });
        }
      });
      onFilesAdded([file]);
      delete window.__imgB64;
      return {ok:true, beforeKeys: Array.from(before)};
    } catch (e) { return {ok:false, step:'exception', err: String(e?.message||e)}; }
  })()`;

	const callRes = (await bridge.evalJS(callJs)) as { ok: boolean; beforeKeys?: string[]; step?: string };
	if (!callRes?.ok) throw new Error(`onFilesAdded call failed: ${JSON.stringify(callRes)}`);
	const beforeKeys = callRes.beforeKeys ?? [];

	let info: MediaInfo | null = null;
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		await bridge.sleep(300);
		const probe = (await bridge.evalJS(
			`(()=>{
        function getFiber(n){const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$'));return k?n[k]:null}
        const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");
        if(!ed)return null;
        let f=getFiber(ed),d=0;
        while(f&&d<60){if(f.stateNode?.props?.editorState)break;f=f.return;d++;}
        const cs=f?.stateNode?.props?.editorState?.getCurrentContent?.();
        if(!cs)return null;
        const beforeSet=new Set(${JSON.stringify(beforeKeys)});
        const news=[];
        cs.getBlockMap().forEach((b)=>{
          if(b.getType()!=='atomic')return;
          b.findEntityRanges(c=>!!c.getEntity(),(s)=>{
            const ek=b.getCharacterList().get(s)?.getEntity?.();
            if(!ek||beforeSet.has(ek))return;
            try{
              const ent=cs.getEntity(ek);
              if(ent?.getType?.()==='MEDIA'){
                const data=ent.getData();
                const mi=data?.mediaItems?.[0]||data?.media_items?.[0];
                if(mi?.mediaId||mi?.media_id){
                  news.push({entityKey:ek,mediaId:mi.mediaId||mi.media_id,localMediaId:String(mi.localMediaId??mi.local_media_id??1),mediaCategory:mi.mediaCategory||mi.media_category||'DraftTweetImage'});
                }
              }
            }catch{}
          });
        });
        return JSON.stringify(news);
      })()`,
		)) as string | unknown[];
		const arr = typeof probe === "string" ? (JSON.parse(probe) as MediaInfo[]) : (probe as MediaInfo[]);
		if (Array.isArray(arr) && arr[0]) {
			info = arr[0];
			break;
		}
	}
	if (!info) throw new Error("uploadOneImage timed out waiting for MEDIA entity");
	return info;
}

async function flushAutosave(bridge: Bridge): Promise<void> {
	await bridge.evalJS(
		`(()=>{const ed=document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")||document.querySelector("[contenteditable='true']");ed?.focus();return ed?'ok':'no-ed'})()`,
	);
	await bridge.press("Backspace");
	await bridge.sleep(8000);
}

// ───────────────────────────────────────────────────────────────────────────
// Save content via X GraphQL endpoints
// ───────────────────────────────────────────────────────────────────────────

const FEATURES = {
	profile_label_improvements_pcf_label_in_post_enabled: true,
	responsive_web_profile_redirect_enabled: false,
	rweb_tipjar_consumption_enabled: false,
	verified_phone_label_enabled: false,
	responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
	responsive_web_graphql_timeline_navigation_enabled: true,
};
const QUERY_IDS = {
	UPDATE_CONTENT: "M7N2FrPrlOmu-YrVIBxFnQ",
	UPDATE_TITLE: "x75E2ABzm8_mGTg1bz8hcA",
	UPDATE_COVER: "Es8InPh7mEkK9PxclxFAVQ",
	GET_BY_ID: "8-OHhj8-KCAHUP8XjPaAYQ",
};
const AUTH_HEADERS_JS = `(()=>{
  const csrf=(document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1];
  return {Authorization:'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA','x-csrf-token':csrf,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes'};
})()`;

async function saveContent(
	bridge: Bridge,
	articleId: string,
	contentState: ReturnType<typeof buildContentState>,
): Promise<{ status: number; err: string | null; hasData: boolean }> {
	const body = {
		variables: { content_state: contentState, article_entity: articleId },
		features: FEATURES,
		queryId: QUERY_IDS.UPDATE_CONTENT,
	};
	const js = `(async()=>{
    const H=${AUTH_HEADERS_JS};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_CONTENT}/ArticleEntityUpdateContent',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null,hasData:!!j?.data?.articleentity_update_content_state});
  })()`;
	return (await bridge.evalJS(js)) as { status: number; err: string | null; hasData: boolean };
}

async function saveTitle(bridge: Bridge, articleId: string, title: string): Promise<void> {
	if (!title) return;
	const body = {
		variables: { articleEntityId: articleId, title },
		features: FEATURES,
		queryId: QUERY_IDS.UPDATE_TITLE,
	};
	const js = `(async()=>{
    const H=${AUTH_HEADERS_JS};
    await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_TITLE}/ArticleEntityUpdateTitle',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    return 'ok';
  })()`;
	await bridge.evalJS(js);
}

async function saveCoverMedia(
	bridge: Bridge,
	articleId: string,
	mediaId: string,
	mediaCategory = "DraftTweetImage",
): Promise<{ status: number; err: string | null }> {
	const body = {
		variables: {
			articleEntityId: articleId,
			coverMedia: { media_id: mediaId, media_category: mediaCategory },
		},
		features: FEATURES,
		queryId: QUERY_IDS.UPDATE_COVER,
	};
	const js = `(async()=>{
    const H=${AUTH_HEADERS_JS};
    const r=await fetch('https://x.com/i/api/graphql/${QUERY_IDS.UPDATE_COVER}/ArticleEntityUpdateCoverMedia',{method:'POST',credentials:'include',headers:{...H,'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    return JSON.stringify({status:r.status,err:j?.errors?.[0]?.message||null});
  })()`;
	return (await bridge.evalJS(js)) as { status: number; err: string | null };
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

export async function publishViaApiMcp(
	plugin: XArticleInObsidianPlugin,
	sourceNote?: PublishSourceNote,
): Promise<void> {
	try {
		// Prefer an explicit sourceNote (passed from the preview panel "publish"
		// button — that view is the active leaf, not the markdown view). Only
		// fall back to the active markdown view when invoked from the command
		// palette while a markdown leaf is focused.
		let file: TFile | null = sourceNote?.file ?? null;
		let content: string | null = sourceNote?.content ?? null;
		if (!file || content === null) {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			file = view?.file ?? file;
			content = view?.editor.getValue() ?? content;
		}
		if (!file || content === null) {
			new Notice("Open a markdown note first.");
			return;
		}
		await runApiPublish(plugin, file, content);
	} catch (error) {
		await appendPublishLog(plugin, "publish.api.error", { error });
		new Notice(normalizeMcpErrorMessage(error, plugin));
	}
}

async function runApiPublish(plugin: XArticleInObsidianPlugin, file: TFile, rawMarkdown: string): Promise<void> {
	await appendPublishLog(plugin, "publish.api.preflight", { sourceNotePath: file.path });

	const payload = await buildPublishPayloadForNote(plugin, file, rawMarkdown);
	const segments = processedMarkdownToSegments(payload.markdown, payload.items);
	const imageSegs = segments.filter((s): s is ImageSegment => s.type === "image");
	await appendPublishLog(plugin, "publish.api.segments", {
		title: payload.title,
		segmentTypes: segments.reduce<Record<string, number>>((acc, s) => {
			acc[s.type] = (acc[s.type] || 0) + 1;
			return acc;
		}, {}),
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
			{
				function: normalizeEvaluateSource(`async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const btn =
          document.querySelector("button[aria-label='create']") ||
          Array.from(document.querySelectorAll("button[role='button'], button")).find((b) =>
            (b.getAttribute("aria-label") || "").toLowerCase() === "create"
          ) ||
          document.querySelector("a[data-testid='empty_state_button_text']");
        if (!btn) throw new Error("Create button not found.");
        btn.click();
        for (let i = 0; i < 30; i++) {
          const ed = document.querySelector("[data-contents='true']")?.closest("[contenteditable='true']")
                  || document.querySelector("[contenteditable='true']");
          if (ed) return true;
          await sleep(200);
        }
        throw new Error("Editor did not become ready after clicking create.");
      }`),
			},
			MCP_EVALUATE_TIMEOUT_MS,
		);

		const bridge = makeBridge(client);

		// Read article id from current URL
		const urlInfo = (await bridge.evalJS(
			`(()=>{const m=location.href.match(/\\/articles\\/edit\\/(\\d+)/);return JSON.stringify({url:location.href,id:m?m[1]:null})})()`,
		)) as { url: string; id: string | null };
		if (!urlInfo?.id) throw new Error(`Tab is not on an article edit page: ${urlInfo?.url}`);
		const articleId = urlInfo.id;

		// Upload images, mapping by their position in segments
		const mediaInfoBySegmentIndex = new Map<number, MediaInfo>();
		let imgIdx = 0;
		for (let i = 0; i < segments.length; i += 1) {
			const seg = segments[i];
			if (!seg || seg.type !== "image") continue;
			imgIdx += 1;
			let lastErr: unknown = null;
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				try {
					const info = await uploadOneImage(bridge, seg);
					mediaInfoBySegmentIndex.set(i, info);
					await appendPublishLog(plugin, "publish.api.image_ok", {
						index: imgIdx,
						total: imageSegs.length,
						mediaIdSuffix: info.mediaId.slice(-8),
					});
					lastErr = null;
					break;
				} catch (e) {
					lastErr = e;
					if (attempt < 2) await new Promise<void>((r) => setTimeout(r, 2000));
				}
			}
			if (lastErr) {
				await appendPublishLog(plugin, "publish.api.image_fail", {
					index: imgIdx,
					error: String((lastErr as Error).message || lastErr),
				});
			}
		}

		if (imgIdx > 0) await flushAutosave(bridge);

		// Cover image: upload via the same onFilesAdded path (the auto-
		// inserted atomic in the editor body gets discarded when our
		// content_state save replaces everything), then POST
		// ArticleEntityUpdateCoverMedia with the bound mediaId.
		if (payload.cover) {
			try {
				const coverInfo = await uploadOneImage(bridge, {
					type: "image",
					alt: payload.cover.alt || "cover",
					fileName: payload.cover.fileName,
					mimeType: payload.cover.mimeType,
					base64: payload.cover.base64,
				});
				await flushAutosave(bridge);
				const cr = await saveCoverMedia(
					bridge,
					articleId,
					coverInfo.mediaId,
					coverInfo.mediaCategory || "DraftTweetImage",
				);
				await appendPublishLog(plugin, "publish.api.cover_save", { ...cr, mediaIdSuffix: coverInfo.mediaId.slice(-8) });
			} catch (e) {
				await appendPublishLog(plugin, "publish.api.cover_fail", { error: String((e as Error).message || e) });
			}
		}

		const contentState = buildContentState(segments, mediaInfoBySegmentIndex);
		await appendPublishLog(plugin, "publish.api.content_built", {
			blocks: contentState.blocks.length,
			entities: contentState.entity_map.length,
		});

		if (payload.title) {
			try {
				await saveTitle(bridge, articleId, payload.title);
			} catch (e) {
				await appendPublishLog(plugin, "publish.api.title_fail", { error: String((e as Error).message || e) });
			}
		}

		const sr = await saveContent(bridge, articleId, contentState);
		await appendPublishLog(plugin, "publish.api.save_done", sr);

		// The editor's local Draft EditorState is still pre-publish — reload
		// the page so the user sees the freshly-saved article without
		// having to refresh manually.
		try {
			await bridge.evalJS(`(()=>{location.reload();return 'reloading'})()`);
		} catch {
			// ignore — page may navigate before evalJS returns
		}

		new Notice(plugin.t("notice.publishSuccess", { source: runtime.source }));
	} finally {
		await client.close();
	}
}

// silence unused-import warnings — buildPublishFunctionForNote is re-exported for IDE goto
void buildPublishFunctionForNote;
