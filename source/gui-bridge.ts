#!/usr/bin/env node
/**
 * gui-bridge.ts
 *
 * Ez a fájl a natív (Tauri) Instlux GUI és az InstagramClient közötti híd.
 * Egy egyszerű newline-delimited JSON-RPC szerverként fut stdin/stdout felett:
 *
 *   - A GUI (Rust oldal) minden sorban egy JSON parancsot küld a stdin-re:
 *       {"id": 1, "method": "login", "params": {"username": "...", "password": "..."}}
 *
 *   - A bridge válaszol egy sorban a stdout-ra:
 *       {"id": 1, "result": {...}}          -- siker esetén
 *       {"id": 1, "error": "hibaüzenet"}    -- hiba esetén
 *
 *   - A kliens realtime eseményeit (message, reaction, threadSeen, stb.)
 *     "id" nélküli, "event" mezős sorokként küldjük ki bármikor:
 *       {"event": "message", "data": {...}}
 *
 * Fontos: a logger fájlba ír (lásd utils/logger.ts), tehát a stdout
 * kizárólag a JSON-RPC protokollnak van fenntartva. Soha ne használj itt
 * console.log-ot semmi máshoz, csak a sendResponse/sendEvent függvényeken
 * keresztül!
 */

import readline from 'node:readline';
import process from 'node:process';
import {InstagramClient} from './client.js';
import type {LoginResult} from './client.js';
import {initializeLogger} from './utils/logger.js';
import type {IgApiClientExt} from 'instagram_mqtt';

type RpcRequest = {
	id: number;
	method: string;
	params?: Record<string, unknown>;
};

type RpcSuccess = {
	id: number;
	result: unknown;
};

type RpcError = {
	id: number;
	error: string;
};

type RpcEvent = {
	event: string;
	data: unknown;
};

function sendResponse(response: RpcSuccess | RpcError): void {
	process.stdout.write(JSON.stringify(response) + '\n');
}

function sendEvent(event: string, data: unknown): void {
	const payload: RpcEvent = {event, data};
	process.stdout.write(JSON.stringify(payload) + '\n');
}

// Aktív kliens (egyszerre egy bejelentkezett felhasználó van kezelve a
// GUI-ban -- ha kell multi-account, ezt Map<username, InstagramClient>-re
// bővítjük később).
let client: InstagramClient | undefined;

// A timeline (Feed fül) lapozásához perzisztens feed-objektumot kell
// tartanunk a hívások között -- ugyanúgy, ahogy a client.ts is teszi az
// inboxFeed-del a threadeknél. A raw IgApiClient timeline() metódusa
// minden híváskor egy ÚJ feed-et adna vissza (nextMaxId nélkül), ha nem
// tárolnánk el ugyanazt a példányt.
let timelineFeed: ReturnType<IgApiClientExt['feed']['timeline']> | undefined;

/**
 * A nyers Instagram API válaszban (timeline feed item / carousel item) a
 * legjobb minőségű kép/videó URL kiválasztása. Ugyanaz a logika, mint a
 * client.ts-ben lévő getBestMediaUrl, csak ez tetszőleges nyers itemre megy
 * (nem csak a DM Message típusra), mert a timeline feed elemek típusa nem
 * hivatalosan dokumentált az instagram-private-api-ban.
 */
function bestMediaUrlFromRaw(
	raw: Record<string, unknown>,
): {url: string; type: 'image' | 'video'} | undefined {
	const videoVersions = raw['video_versions'] as
		| Array<{url: string; width: number; height: number}>
		| undefined;
	if (videoVersions && videoVersions.length > 0) {
		const best = videoVersions.reduce((a, b) =>
			a.width * a.height > b.width * b.height ? a : b,
		);
		return {url: best.url, type: 'video'};
	}

	const imageVersions2 = raw['image_versions2'] as
		| {candidates?: Array<{url: string; width: number; height: number}>}
		| undefined;
	const candidates = imageVersions2?.candidates;
	if (candidates && candidates.length > 0) {
		const best = candidates.reduce((a, b) =>
			a.width * a.height > b.width * b.height ? a : b,
		);
		return {url: best.url, type: 'image'};
	}

	return undefined;
}

