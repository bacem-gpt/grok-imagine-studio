// Prompt Builder chip catalogues, tuned for AI video generation (Grok Imagine and similar text/image-to-video models).
// Each field maps to groups of chips: {group, items: [{label, text}]}. `label` is the short chip caption, `text` the
// phrase written into the field (never contains commas, so chips can be toggled inside comma-separated lists).
// Users' own chips are stored in libraryStore.presets as {id, group: <field key>, label, text}.

const c = (label, text = label) => ({ label, text });

export const PRESETS = {
  subject: [
    { group: 'People', items: [c('Young woman', 'a young woman'), c('Old man', 'an elderly man with a weathered face'), c('Child', 'a curious child'), c('Couple', 'a young couple'), c('Crowd', 'a bustling crowd'), c('Astronaut', 'an astronaut in a white spacesuit'), c('Knight', 'a knight in battered armor'), c('Detective', 'a detective in a trench coat'), c('Dancer', 'a contemporary dancer'), c('Chef', 'a chef in a busy kitchen')] },
    { group: 'Creatures & things', items: [c('Dog', 'a golden retriever'), c('Cat', 'a black cat'), c('Dragon', 'a massive dragon'), c('Robot', 'a sleek humanoid robot'), c('Horse', 'a wild horse'), c('Whale', 'a humpback whale'), c('Sports car', 'a vintage sports car'), c('Spaceship', 'a battered spaceship'), c('Product', 'a premium product on a pedestal'), c('Bird flock', 'a flock of birds')] },
  ],
  action: [
    { group: 'Movement', items: [c('Walks to camera', 'walking slowly toward the camera'), c('Runs', 'running at full speed'), c('Turns to camera', 'turning to look straight into the camera'), c('Looks up', 'looking up at the sky in awe'), c('Dances', 'dancing with fluid movements'), c('Jumps', 'leaping through the air'), c('Falls', 'falling in slow motion'), c('Flies', 'soaring through the clouds'), c('Drives', 'driving fast down an empty road'), c('Swims', 'swimming through clear water')] },
    { group: 'Performance', items: [c('Smiles', 'breaking into a gentle smile'), c('Cries', 'a single tear rolling down the cheek'), c('Laughs', 'laughing freely'), c('Speaks', 'speaking directly to the camera'), c('Whispers', 'whispering a secret'), c('Reaches out', 'reaching out a hand toward the camera'), c('Hair in wind', 'hair blowing in the wind'), c('Fights', 'locked in an intense sword fight'), c('Transforms', 'slowly transforming'), c('Reveals', 'revealing a hidden object')] },
  ],
  setting: [
    { group: 'Urban', items: [c('Neon alley', 'in a rain-soaked neon-lit alley at night'), c('Rooftop', 'on a rooftop at sunset overlooking the city'), c('Subway', 'in an empty subway car'), c('Cafe', 'in a cozy cafe with steamed-up windows'), c('Warehouse', 'in an abandoned warehouse'), c('Megacity', 'in a futuristic megacity with flying cars'), c('Diner', 'in a retro 1950s diner'), c('Market', 'in a crowded night market')] },
    { group: 'Nature', items: [c('Misty forest', 'in a misty pine forest at dawn'), c('Desert', 'across vast desert dunes'), c('Mountain peak', 'on a snowy mountain peak'), c('Beach', 'on a quiet beach at golden hour'), c('Ocean', 'beneath the ocean surface'), c('Coral reef', 'over a vibrant coral reef'), c('Meadow', 'in a wildflower meadow'), c('Waterfall', 'beside a thundering waterfall'), c('Volcano', 'near an erupting volcano'), c('Aurora', 'under the northern lights')] },
    { group: 'Worlds', items: [c('Space station', 'inside a space station'), c('Alien planet', 'on an alien planet with two moons'), c('Castle hall', 'in a candlelit medieval castle hall'), c('Ruins', 'among ancient overgrown ruins'), c('Studio backdrop', 'against a seamless studio backdrop'), c('Dreamscape', 'in a surreal floating dreamscape'), c('Underwater city', 'in a sunken underwater city'), c('Cyberpunk lab', 'in a cluttered cyberpunk lab')] },
  ],
  shot: [
    { group: 'Framing', items: [c('Extreme wide', 'Extreme wide shot'), c('Wide', 'Wide shot'), c('Full', 'Full shot'), c('Medium wide', 'Medium wide shot'), c('Medium', 'Medium shot'), c('Medium close-up'), c('Close-up'), c('Extreme close-up'), c('Insert detail', 'Detail insert shot')] },
    { group: 'Angle', items: [c('Eye level', 'Eye-level shot'), c('Low angle', 'Low-angle shot'), c('High angle', 'High-angle shot'), c("Bird's-eye", "Bird's-eye view"), c("Worm's-eye", "Worm's-eye view"), c('Dutch angle', 'Dutch angle shot'), c('Top-down', 'Overhead top-down shot'), c('Aerial', 'Aerial shot')] },
    { group: 'Coverage', items: [c('Establishing', 'Establishing shot'), c('Over the shoulder', 'Over-the-shoulder shot'), c('POV', 'POV shot'), c('Two-shot'), c('Reaction', 'Reaction shot'), c('Silhouette', 'Silhouette shot'), c('Reflection', 'Reflection shot in a mirror'), c('Split screen', 'Split-screen shot')] },
  ],
  camera: [
    { group: 'Subtle', items: [c('Static', 'static locked-off camera'), c('Slow push-in', 'slow push-in toward the subject'), c('Slow pull-out', 'slow pull-out revealing the scene'), c('Gentle handheld', 'subtle handheld sway'), c('Slow pan left'), c('Slow pan right'), c('Tilt up', 'slow tilt up reveal'), c('Tilt down', 'slow tilt down')] },
    { group: 'Tracking', items: [c('Dolly in'), c('Dolly out'), c('Tracking', 'tracking shot following the subject'), c('Side track', 'lateral tracking shot'), c('Leading', 'leading shot moving backward ahead of the subject'), c('Steadicam', 'smooth steadicam glide'), c('Orbit', 'slow 360-degree orbit around the subject'), c('Arc', 'arc shot circling the subject')] },
    { group: 'Vertical & aerial', items: [c('Crane up', 'crane shot rising up'), c('Crane down', 'crane shot descending'), c('Drone ascent', 'drone ascending to reveal the landscape'), c('Drone fly-over', 'sweeping drone fly-over'), c('FPV dive', 'fast FPV drone dive'), c('Top-down rise', 'top-down camera rising straight up')] },
    { group: 'Dynamic', items: [c('Handheld', 'shaky handheld camera'), c('Whip pan'), c('Crash zoom'), c('Dolly zoom', 'dolly zoom vertigo effect'), c('Rack focus', 'rack focus from foreground to background'), c('Bullet time', 'bullet-time freeze with the camera orbiting'), c('Zoom in', 'slow zoom in'), c('Zoom out', 'slow zoom out'), c('Barrel roll', 'camera rolling 180 degrees')] },
  ],
  lens: [
    { group: 'Focal length', items: [c('14mm ultra-wide', '14mm ultra-wide lens'), c('24mm wide', '24mm wide-angle lens'), c('35mm', '35mm lens'), c('50mm', '50mm lens'), c('85mm portrait', '85mm portrait lens'), c('135mm tele', '135mm telephoto lens'), c('Macro', 'macro lens'), c('Fisheye', 'fisheye lens')] },
    { group: 'Focus & optics', items: [c('Shallow DOF', 'shallow depth of field'), c('Deep focus'), c('Creamy bokeh'), c('Soft focus'), c('Anamorphic', 'anamorphic lens with horizontal flares'), c('Tilt-shift', 'tilt-shift miniature effect'), c('Vintage glass', 'vintage lens with soft bloom'), c('Split diopter', 'split diopter shot')] },
    { group: 'Format', items: [c('35mm film', 'shot on 35mm film'), c('16mm grain', '16mm film grain'), c('IMAX', 'IMAX 70mm'), c('VHS', 'VHS camcorder footage'), c('Phone', 'smartphone footage'), c('Security cam', 'security camera footage'), c('Action cam', 'action camera footage'), c('Night vision', 'night-vision footage')] },
  ],
  motion: [
    { group: 'Intensity', items: [c('Almost still', 'very subtle motion'), c('Calm', 'calm slow-paced movement'), c('Natural', 'natural realistic movement'), c('Dynamic', 'dynamic movement'), c('Fast action', 'fast-paced action'), c('Explosive', 'explosive high-energy action'), c('Smooth', 'smooth fluid motion'), c('Floaty', 'weightless floating motion')] },
    { group: 'Elements', items: [c('Wind', 'hair and clothes blowing in the wind'), c('Particles', 'dust particles drifting in the light'), c('Rain', 'rain streaking down'), c('Snow', 'snow falling softly'), c('Smoke', 'smoke curling through the air'), c('Water ripples', 'water rippling'), c('Leaves', 'leaves swirling'), c('Sparks', 'sparks flying'), c('Background crowd', 'crowd moving in the background'), c('Clouds', 'clouds racing across the sky')] },
  ],
  timing: [
    { group: 'Speed', items: [c('Slow motion'), c('Super slow-mo', 'super slow motion'), c('Real time', 'real-time speed'), c('Time-lapse'), c('Hyperlapse'), c('Speed ramp', 'speed ramp from slow to fast'), c('Freeze frame', 'freeze frame at the end')] },
    { group: 'Structure', items: [c('One take', 'one continuous take'), c('Seamless loop'), c('Builds up', 'slowly building tension'), c('Big reveal', 'ending on a dramatic reveal'), c('Hold final frame', 'holding on the final frame'), c('Starts black', 'fading in from black'), c('6-second beat', 'a single 6-second beat'), c('10-second shot', 'a 10-second shot')] },
  ],
  lighting: [
    { group: 'Natural', items: [c('Golden hour', 'golden hour sunlight'), c('Blue hour', 'blue hour twilight'), c('Harsh noon', 'harsh midday sun'), c('Overcast', 'soft overcast light'), c('Moonlight'), c('Dappled', 'dappled sunlight through leaves'), c('Sunrise backlight'), c('Window light', 'soft window light')] },
    { group: 'Studio', items: [c('Soft key', 'soft key light'), c('Rembrandt', 'Rembrandt lighting'), c('Rim light', 'strong rim light'), c('Three-point', 'three-point lighting'), c('High-key', 'bright high-key lighting'), c('Low-key', 'low-key lighting with deep shadows'), c('Spotlight', 'single hard spotlight'), c('Ring light', 'ring light glow')] },
    { group: 'Dramatic', items: [c('Chiaroscuro'), c('Volumetric', 'volumetric light rays'), c('God rays', 'god rays through fog'), c('Silhouette', 'silhouetted against a bright sky'), c('Backlit haze'), c('Hard shadows'), c('Lightning', 'lightning flashes'), c('Strobe', 'strobing lights')] },
    { group: 'Practical & colour', items: [c('Neon', 'neon glow'), c('Candlelight'), c('Firelight', 'flickering firelight'), c('Fluorescent', 'flickering fluorescent light'), c('Bioluminescent', 'bioluminescent glow'), c('Emergency red', 'red emergency lighting'), c('Headlights', 'car headlights cutting through the dark'), c('Sunset glow', 'warm sunset glow')] },
  ],
  style: [
    { group: 'Live action', items: [c('Cinematic'), c('Photorealistic'), c('Hyperreal', 'hyperrealistic detail'), c('Film noir'), c('Blockbuster', 'epic blockbuster'), c('Indie film', 'indie film look'), c('Documentary', 'documentary style'), c('Nature doc', 'nature documentary'), c('Music video'), c('Commercial', 'premium commercial'), c('Vlog', 'handheld vlog style'), c('Trailer', 'movie trailer style')] },
    { group: 'Animation', items: [c('Anime'), c('3D animated', '3D animated feature film'), c('Claymation', 'stop-motion claymation'), c('2D hand-drawn', 'hand-drawn 2D animation'), c('Watercolor', 'watercolor animation'), c('Cel-shaded', 'cel-shaded comic look'), c('Low-poly', 'low-poly 3D'), c('Pixel art'), c('Paper cut-out', 'paper cut-out animation')] },
    { group: 'Art & era', items: [c('Oil painting'), c('Impressionist', 'impressionist painting'), c('Surreal', 'surrealist'), c('Concept art'), c('Ukiyo-e', 'ukiyo-e woodblock print'), c('1970s film', '1970s film look'), c('1980s VHS', '1980s home video'), c('Silent film', 'black-and-white silent film'), c('Technicolor', 'retro Technicolor'), c('Y2K', 'Y2K aesthetic')] },
    { group: 'Genre', items: [c('Sci-fi'), c('Cyberpunk'), c('Steampunk'), c('Fantasy', 'high fantasy'), c('Horror'), c('Western'), c('Post-apocalyptic'), c('Fairy tale', 'fairy tale'), c('Dreamcore')] },
  ],
  mood: [
    { group: 'Bright', items: [c('Joyful'), c('Playful'), c('Hopeful'), c('Whimsical'), c('Romantic'), c('Cozy'), c('Triumphant'), c('Energetic'), c('Peaceful'), c('Serene')] },
    { group: 'Dark', items: [c('Tense'), c('Suspenseful'), c('Mysterious'), c('Eerie'), c('Ominous'), c('Melancholic'), c('Lonely'), c('Gritty'), c('Chaotic'), c('Haunting')] },
    { group: 'Grand', items: [c('Epic'), c('Awe-inspiring'), c('Majestic'), c('Dreamy'), c('Nostalgic'), c('Intimate'), c('Contemplative'), c('Bittersweet')] },
  ],
  palette: [
    { group: 'Warm & cool', items: [c('Teal & orange', 'teal and orange'), c('Warm earthy', 'warm earthy tones'), c('Golden amber'), c('Autumn', 'autumn reds and browns'), c('Cool blue', 'cool blue tones'), c('Icy', 'icy whites and blues'), c('Emerald & gold', 'emerald and gold'), c('Crimson & black', 'crimson and black')] },
    { group: 'Saturation', items: [c('Vibrant', 'vibrant saturated colors'), c('Muted pastels'), c('Pastel candy', 'pastel candy colors'), c('Desaturated'), c('Bleach bypass'), c('High contrast'), c('Neon pink & cyan', 'neon pink and cyan'), c('Duotone', 'purple and orange duotone')] },
    { group: 'Mono & vintage', items: [c('Black & white', 'black and white'), c('Monochrome'), c('Sepia'), c('Faded film', 'faded film colors'), c('Kodachrome', 'Kodachrome-like colors'), c('Green tint', 'sickly green tint')] },
  ],
  audio: [
    { group: 'Ambience', items: [c('City', 'ambient city noise'), c('Rain', 'gentle rain'), c('Thunderstorm'), c('Wind', 'howling wind'), c('Ocean', 'waves crashing'), c('Forest', 'birdsong in a quiet forest'), c('Fire', 'crackling fire'), c('Crowd', 'crowd murmur'), c('Night', 'crickets at night'), c('Room tone', 'near silence with soft room tone')] },
    { group: 'Music', items: [c('Orchestral', 'epic orchestral score'), c('Piano', 'soft piano melody'), c('Lo-fi', 'lo-fi hip-hop beat'), c('Synthwave'), c('Tense strings'), c('Upbeat pop', 'upbeat pop music'), c('Ambient drone'), c('Jazz', 'smoky jazz'), c('Drums', 'pounding drums'), c('Choir', 'ethereal choir')] },
    { group: 'Effects & voice', items: [c('Footsteps'), c('Engine roar'), c('Explosion', 'distant explosion'), c('Whoosh', 'whoosh sound effects'), c('Heartbeat', 'heavy heartbeat'), c('Clock', 'clock ticking'), c('Glass', 'glass shattering'), c('Narrator', 'calm narrator voice-over'), c('Whisper', 'a whispered line of dialogue'), c('Cheering', 'crowd cheering'), c('No music', 'no music'), c('No dialogue', 'no dialogue')] },
  ],
  extra: [
    { group: 'Quality', items: [c('No text', 'no text or watermarks'), c('No subtitles'), c('Consistent character', 'keep the character consistent'), c('Highly detailed'), c('Smooth motion', 'smooth motion without flicker'), c('Real physics', 'realistic physics'), c('Natural skin', 'natural skin texture'), c('4K', '4K resolution')] },
    { group: 'Composition', items: [c('Centered', 'centered composition'), c('Rule of thirds'), c('Symmetrical', 'symmetrical composition'), c('Negative space', 'lots of negative space'), c('Vertical 9:16', 'vertical 9:16 framing'), c('Widescreen', 'widescreen 2.39:1 framing'), c('Leading lines'), c('Foreground depth', 'foreground elements for depth')] },
  ],
};

