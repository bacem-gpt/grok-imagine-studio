// Fake Grok posts served by the test harness. UUIDs are stable so mock pages can reference them.
export const USER = 'test-user-0000';

export const POSTS = {
  '11111111-1111-4111-8111-111111111111': { kind: 'video', file: 'clip-red.mp4', thumb: 'thumb-red.jpg', prompt: 'A red sports car drifting through neon rain, cinematic tracking shot', width: 640, height: 360, duration: 4 },
  '22222222-2222-4222-8222-222222222222': { kind: 'video', file: 'clip-green.mp4', thumb: 'thumb-green.jpg', prompt: 'A misty green forest at dawn, slow dolly forward', width: 640, height: 360, duration: 3 },
  '33333333-3333-4333-8333-333333333333': { kind: 'video', file: 'clip-blue.mp4', thumb: 'thumb-blue.jpg', prompt: 'Deep blue ocean waves crashing on black rocks, drone shot', width: 640, height: 360, duration: 5 },
  '44444444-4444-4444-8444-444444444444': { kind: 'video', file: 'clip-hd.mp4', thumb: 'thumb-hd.jpg', prompt: 'A purple nebula swirling, slow orbit, 24fps HD', width: 1280, height: 720, duration: 6 },
  '55555555-5555-4555-8555-555555555555': { kind: 'image', file: 'still.jpg', thumb: 'still.jpg', prompt: 'A colorful test pattern poster', width: 1024, height: 1024 },
  '66666666-6666-4666-8666-666666666666': { kind: 'video', file: 'clip-vertical.mp4', thumb: 'thumb-vertical.jpg', prompt: 'Vertical orange sunset over a desert road', width: 360, height: 640, duration: 3 },
};

export const assetUrl = (id, name) => `https://assets.grok.com/users/${USER}/generated/${id}/${name}`;
export const videoUrl = (id) => assetUrl(id, 'generated_video.mp4');
export const thumbUrl = (id) => assetUrl(id, 'preview_image.jpg');
export const imageUrl = (id) => assetUrl(id, 'image.jpg');

/** The JSON shape Grok's /rest/media/post/list returns (fields the extension reads). */
export function mediaPostList(ids = Object.keys(POSTS)) {
  return {
    posts: ids.map((id) => {
      const p = POSTS[id];
      const isVideo = p.kind === 'video';
      return {
        id,
        createTime: '2026-10-18T12:00:00Z',
        prompt: p.prompt,
        originalPrompt: p.prompt,
        modelName: isVideo ? 'imagine-video-1.5' : 'imagine-image',
        mediaType: isVideo ? 'MEDIA_POST_TYPE_VIDEO' : 'MEDIA_POST_TYPE_IMAGE',
        mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
        mediaUrl: isVideo ? videoUrl(id) : imageUrl(id),
        hdMediaUrl: isVideo ? videoUrl(id) : null,
        thumbnailImageUrl: thumbUrl(id),
        childPosts: [],
      };
    }),
  };
}
