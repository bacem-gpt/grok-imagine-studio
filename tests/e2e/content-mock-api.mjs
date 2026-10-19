// Mock Grok REST endpoints used by the content-script mock pages (tests/fixtures/grok/*), plugged into
// harness.routeGrok(). Returns route.fulfill() options, or null for requests it does not handle (the harness
// then falls back to its own routes).
//   POST /rest/media/post/list?cursor=…[&age=<s>][&skew=<s>]   -> page 2 of the Imagine feed (older posts)
//   POST /rest/app-chat/conversations/new[?skew=<s>]            -> NDJSON stream: tokens + video generation
//   POST /rest/app-chat/conversations/<id>/responses            -> same stream (chat replies)
// Responses carry a Date header like a real server. skew=<s>: the mock server's clock runs <s> seconds behind the
// browser's (a user whose clock is ahead); age=<s>: page-2 posts were created <s> seconds before (server) now.
import { POSTS, USER } from './fixtures-map.mjs';

export const GENERATED_POST = '66666666-6666-4666-8666-666666666666';

/** Feed page 2: posts that are not in POSTS, served from the generic /test/ asset route (URL-keyed merging). */
export const PAGE2_POSTS = [
  { id: '77777777-7777-4777-8777-777777777777', file: 'clip-blue.mp4', thumb: 'thumb-blue.jpg', prompt: 'Page two: blue hour skyline timelapse' },
  { id: '88888888-8888-4888-8888-888888888888', file: 'clip-green.mp4', thumb: 'thumb-green.jpg', prompt: 'Page two: green aurora over a frozen lake' },
];

const rel = (id, name) => `users/${USER}/generated/${id}/${name}`;
/** The mock server's clock (ms). */
const serverNow = (url) => Date.now() - (Number(url.searchParams.get('skew')) || 0) * 1000;

function page2(url) {
  const age = url.searchParams.get('age');
  const now = serverNow(url);
  return {
    posts: PAGE2_POSTS.map((p, i) => ({
      id: p.id,
      createTime: age != null ? new Date(now - Number(age) * 1000 - i * 1000).toISOString() : `2026-10-17T1${i}:00:00Z`,
      prompt: p.prompt,
      originalPrompt: p.prompt,
      modelName: 'imagine-video-1.5',
      mediaType: 'MEDIA_POST_TYPE_VIDEO',
      mimeType: 'video/mp4',
      mediaUrl: `https://assets.grok.com/test/${p.file}?post=${p.id.slice(0, 8)}`,
      hdMediaUrl: null,
      thumbnailImageUrl: `https://assets.grok.com/test/${p.thumb}?post=${p.id.slice(0, 8)}`,
      childPosts: [],
    })),
    nextCursor: null,
  };
}

function chatStream(body) {
  const message = String(body?.message || 'Make a video');
  const id = body?.genId && POSTS[body.genId] ? body.genId : GENERATED_POST;
  const lines = [
    { result: { conversation: { conversationId: 'mock-conversation-1', title: 'Mock conversation' } } },
    { result: { response: { userResponse: { responseId: 'u-1', message, sender: 'human' } } } },
    { result: { response: { token: 'Here is ', isThinking: false } } },
    { result: { response: { token: 'your video: ', isThinking: false } } },
    { result: { response: { streamingVideoGenerationResponse: { videoId: id, progress: 20, videoUrl: rel(id, 'generated_video.mp4') } } } },
    { result: { response: { streamingVideoGenerationResponse: { videoId: id, progress: 65 } } } },
    {
      result: {
        response: {
          streamingVideoGenerationResponse: {
            videoId: id,
            progress: 100,
            videoUrl: rel(id, 'generated_video.mp4'),
            thumbnailImageUrl: rel(id, 'preview_image.jpg'),
            videoPrompt: message,
            modelName: 'imagine-video-1.5',
          },
        },
      },
    },
    { result: { response: { token: message.slice(0, 40) + '.', isThinking: false } } },
    { result: { response: { modelResponse: { responseId: 'r-1', message: `Here is your video: ${message}`, sender: 'ASSISTANT' } } } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * @param {URL} url
 * @param {import('@playwright/test').Request} request
 * @returns {null | {status: number, headers?: object, contentType?: string, body: string}}
 */
export function grokMockApi(url, request) {
  const p = url.pathname;
  const date = new Date(serverNow(url)).toUTCString();
  if (p.startsWith('/rest/media/post/list') && url.searchParams.get('cursor')) {
    return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', date }, body: JSON.stringify(page2(url)) };
  }
  if (request.method() === 'POST' && /^\/rest\/app-chat\/conversations\/(new|[^/]+\/responses)$/.test(p)) {
    let body = {};
    try {
      body = JSON.parse(request.postData() || '{}');
    } catch {
      body = {};
    }
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', date }, body: chatStream(body) };
  }
  return null;
}