/** One-click looks that fill several builder fields at once. Values merge into empty fields or replace (UI choice). */
export const RECIPES = [
  { id: 'cinematic', label: 'Cinematic drama', fields: { style: 'cinematic, photorealistic', lighting: 'soft key light, low-key lighting with deep shadows', lens: '35mm lens, shallow depth of field', camera: 'slow push-in toward the subject', mood: 'intimate', palette: 'teal and orange' } },
  { id: 'epic', label: 'Epic adventure', fields: { shot: 'Extreme wide shot', camera: 'sweeping drone fly-over', lighting: 'golden hour sunlight', style: 'epic blockbuster', mood: 'awe-inspiring', audio: 'epic orchestral score' } },
  { id: 'anime', label: 'Anime', fields: { style: 'anime, cel-shaded comic look', palette: 'vibrant saturated colors', camera: 'tracking shot following the subject', motion: 'dynamic movement', mood: 'energetic' } },
  { id: 'noir', label: 'Film noir', fields: { style: 'film noir', lighting: 'low-key lighting with deep shadows, hard shadows', palette: 'black and white', mood: 'mysterious', audio: 'smoky jazz' } },
  { id: 'documentary', label: 'Documentary', fields: { style: 'nature documentary', camera: 'subtle handheld sway', lens: '135mm telephoto lens', lighting: 'soft overcast light', audio: 'birdsong in a quiet forest' } },
  { id: 'product', label: 'Product ad', fields: { shot: 'Close-up', camera: 'slow 360-degree orbit around the subject', lighting: 'soft key light, strong rim light', style: 'premium commercial', setting: 'against a seamless studio backdrop', audio: 'minimal electronic beat' } },
  { id: 'music-video', label: 'Music video', fields: { style: 'music video', camera: 'whip pan', lighting: 'neon glow, strobing lights', mood: 'energetic', palette: 'neon pink and cyan', audio: 'pounding drums' } },
  { id: 'horror', label: 'Horror', fields: { style: 'horror', lighting: 'flickering fluorescent light', camera: 'dolly in', mood: 'ominous', palette: 'sickly green tint', audio: 'ambient drone, a whispered line of dialogue' } },
  { id: 'vhs', label: 'Retro VHS', fields: { lens: 'VHS camcorder footage', style: '1980s home video', palette: 'faded film colors', motion: 'natural realistic movement', audio: 'room tone' } },
  { id: 'dreamy', label: 'Dreamy', fields: { lighting: 'backlit haze', lens: 'soft focus, creamy bokeh', timing: 'slow motion', mood: 'dreamy', palette: 'muted pastels' } },
  { id: 'scifi', label: 'Sci-fi', fields: { style: 'sci-fi, hyperrealistic detail', lighting: 'neon glow, volumetric light rays', palette: 'icy whites and blues', audio: 'ambient drone' } },
  { id: 'vlog', label: 'Cozy vlog', fields: { style: 'handheld vlog style', lens: 'smartphone footage', lighting: 'soft window light', mood: 'cozy', audio: 'lo-fi hip-hop beat' } },
];

