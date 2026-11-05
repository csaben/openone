const test = require('node:test');
const assert = require('node:assert');
const { posts } = require('../src/xsync');

const tweet = (id, extra = {}) => ({
  __typename: 'Tweet', rest_id: id,
  core: { user_results: { result: { rest_id: 'u1', core: { name: 'Some One', screen_name: 'someone' }, avatar: { image_url: 'https://pbs/a.jpg' } } } },
  legacy: { full_text: `post ${id} https://t.co/x`, created_at: 'Mon Oct 19 03:08:00 +0000 2026', favorite_count: 5, entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com', display_url: 'example.com' }] } },
  ...extra,
});

test("a timeline response's posts come out in order, in the shape saved posts keeps", () => {
  const body = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ entries: [
    { entryId: 'tweet-2', content: { itemContent: { tweet_results: { result: tweet('2', { quoted_status_result: { result: tweet('9') } }) } } } },
    { entryId: 'tweet-1', content: { itemContent: { tweet_results: { result: { __typename: 'TweetWithVisibilityResults', tweet: tweet('1') } } } } },
    { entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: 'abc' } },
  ] }] } } } };
  const got = posts(body);
  assert.deepStrictEqual(got.map((t) => t.id), ['2', '1']); // the quoted post stays inside its post
  assert.strictEqual(got[0].handle, 'someone');
  assert.strictEqual(got[0].quoted.id, '9');
  assert.deepStrictEqual(got[1].urls, [{ short: 'https://t.co/x', url: 'https://example.com', display: 'example.com' }]);
  assert.strictEqual(got[1].counts.likes, 5);
});
