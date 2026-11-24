import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoherenceValidator, Phase } from '../src/coherence.js';

const baseVolumes = () => [
  {
    id: 'vol-1',
    blockCount: 4,
    owner: 'n1',
    fencingToken: 7,
    versions: { 0: 3, 1: 3, 2: 3, 3: 3 },
    cached: {
      n1: { 0: 3, 1: 3, 2: 3, 3: 3 },
      n2: { 0: 3, 1: 3 },
    },
  },
];

test('迁移竞争：finalizing 阶段在途写被拒绝并产生阻断项，读仍走源节点', () => {
  const v = new CoherenceValidator({
    volumes: baseVolumes(),
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    migrations: [{ volumeId: 'vol-1', source: 'n1', target: 'n2', phase: Phase.FINALIZING }],
    inFlight: [{ node: 'n1', volumeId: 'vol-1', block: 2, op: 'write', token: 7 }],
  });
  const out = v.validate();

  assert.equal(out.rejectedWrites.length, 1);
  assert.equal(out.rejectedWrites[0].reason, 'migration-finalizing');
  assert.ok(out.migrationBlockers.some((b) => b.type === 'in-flight-write-during-finalize'));
  // 迁移未完成，权威节点仍是源 n1
  assert.ok(out.blocks.every((b) => b.readFrom === 'n1'));
});

test('旧节点晚写：迁移完成后旧 fencing token 写入必须拒绝，读切到目标节点', () => {
  const volumes = baseVolumes();
  volumes[0].fencingToken = 8; // 迁移完成时 token 已提升
  const v = new CoherenceValidator({
    volumes,
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    migrations: [{ volumeId: 'vol-1', source: 'n1', target: 'n2', phase: Phase.COMPLETED }],
    inFlight: [
      { node: 'n1', volumeId: 'vol-1', block: 1, op: 'write', token: 7 }, // 旧节点晚到写
      { node: 'n2', volumeId: 'vol-1', block: 1, op: 'write', token: 8 }, // 新权威节点
    ],
  });
  const out = v.validate();

  assert.equal(out.rejectedWrites.length, 1);
  assert.equal(out.rejectedWrites[0].node, 'n1');
  assert.equal(out.rejectedWrites[0].reason, 'stale-fencing-token');
  assert.ok(out.migrationBlockers.some((b) => b.type === 'rejected-late-write'));
  assert.ok(!out.migrationBlockers.some((b) => b.type === 'dual-writer-detected'));
  assert.ok(out.blocks.every((b) => b.readFrom === 'n2'));
});

test('单写者约束：迁移完成前不允许两个节点同时写同一块', () => {
  const v = new CoherenceValidator({
    volumes: baseVolumes(),
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    migrations: [{ volumeId: 'vol-1', source: 'n1', target: 'n2', phase: Phase.PRE_COPY }],
    inFlight: [
      { node: 'n1', volumeId: 'vol-1', block: 0, op: 'write', token: 7 },
      { node: 'n2', volumeId: 'vol-1', block: 0, op: 'write', token: 7 },
    ],
  });
  const out = v.validate();

  const n2Write = out.rejectedWrites.find((w) => w.node === 'n2');
  assert.equal(n2Write.reason, 'not-authoritative-node');
  assert.ok(!out.migrationBlockers.some((b) => b.type === 'dual-writer-detected'));
});

test('块失效：失效消息使范围内缓存块失效，读回退到权威存储', () => {
  const v = new CoherenceValidator({
    volumes: baseVolumes(),
    nodes: [{ id: 'n1' }, { id: 'n2' }],
    invalidations: [{ node: 'n1', volumeId: 'vol-1', start: 1, end: 2, version: 3 }],
  });
  const out = v.validate();

  const range = out.invalidationRanges.find((r) => r.node === 'n1' && r.volumeId === 'vol-1');
  assert.deepEqual({ start: range.start, end: range.end }, { start: 1, end: 2 });
  assert.equal(range.reason, 'invalidation-message');

  const byBlock = new Map(out.blocks.map((b) => [b.block, b]));
  assert.equal(byBlock.get(0).source, 'cache');
  assert.equal(byBlock.get(1).source, 'store');
  assert.equal(byBlock.get(2).source, 'store');
  assert.equal(byBlock.get(3).source, 'cache');

  const n1Cache = out.validCaches.find((c) => c.node === 'n1');
  assert.deepEqual(n1Cache.blocks, [0, 3]);
});

test('晚到的旧失效消息不生效：缓存版本新于消息版本时保持有效', () => {
  const volumes = baseVolumes();
  volumes[0].versions = { 0: 5, 1: 5, 2: 5, 3: 5 };
  volumes[0].cached.n1 = { 0: 5, 1: 5, 2: 5, 3: 5 };
  volumes[0].cached.n2 = { 0: 5, 1: 5 };
  const v = new CoherenceValidator({
    volumes,
    nodes: [{ id: 'n1' }],
    invalidations: [{ node: 'n1', volumeId: 'vol-1', start: 0, end: 3, version: 3 }],
  });
  const out = v.validate();
  assert.equal(out.invalidationRanges.length, 0);
  assert.ok(out.blocks.every((b) => b.source === 'cache'));
});

test('缓存重启：节点重启后全部缓存失效，读回退到权威存储', () => {
  const v = new CoherenceValidator({
    volumes: baseVolumes(),
    nodes: [{ id: 'n1', restarted: true }, { id: 'n2' }],
  });
  const out = v.validate();

  const n1Cache = out.validCaches.find((c) => c.node === 'n1');
  assert.deepEqual(n1Cache.blocks, []);
  assert.ok(out.blocks.every((b) => b.source === 'store'));
  const range = out.invalidationRanges.find((r) => r.node === 'n1');
  assert.deepEqual({ start: range.start, end: range.end }, { start: 0, end: 3 });
  assert.equal(range.reason, 'cache-restart');
  // n2 未重启，缓存保持有效
  const n2Cache = out.validCaches.find((c) => c.node === 'n2');
  assert.deepEqual(n2Cache.blocks, [0, 1]);
});

test('过期版本缓存视为失效（stale-version）', () => {
  const volumes = baseVolumes();
  volumes[0].cached.n1 = { 0: 2, 1: 3 }; // 块 0 缓存版本落后
  const v = new CoherenceValidator({ volumes, nodes: [{ id: 'n1' }] });
  const out = v.validate();

  const byBlock = new Map(out.blocks.map((b) => [b.block, b]));
  assert.equal(byBlock.get(0).source, 'store');
  assert.equal(byBlock.get(1).source, 'cache');
  const range = out.invalidationRanges.find((r) => r.node === 'n1');
  assert.deepEqual({ start: range.start, end: range.end }, { start: 0, end: 0 });
  assert.equal(range.reason, 'stale-version');
});