function ensureClient(): InstagramClient {
	if (!client) {
		client = new InstagramClient();
		wireClientEvents(client);
	}

	return client;
}

function wireClientEvents(instance: InstagramClient): void {
	instance.on('message', (data) => {
		sendEvent('message', data);
	});
	instance.on('reaction', (data) => {
		sendEvent('reaction', data);
	});
	instance.on('threadSeen', (data) => {
		sendEvent('threadSeen', data);
	});
	instance.on('realtimeStatus', (status) => {
		sendEvent('realtimeStatus', status);
	});
	instance.on('error', (error: unknown) => {
		sendEvent('error', error instanceof Error ? error.message : String(error));
	});
}

/**
 * Minden RPC metódus itt van felsorolva. Bővítsd, ahogy a GUI-nak
 * új funkciókra van szüksége -- a client.ts publikus API-ja szabja meg
 * mi elérhető (login, threads, messages, stories, stb.)
 */
const handlers: Record<
	string,
	(params: Record<string, unknown>) => Promise<unknown>
> = {
	async login(params) {
		const {username, password} = params as {
			username: string;
			password: string;
		};
		const instance = ensureClient();
		const result: LoginResult = await instance.login(username, password);
		return result;
	},

	async loginBySession(params) {
		const {username} = params as {username: string};
		if (!client) {
			client = new InstagramClient(username);
			wireClientEvents(client);
		}

		return client.loginBySession();
	},

	async twoFactorLogin(params) {
		if (!client) throw new Error('No active login attempt');
		return client.twoFactorLogin(
			params as unknown as Parameters<InstagramClient['twoFactorLogin']>[0],
		);
	},

	async logout() {
		if (!client) return;
		await client.logout();
		client = undefined;
		timelineFeed = undefined;
	},

	async getCurrentUser() {
		return ensureClient().getCurrentUser();
	},

	async getMyProfile() {
		const user = await ensureClient().getCurrentUser();
		if (!user?.username) {
			throw new Error('Nincs bejelentkezett felhasználó');
		}

		return ensureClient().getUserProfile(user.username);
	},

	async getThreads(params) {
		const {loadMore} = (params ?? {}) as {loadMore?: boolean};
		return ensureClient().getThreads(loadMore ?? false);
	},

	async getMessages(params) {
		const {threadId, cursor} = params as {
			threadId: string;
			cursor?: string;
		};
		return ensureClient().getMessages(threadId, cursor);
	},

	async sendMessage(params) {
		const {threadId, text} = params as {threadId: string; text: string};
		return ensureClient().sendMessage(threadId, text);
	},

	async sendReaction(params) {
		const {threadId, itemId, emoji} = params as {
			threadId: string;
			itemId: string;
			emoji: string;
		};
		return ensureClient().sendReaction(threadId, itemId, emoji);
	},

	async markThreadAsSeen(params) {
		const {threadId, itemId} = params as {threadId: string; itemId: string};
		return ensureClient().markThreadAsSeen(threadId, itemId);
	},

	async searchThreadsByTitle(params) {
		const {query} = params as {query: string};
		return ensureClient().searchThreadsByTitle(query);
	},

	/**
	 * Egy DM-ben kapott xma_media_share (reel/poszt megosztás) csak egy
	 * előnézeti képet és egy media ID-t tartalmaz -- a tényleges videó
	 * URL-t külön kell lekérni az Instagram media-info végpontjáról.
	 * Ezt csak igény szerint (kattintásra) hívjuk a GUI-ból, nem minden
	 * üzenetnél automatikusan, hogy ne pazaroljunk API hívást feleslegesen.
	 */
	async resolveXmaMedia(params) {
		const {mediaId} = params as {mediaId: string};
		const ig = ensureClient().getInstagramClient();
		const info = await ig.media.info(mediaId);
		const rawItem = info.items?.[0] as unknown as
			| Record<string, unknown>
			| undefined;
		if (!rawItem) {
			throw new Error('Nem található média ezzel az ID-vel');
		}

		return {
			media: bestMediaUrlFromRaw(rawItem),
		};
	},

	async getFeed(params) {
		const {loadMore} = (params ?? {}) as {loadMore?: boolean};

		// A client.ts nem exponál dedikált "home feed" (timeline) metódust,
		// de van egy getInstagramClient() escape hatch a nyers IgApiClient-re
		// -- ugyanígy csinálja a CLI feed parancsa is (commands/feed.tsx).
		const ig = ensureClient().getInstagramClient();

		if (!loadMore || !timelineFeed) {
			timelineFeed = ig.feed.timeline();
		}

		const items = (await timelineFeed.items()) as unknown as Array<
			Record<string, unknown>
		>;

		return {
			hasMore: timelineFeed.isMoreAvailable(),
			posts: items.map((item) => {
				const user = item['user'] as
					| {username?: string; profile_pic_url?: string}
					| undefined;
				const caption = item['caption'] as {text?: string} | undefined;
				const mediaType = item['media_type'] as number | undefined;
				const isCarousel = mediaType === 8;
				const carouselMedia = item['carousel_media'] as
					| Array<Record<string, unknown>>
					| undefined;

				return {
					id: (item['id'] ?? item['pk']) as string,
					username: user?.username,
					userProfilePic: user?.profile_pic_url,
					caption: caption?.text,
					likeCount: item['like_count'] as number | undefined,
					commentCount: item['comment_count'] as number | undefined,
					isVideo: mediaType === 2,
					isCarousel,
					media: bestMediaUrlFromRaw(item),
					carouselMedia: isCarousel
						? (carouselMedia ?? []).map((c) => ({
								media: bestMediaUrlFromRaw(c),
								isVideo: (c['media_type'] as number | undefined) === 2,
							}))
						: undefined,
				};
			}),
		};
	},

	async getReelsTray() {
		return ensureClient().getReelsTray();
	},

	async getStoriesForUser(params) {
		const {userId, username} = params as {
			userId?: string;
			username?: string;
		};
		return ensureClient().getStoriesForUser(userId, username);
	},

	async getRealtimeStatus() {
		return ensureClient().getRealtimeStatus();
	},

	async shutdown() {
		if (client) {
			await client.shutdown();
			client = undefined;
		}
	},
};

