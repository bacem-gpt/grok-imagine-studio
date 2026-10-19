// Clips area memo() helper (extension/studio/ui/media/memo.js): a memoized card skips re-rendering while its props are
// shallow-equal; its own hooks still re-render it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo, shallowDiffers } from '../../extension/studio/ui/media/memo.js';

test('shallowDiffers compares own keys by identity', () => {
  const api = {};
  assert.equal(shallowDiffers({ id: 'a', api, n: 1 }, { id: 'a', api, n: 1 }), false);
  assert.equal(shallowDiffers({ id: 'a', api }, { id: 'a', api: {} }), true, 'a new object is a change');
  assert.equal(shallowDiffers({ id: 'a' }, { id: 'a', flash: 0 }), true, 'an added key');
  assert.equal(shallowDiffers({ id: 'a', flash: 0 }, { id: 'a' }), true, 'a removed key');
  assert.equal(shallowDiffers({}, {}), false);
});

test('memo() installs a shouldComponentUpdate that skips equal props', () => {
  const Card = ({ id }) => id;
  const Memo = memo(Card);
  assert.equal(Memo.displayName, 'Memo(Card)');
  const instance = { props: { id: 'a', selected: false } };
  const vnode = Memo.call(instance, instance.props); // what Preact does on render (this = the component)
  assert.equal(vnode.type, Card, 'renders the wrapped component');
  assert.equal(instance.shouldComponentUpdate({ id: 'a', selected: false }), false);
  assert.equal(instance.shouldComponentUpdate({ id: 'a', selected: true }), true);
});
