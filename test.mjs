#!/usr/bin/env node
/**
 * pi-proxy-router regression coverage against the Pi 1.0 provider contract.
 *
 * No network and no private configuration: rules come from a temporary
 * `$HOME/.pi/agent/proxy-router.json` written with fictional proxy values,
 * providers/registry are mocks that only record the options they receive, and
 * the injected fetch is inspected but never called. Route decisions that would
 * open a connection are observed through the "Unsupported proxy URL" failure
 * instead (that check runs before any socket is created).
 *
 * Run: node test.mjs
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

const failures = [];
// Functions and undefined are meaningful values here, so serialize them instead
// of letting JSON.stringify collapse them to null/undefined.
const serialized = (value) =>
	JSON.stringify(value, (_key, item) =>
		typeof item === "function" ? "[function]" : item === undefined ? "[undefined]" : item,
	);
function check(name, actual, expected) {
	const a = serialized(actual);
	const e = serialized(expected);
	if (a !== e) failures.push(`${name}: expected ${e}, got ${a}`);
	else console.log(`✓ ${name}`);
}
function checkTrue(name, value, detail = "") {
	if (value) console.log(`✓ ${name}`);
	else failures.push(`${name}${detail ? ` (${detail})` : ""}`);
}
function checkRoute(name, run, needle) {
	try {
		run();
		failures.push(`${name}: expected a routed failure, got a fallback`);
	} catch (error) {
		const message = String(error?.message ?? error);
		if (needle && !message.includes(needle)) {
			failures.push(`${name}: expected "${needle}" in "${message}"`);
		} else console.log(`✓ ${name}`);
	}
}

// ── hermetic fixture config ────────────────────────────────────────────

const PROXY_CODEX = "socks5h://codex-proxy.example.test:1080";
const PROXY_OPENAI = "socks5h://openai-proxy.example.test:1080";
const PROXY_GO = "socks5h://go-proxy.example.test:1080";
const PROXY_IMAGES = "socks5h://images-proxy.example.test:1080";
const PROXY_CLASSIFY = "socks5h://classify-proxy.example.test:1080";
const AUTH_CODEX = "ftp://codex-auth.example.test:1";
const AUTH_CHATGPT = "ftp://chatgpt-auth.example.test:1";
const AUTH_IMAGE = "ftp://unsupported.example.test:1";
const AUTH_CLASSIFIER = "ftp://unsupported-cls.example.test:1";

const home = mkdtempSync(join(tmpdir(), "pi-router-home-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-router-cwd-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(
	join(home, ".pi", "agent", "proxy-router.json"),
	JSON.stringify(
		{
			models: {
				"openai-codex/*": PROXY_CODEX,
				"openai/*": PROXY_OPENAI,
				"opencode-go/gpt*": PROXY_GO,
				"images-only/*": PROXY_IMAGES,
				"classify-only/*": PROXY_CLASSIFY,
				"unsupported-only/*": AUTH_IMAGE,
				"unsupported-cls/*": AUTH_CLASSIFIER,
				"direct-only/*": "direct",
			},
			auth: {
				"openai-codex": AUTH_CODEX,
				openai: AUTH_CHATGPT,
			},
		},
		null,
		2,
	),
);
process.env.HOME = home;
process.chdir(cwd);

// Fallback dispatcher installed before the extension loads, so the extension's
// process-wide wrapper delegates un-routed requests here.
const fallbackCalls = [];
setGlobalDispatcher({
	dispatch(options) {
		fallbackCalls.push(`${options.method ?? "GET"} ${options.origin}${options.path ?? "/"}`);
		return true;
	},
	close: async () => {},
	destroy: async () => {},
});

const { default: factory } = await import("./index.ts");

const handlers = new Map();
const commands = new Map();
const notices = [];
factory({
	registerFlag() {},
	getFlag: () => false,
	registerCommand: (name, options) => commands.set(name, options),
	on: (event, handler) => handlers.set(event, handler),
	events: { on: () => () => {}, emit() {} },
});

const dispatcher = getGlobalDispatcher();
const dispatchUrl = (origin, path, method = "POST") => dispatcher.dispatch({ origin, path, method }, {});

// ── 1. auth endpoint routing ───────────────────────────────────────────

checkRoute(
	"auth: openai ChatGPT token endpoint uses the openai rule",
	() => dispatchUrl("https://auth.openai.com", "/api/accounts/oauth/token"),
	"chatgpt-auth.example.test",
);
checkRoute(
	"auth: openai-codex /oauth/token keeps its own rule",
	() => dispatchUrl("https://auth.openai.com", "/oauth/token"),
	"codex-auth.example.test",
);
checkRoute(
	"auth: openai-codex device code endpoints unchanged",
	() => dispatchUrl("https://auth.openai.com", "/api/accounts/deviceauth/usercode"),
	"codex-auth.example.test",
);
checkRoute(
	"auth: openai-codex device token endpoint unchanged",
	() => dispatchUrl("https://auth.openai.com", "/api/accounts/deviceauth/token"),
	"codex-auth.example.test",
);

const before = fallbackCalls.length;
for (const [origin, path, why] of [
	["https://auth.openai.com", "/api/accounts/authorize", "browser authorize page"],
	["https://auth.openai.com", "/api/accounts/oauth/token/extra", "extra path segment"],
	["https://auth.openai.com", "/api/accounts/oauth/tokenX", "path suffix"],
	["https://other.example.test", "/api/accounts/oauth/token", "other host"],
	["https://platform.claude.com", "/v1/oauth/token", "provider without an auth rule"],
]) {
	dispatchUrl(origin, path);
}
check("auth: non-target endpoints fall back to the default dispatcher", fallbackCalls.length - before, 5);
checkTrue("auth: fallback kept the default path", fallbackCalls.at(-1).startsWith("POST https://platform.claude.com"), fallbackCalls.at(-1));

// ── mock providers and registry (no network) ───────────────────────────

const CODEX_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex" };
const OPENAI_MODEL = { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const GO_MODEL = { provider: "opencode-go", id: "gpt-5", api: "openai-completions", baseUrl: "https://opencode.example.test/v1" };
const GO_UNMATCHED = { provider: "opencode-go", id: "deepseek-x", api: "openai-completions", baseUrl: "https://opencode-deepseek.example.test/v1" };
const ZAI_MODEL = { provider: "zai", id: "glm-4.6", api: "openai-completions", baseUrl: "https://api.example.test/v1" };
const DIRECT_MODEL = { provider: "direct-only", id: "dm-1", api: "openai-completions", baseUrl: "https://direct.example.test/v1" };
const UNMATCHED_IMAGE = { provider: "opencode-go", id: "deepseek-image", api: "openai-images", baseUrl: "https://opencode-images.example.test/v1" };
const GO_IMAGE = { provider: "images-only", id: "dall-e-test", api: "openai-images", baseUrl: "https://images.example.test/v1" };
const CLASSIFIER = { provider: "classify-only", id: "typesafe-1", api: "typesafe-system-one", baseUrl: "https://classify.example.test/v1" };

function mkBase(id, { classify = true, images = true, deferred = true } = {}) {
	const calls = [];
	const base = {
		id,
		name: id,
		auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
		getModels: () => [],
		getAllModels: () => [],
		calls,
		streamSimple(model, context, options) {
			this.calls.push({ kind: "streamSimple", target: `${model.provider}/${model.id}`, options });
			return { kind: "streamSimple", options };
		},
		stream(model, context, options) {
			this.calls.push({ kind: "stream", target: `${model.provider}/${model.id}`, options });
			return { kind: "stream", options };
		},
	};
	if (deferred) {
		base.fetchDeferred = function (model, handle, options) {
			this.calls.push({ kind: "fetchDeferred", target: `${model.provider}/${model.id}`, handle, options });
			return { kind: "fetchDeferred", options };
		};
		base.cancelDeferred = function (model, handle, options) {
			this.calls.push({ kind: "cancelDeferred", target: `${model.provider}/${model.id}`, handle, options });
			return Promise.resolve("cancelled");
		};
	}
	if (images) {
		base.generateImages = function (model, context, options) {
			this.calls.push({ kind: "generateImages", target: `${model.provider}/${model.id}`, context, options });
			return Promise.resolve({ kind: "generateImages", options });
		};
	}
	if (classify) {
		base.classify = function (model, context, options) {
			this.calls.push({ kind: "classify", target: `${model.provider}/${model.id}`, context, options });
			return Promise.resolve({ kind: "classify", options });
		};
	}
	return base;
}

const MARKER = Symbol.for("pi-proxy-router.routed-provider");

function mkRegistry(bases, models) {
	const current = new Map();
	const registered = [];
	return {
		bases,
		registered,
		getAll: () => models.chat,
		getModelsOfType: (type) => (type === "image" ? models.image : models.classifier),
		getProvider: (id) => current.get(id) ?? bases.get(id),
		registerProvider: (provider) => {
			current.set(provider.id, provider);
			registered.push(provider.id);
		},
	};
}
const sessionStart = (registry) =>
	handlers.get("session_start")({ type: "session_start", reason: "startup" }, { modelRegistry: registry, ui: { notify() {} } });
const runCommand = async (name, args, registry) => {
	notices.length = 0;
	await commands.get(name).handler(args, { modelRegistry: registry, ui: { notify: (message) => notices.push(message) }, hasUI: true });
	return notices.join("\n");
};

// ── 2. per-model chat routing ──────────────────────────────────────────

const bases = new Map([
	["openai-codex", mkBase("openai-codex")],
	["openai", mkBase("openai")],
	["opencode-go", mkBase("opencode-go")],
	["zai", mkBase("zai")],
	["direct-only", mkBase("direct-only", { classify: false, images: false, deferred: false })],
]);
const registry = mkRegistry(bases, {
	chat: [CODEX_MODEL, OPENAI_MODEL, GO_MODEL, GO_UNMATCHED, ZAI_MODEL, DIRECT_MODEL],
	image: [GO_IMAGE, UNMATCHED_IMAGE],
	classifier: [CLASSIFIER],
});
sessionStart(registry);

const codexBase = bases.get("openai-codex");
const codexWrapped = registry.getProvider("openai-codex");
const chatOptions = { temperature: 0.5, headers: { "x-test": "1" }, signal: new AbortController().signal };
const chatResult = codexWrapped.streamSimple(CODEX_MODEL, {}, chatOptions);
const chatCall = codexBase.calls.at(-1);
check("chat: routed model keeps base method call (this binding)", chatCall.kind, "streamSimple");
check("chat: result passes through", chatResult.kind, "streamSimple");
check("chat: routed model gets a fetch", typeof chatCall.options.fetch, "function");
check(
	"chat: other options are preserved",
	{
		temperature: chatCall.options.temperature,
		headers: chatCall.options.headers,
		signal: chatCall.options.signal === chatOptions.signal,
	},
	{ temperature: 0.5, headers: { "x-test": "1" }, signal: true },
);
check("chat: caller options object is not mutated", chatOptions.fetch, undefined);
check("chat: openai-codex routed over a proxy is forced to SSE", chatCall.options.transport, "sse");

const goWrapped = registry.getProvider("opencode-go");
goWrapped.streamSimple(GO_MODEL, {}, { maxTokens: 7 });
const goCall = bases.get("opencode-go").calls.at(-1);
check("chat: wildcard rule (opencode-go/gpt*) injects fetch", typeof goCall.options.fetch, "function");
check("chat: wildcard rule keeps unrelated options", goCall.options.maxTokens, 7);
check("chat: wildcard rule does not force SSE", goCall.options.transport, undefined);

const unmatchedOptions = { maxTokens: 3 };
goWrapped.streamSimple(GO_UNMATCHED, {}, unmatchedOptions);
const unmatchedCall = bases.get("opencode-go").calls.at(-1);
check("chat: unmatched model keeps the caller options object", unmatchedCall.options === unmatchedOptions, true);
check("chat: unmatched model gets no fetch and no transport", [unmatchedCall.options.fetch, unmatchedCall.options.transport], [undefined, undefined]);

const directWrapped = registry.getProvider("direct-only");
directWrapped.streamSimple(DIRECT_MODEL, {}, { maxTokens: 1 });
const directCall = bases.get("direct-only").calls.at(-1);
check("chat: explicit direct rule still injects its dispatcher fetch", typeof directCall.options.fetch, "function");
check("chat: explicit direct rule adds no transport", directCall.options.transport, undefined);

check("chat: provider without a matching model stays unwrapped", registry.getProvider("zai") === bases.get("zai"), true);
check("chat: caller-provided transport survives on a non-codex route", (() => {
	registry.getProvider("openai").streamSimple(OPENAI_MODEL, {}, { transport: "websocket" });
	return bases.get("openai").calls.at(-1).options.transport;
})(), "websocket");

check("chat: /proxy resolves an exact rule", (await runCommand("proxy", "openai-codex/gpt-5.6-luna", registry)).includes(PROXY_CODEX), true);
check("chat: /proxy resolves a wildcard rule", (await runCommand("proxy", "opencode-go/gpt-5", registry)).includes(PROXY_GO), true);

for (let i = 0; i < 2; i += 1) sessionStart(registry);
let depth = 0;
let cursor = registry.getProvider("openai-codex");
while (cursor?.[MARKER]) {
	depth += 1;
	cursor = cursor[MARKER].original;
}
check("session_start: repeated sync does not stack router wrappers", depth, 1);
check("session_start: repeated sync does not re-register the same provider", registry.registered.filter((id) => id === "openai-codex").length, 1);

// ── 3. non-chat provider requests ──────────────────────────────────────

const deferredWrapped = registry.getProvider("openai");
const handle = { provider: "openai", modelId: OPENAI_MODEL.id, api: OPENAI_MODEL.api, id: "resp-1" };
const deferredOptions = { wait: 250, headers: { "x-deferred": "1" }, signal: new AbortController().signal };
const deferredResult = deferredWrapped.fetchDeferred(OPENAI_MODEL, handle, deferredOptions);
const deferredCall = bases.get("openai").calls.at(-1);
check("deferred: base method invoked with the same handle", deferredCall.handle === handle, true);
check("deferred: result passes through", deferredResult.kind, "fetchDeferred");
check("deferred: routed model gets a fetch", typeof deferredCall.options.fetch, "function");
check(
	"deferred: other options are preserved",
	{ wait: deferredCall.options.wait, headers: deferredCall.options.headers, signal: deferredCall.options.signal === deferredOptions.signal },
	{ wait: 250, headers: { "x-deferred": "1" }, signal: true },
);
check("deferred: no transport is forced on non-chat requests", deferredCall.options.transport, undefined);
check("deferred: caller options object is not mutated", deferredOptions.fetch, undefined);

const cancelResult = await deferredWrapped.cancelDeferred(OPENAI_MODEL, handle, deferredOptions);
const cancelCall = bases.get("openai").calls.at(-1);
check("cancel: result and cancellation behavior pass through", cancelResult, "cancelled");
check("cancel: same handle and routed options", [cancelCall.handle === handle, typeof cancelCall.options.fetch], [true, "function"]);

const imageContext = { input: [] };
const imageOptions = { headers: { "x-image": "1" } };
const imageResult = await goWrapped.generateImages(GO_IMAGE, imageContext, imageOptions);
const imageCall = bases.get("opencode-go").calls.at(-1);
check("images: context and options reach the base", [imageCall.context === imageContext, imageCall.options.headers], [true, { "x-image": "1" }]);
check("images: routed image model gets a fetch", typeof imageCall.options.fetch, "function");
check("images: result passes through", imageResult.kind, "generateImages");
check("images: caller options object is not mutated", imageOptions.fetch, undefined);

const classifierContext = { state: {}, questions: {} };
const classifyResult = await deferredWrapped.classify(CLASSIFIER, classifierContext, { temperature: 0.2 });
const classifyCall = bases.get("openai").calls.at(-1);
check("classify: context reaches the base", classifyCall.context === classifierContext, true);
check("classify: routed classifier model gets a fetch", typeof classifyCall.options.fetch, "function");
check("classify: result passes through", classifyResult.kind, "classify");

const unmatchedNonChat = { wait: 5 };
check("non-chat: unmatched model (opencode-go image) keeps the caller options object", (() => {
	goWrapped.fetchDeferred(UNMATCHED_IMAGE, handle, unmatchedNonChat);
	return bases.get("opencode-go").calls.at(-1).options === unmatchedNonChat;
})(), true);
check(
	"non-chat: unmatched model gets no fetch",
	bases.get("opencode-go").calls.at(-1).options.fetch,
	undefined,
);

for (const name of ["classify", "generateImages", "fetchDeferred", "cancelDeferred"]) {
	check(`non-chat: missing base method stays absent (${name})`, name in directWrapped, false);
}

// ── 4. endpoint fallback uses chat, image, and classifier models ────────

const imageOnlyBase = mkBase("unsupported-only");
const classifierOnlyBase = mkBase("unsupported-cls");
const unsupportedImage = { provider: "unsupported-only", id: "img-1", api: "openai-images", baseUrl: "https://unsupported.example.test/v1" };
const unsupportedClassifier = { provider: "unsupported-cls", id: "cls-1", api: "typesafe-system-one", baseUrl: "https://unsupported-cls.example.test/v1" };

// Nothing but an unmatched chat model: neither endpoint is known yet.
const chatOnlyRegistry = mkRegistry(new Map([["zai", bases.get("zai")]]), { chat: [ZAI_MODEL], image: [], classifier: [] });
sessionStart(chatOnlyRegistry);
const imageBefore = fallbackCalls.length;
dispatchUrl("https://unsupported.example.test", "/v1/images/generations");
check("fallback: image endpoint unknown with chat models only", fallbackCalls.length - imageBefore, 1);

// Adding the image model (getModelsOfType only) installs its endpoint fallback.
const imageRegistry = mkRegistry(
	new Map([["zai", bases.get("zai")], ["unsupported-only", imageOnlyBase]]),
	{ chat: [ZAI_MODEL], image: [unsupportedImage], classifier: [] },
);
sessionStart(imageRegistry);
checkRoute(
	"fallback: image model endpoint routes without chat models",
	() => dispatchUrl("https://unsupported.example.test", "/v1/images/generations"),
	AUTH_IMAGE,
);
check("fallback: image-only provider is wrapped for generateImages", (() => {
	const wrapped = imageRegistry.getProvider("unsupported-only");
	return typeof wrapped?.[MARKER] === "object" && wrapped.generateImages !== imageOnlyBase.generateImages;
})(), true);
const classifierBefore = fallbackCalls.length;
dispatchUrl("https://unsupported-cls.example.test", "/v1/classify");
check("fallback: classifier endpoint still unknown", fallbackCalls.length - classifierBefore, 1);

const fullRegistry = mkRegistry(
	new Map([["zai", bases.get("zai")], ["unsupported-only", imageOnlyBase], ["unsupported-cls", classifierOnlyBase]]),
	{ chat: [ZAI_MODEL], image: [unsupportedImage], classifier: [unsupportedClassifier] },
);
sessionStart(fullRegistry);
checkRoute(
	"fallback: classifier model endpoint routes after sync",
	() => dispatchUrl("https://unsupported-cls.example.test", "/v1/classify"),
	AUTH_CLASSIFIER,
);
const unmatchedBefore = fallbackCalls.length;
dispatchUrl("https://api.example.test", "/v1/chat/completions");
check("fallback: endpoint of an unmatched model is not routed", fallbackCalls.length - unmatchedBefore, 1);

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