/** Video length hints (seconds) offered for a shot. Grok Imagine clips are typically 6 s (longer modes exist). */
export const DURATION_OPTIONS = [6, 10, 15];

/** Generation modes a shot can be planned for. */
export const SHOT_MODES = [
  { id: 'video', label: 'Text → video', hint: 'Prompt only' },
  { id: 'animate', label: 'Image → video', hint: 'Attach a reference image, describe the motion' },
  { id: 'image', label: 'Text → image', hint: 'Keyframes and reference images' },
];

/** Flat list of built-in chips for a field: [{label, text, group}]. */
export function presetItems(fieldKey) {
  return (PRESETS[fieldKey] || []).flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));
}

/**
 * Built-in groups plus the user's custom chips (as a trailing "Mine" group) for a field.
 * @param {string} fieldKey
 * @param {Array<{id:string, group:string, label:string, text:string}>} custom  libraryStore.presets
 */
export function presetGroupsFor(fieldKey, custom = []) {
  const mine = (Array.isArray(custom) ? custom : []).filter((p) => p && p.group === fieldKey && (p.text || p.label)).map((p) => ({ id: p.id, label: p.label || p.text, text: p.text || p.label, custom: true }));
  const groups = (PRESETS[fieldKey] || []).map((g) => ({ group: g.group, items: g.items }));
  if (mine.length) groups.push({ group: 'Mine', items: mine });
  return groups;
}

/** All preset texts for a field (used by the variations generator). */
export const presetTexts = (fieldKey, custom = []) => presetGroupsFor(fieldKey, custom).flatMap((g) => g.items.map((i) => i.text));
