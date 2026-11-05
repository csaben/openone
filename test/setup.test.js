const test = require('node:test');
const assert = require('node:assert');
const { parseSshConfig, defaultConfig } = require('../src/setup');

test('ssh config: concrete hosts only, with HostName and User', () => {
  const hosts = parseSshConfig([
    'Host *', '  ServerAliveInterval 30',
    'Host gpu-box gpu', '  HostName 10.0.0.5', '  User alice',
    'Host *.internal', '  User bob',
    'Host laptop', '  HostName laptop.lan',
  ].join('\n'));
  assert.deepEqual(hosts.map((h) => h.alias), ['gpu-box', 'gpu', 'laptop']);
  assert.equal(hosts[0].user, 'alice');
  assert.equal(hosts[2].hostname, 'laptop.lan');
});

test('default config: local psmux on, ssh hosts listed but off', () => {
  const cfg = defaultConfig({ hostname: 'DESKTOP-1', hasPsmux: true, sshHosts: [{ alias: 'gpu-box', user: 'alice', hostname: '' }] });
  assert.deepEqual(cfg.hosts.map((h) => [h.name, h.type, h.enabled]), [['desktop-1', 'psmux', undefined], ['gpu-box', 'ssh', false]]);
  assert.ok(new RegExp(cfg.hosts[1].wtTab).test('alice@gpu: ~'));
});

test('default config: local tmux on a Mac, named without .local', () => {
  const cfg = defaultConfig({ hostname: 'Clarks-MacBook.local', hasTmux: true, sshHosts: [] });
  assert.deepEqual(cfg.hosts, [{ name: 'clarks-macbook', type: 'tmux', pollMs: 1500, wtTab: 'tmux' }]);
});