async function handleLine(line: string): Promise<void> {
	if (!line.trim()) return;

	let request: RpcRequest;
	try {
		request = JSON.parse(line) as RpcRequest;
	} catch {
		// Nem tudjuk kinek válaszoljunk, csak eldobjuk csendben (a logger
		// fájlba tudná naplózni, ha kell debughoz).
		return;
	}

	const handler = handlers[request.method];
	if (!handler) {
		sendResponse({id: request.id, error: `Unknown method: ${request.method}`});
		return;
	}

	try {
		const result = await handler(request.params ?? {});
		sendResponse({id: request.id, result});
	} catch (error) {
		sendResponse({
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function main(): Promise<void> {
	// Ugyanúgy, ahogy a cli.ts is teszi: a logger (és rajta keresztül a
	// ConfigManager) inicializálása KRITIKUS -- e nélkül a session/cache/logs
	// mappák útvonalai nincsenek beállítva, és a login/egyéb API hívások
	// csendben, nyomkövethetetlenül elhasalhatnak.
	await initializeLogger();

	const rl = readline.createInterface({input: process.stdin});
	rl.on('line', (line) => {
		handleLine(line).catch(() => {
			/* handleLine már maga kezeli a hibákat */
		});
	});

	process.on('SIGTERM', () => {
		void (async () => {
			if (client) await client.shutdown();
			process.exit(0);
		})();
	});

	// Jelezzük a Rust oldalnak, hogy a bridge készen áll fogadni parancsokat.
	sendEvent('ready', true);
}

await main();
