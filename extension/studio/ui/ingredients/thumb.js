// Ingredient image hooks and the thumbnail component used by the library grid, the picker and dialogs.
import { html, useState, useEffect } from '../../../vendor/preact-htm.mjs';
import { getIngredientThumb, getIngredientBlob } from '../../core/ingredients.js';
import { Icon, cx } from '../kit.js';

/** Changes only when the image itself changes (not on renames / tag edits): use as a reload key. */
export const imageVersion = (ing) => (ing ? `${ing.size}|${ing.width}x${ing.height}|${ing.mime}` : '');

/**
 * Thumbnail object URL (cached by core/ingredients.js, max 360 px). `version` (imageVersion(ing)) reloads it after
 * the image was replaced.
 */
export function useIngredientThumb(id, version) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    getIngredientThumb(id).then(
      (u) => alive && setUrl(u),
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
    };
  }, [id, version]);
  return url;
}

/** Full-resolution object URL owned by the calling component (revoked on change/unmount). */
export function useIngredientImage(id, version) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    let created = null;
    getIngredientBlob(id).then(
      (blob) => {
        if (!alive || !blob) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      },
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [id, version]);
  return url;
}

/** Square-ish thumbnail with a placeholder while loading. fit: 'cover' | 'contain'. */
export function IngredientThumb({ ing, fit = 'cover', class: klass = '', draggable = false, onDragStart }) {
  const url = useIngredientThumb(ing?.id, imageVersion(ing));
  return html`<div class=${cx('ing-thumb', `is-${fit}`, klass)}>
    ${url
      ? html`<img src=${url} alt=${ing?.name || ''} draggable=${draggable} onDragStart=${onDragStart} loading="lazy" decoding="async" />`
      : html`<span class="ing-thumb-ph"><${Icon} name="image" size=${18} /></span>`}
  </div>`;
}
