export const Phase = Object.freeze({
  PRE_COPY: 'pre-copy',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
});

const REASON = Object.freeze({
  MESSAGE: 'invalidation-message',
  RESTART: 'cache-restart',
  STALE: 'stale-version',
});

function toBlockMap(obj = {}) {
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
}

/**
 * 本地缓存一致性验证器。
 *
 * 输入（全部为本地内存模型，不涉及真实存储）：
 * - volumes: 卷映射 [{ id, blockCount, owner, fencingToken, versions, cached }]
 * - nodes: 缓存节点 [{ id, restarted }]
 * - migrations: 迁移 [{ volumeId, source, target, phase }]
 * - invalidations: 失效消息 [{ node, volumeId, start, end, version }]
 * - inFlight: 在途 I/O [{ node, volumeId, block, op, token }]
 */
export class CoherenceValidator {
  constructor({ volumes = [], nodes = [], migrations = [], invalidations = [], inFlight = [] }) {
    this.volumes = new Map();
    for (const v of volumes) {
      this.volumes.set(v.id, {
        id: v.id,
        blockCount: v.blockCount,
        owner: v.owner,
        fencingToken: v.fencingToken ?? 0,
        versions: toBlockMap(v.versions),
        caches: new Map(
          Object.entries(v.cached ?? {}).map(([nodeId, blocks]) => [nodeId, toBlockMap(blocks)]),
        ),
      });
    }
    this.nodes = new Map(nodes.map((n) => [n.id, { restarted: false, ...n }]));
    this.migrations = new Map(migrations.map((m) => [m.volumeId, m]));
    this.invalidations = invalidations;
    this.inFlight = inFlight;
  }

  /** 迁移完成前权威节点为 owner（源），完成后为 target。 */
  authoritativeNode(volumeId) {
    const migration = this.migrations.get(volumeId);
    if (migration && migration.phase === Phase.COMPLETED) return migration.target;
    return this.volumes.get(volumeId).owner;
  }

  /**
   * 写准入判定。规则：
   * 1. fencing token 小于卷当前 token —— 旧 token 写入，拒绝；
   * 2. token 大于当前 token —— 未知 token，拒绝；
   * 3. 迁移 finalizing 阶段 —— 所有写暂停（等待在途 I/O 排空），拒绝；
   * 4. 非权威节点 —— 拒绝（保证同一块不会同时有两个可写节点）。
   */
  admitWrite({ volumeId, node, token }) {
    const volume = this.volumes.get(volumeId);
    if (!volume) return { admitted: false, reason: 'unknown-volume' };
    if (token < volume.fencingToken) return { admitted: false, reason: 'stale-fencing-token' };
    if (token > volume.fencingToken) return { admitted: false, reason: 'token-mismatch' };
    const migration = this.migrations.get(volumeId);
    if (migration && migration.phase === Phase.FINALIZING) {
      return { admitted: false, reason: 'migration-finalizing' };
    }
    if (node !== this.authoritativeNode(volumeId)) {
      return { admitted: false, reason: 'not-authoritative-node' };
    }
    return { admitted: true, reason: null };
  }

  /** 计算每个节点上每卷的失效块（含原因）。 */
  computeInvalidBlocks() {
    const invalid = new Map(); // `${node}|${volumeId}` -> Map(block -> reason)
    const key = (node, volumeId) => `${node}|${volumeId}`;
    const mark = (node, volumeId, block, reason) => {
      const k = key(node, volumeId);
      if (!invalid.has(k)) invalid.set(k, new Map());
      invalid.get(k).set(block, reason);
    };

    for (const [volumeId, volume] of this.volumes) {
      for (const [node, blocks] of volume.caches) {
        const nodeInfo = this.nodes.get(node);
        for (const [block, version] of blocks) {
          if (nodeInfo?.restarted) {
            mark(node, volumeId, block, REASON.RESTART);
          } else if (version < (volume.versions.get(block) ?? 0)) {
            mark(node, volumeId, block, REASON.STALE);
          }
        }
      }
    }

    for (const msg of this.invalidations) {
      const volume = this.volumes.get(msg.volumeId);
      const cached = volume?.caches.get(msg.node);
      if (!cached) continue;
      for (let block = msg.start; block <= msg.end; block += 1) {
        const version = cached.get(block);
        // 仅当缓存版本不新于失效消息版本时才失效（晚到的旧消息不生效）
        if (version !== undefined && version <= msg.version) {
          mark(msg.node, msg.volumeId, block, REASON.MESSAGE);
        }
      }
    }
    return invalid;
  }

  validate() {
    const invalid = this.computeInvalidBlocks();
    const invalidAt = (node, volumeId, block) =>
      invalid.get(`${node}|${volumeId}`)?.has(block) ?? false;

    // 1. 每块可读位置
    const blocks = [];
    for (const [volumeId, volume] of this.volumes) {
      const readFrom = this.authoritativeNode(volumeId);
      for (let block = 0; block < volume.blockCount; block += 1) {
        const cachedVersion = volume.caches.get(readFrom)?.get(block);
        const latest = volume.versions.get(block) ?? 0;
        const cacheValid =
          cachedVersion !== undefined &&
          cachedVersion === latest &&
          !invalidAt(readFrom, volumeId, block);
        blocks.push({
          volumeId,
          block,
          readFrom,
          source: cacheValid ? 'cache' : 'store',
          version: latest,
        });
      }
    }

    // 2. 有效缓存
    const validCaches = [];
    for (const [volumeId, volume] of this.volumes) {
      for (const [node, cached] of volume.caches) {
        const valid = [...cached.entries()]
          .filter(
            ([block, version]) =>
              version === (volume.versions.get(block) ?? 0) &&
              !invalidAt(node, volumeId, block),
          )
          .map(([block]) => block)
          .sort((a, b) => a - b);
        validCaches.push({ node, volumeId, blocks: valid });
      }
    }

    // 3. 失效范围（连续块合并）
    const invalidationRanges = [];
    for (const [k, blockReasons] of invalid) {
      const sep = k.indexOf('|');
      const node = k.slice(0, sep);
      const volumeId = k.slice(sep + 1);
      const sorted = [...blockReasons.keys()].sort((a, b) => a - b);
      let start = null;
      let prev = null;
      for (const block of sorted) {
        if (start === null) {
          start = block;
        } else if (block !== prev + 1) {
          invalidationRanges.push({ node, volumeId, start, end: prev, reason: blockReasons.get(prev) });
          start = block;
        }
        prev = block;
      }
      if (start !== null) {
        invalidationRanges.push({ node, volumeId, start, end: prev, reason: blockReasons.get(prev) });
      }
    }

    // 4. 在途写准入 + 迁移阻断项
    const rejectedWrites = [];
    const migrationBlockers = [];
    const admittedWriters = new Map(); // `${volumeId}|${block}` -> node
    for (const io of this.inFlight) {
      if (io.op !== 'write') continue;
      const decision = this.admitWrite(io);
      const volume = this.volumes.get(io.volumeId);
      if (decision.admitted) {
        const k = `${io.volumeId}|${io.block}`;
        if (admittedWriters.has(k) && admittedWriters.get(k) !== io.node) {
          migrationBlockers.push({
            type: 'dual-writer-detected',
            volumeId: io.volumeId,
            block: io.block,
            nodes: [admittedWriters.get(k), io.node],
            detail: '同一块被两个节点同时准入写入，违反单写者约束',
          });
        }
        admittedWriters.set(k, io.node);
      } else {
        rejectedWrites.push({ ...io, reason: decision.reason });
        if (decision.reason === 'migration-finalizing') {
          migrationBlockers.push({
            type: 'in-flight-write-during-finalize',
            volumeId: io.volumeId,
            node: io.node,
            block: io.block,
            detail: 'finalizing 阶段存在未排空在途写，迁移不能完成',
          });
        } else if (decision.reason === 'stale-fencing-token') {
          migrationBlockers.push({
            type: 'rejected-late-write',
            volumeId: io.volumeId,
            node: io.node,
            block: io.block,
            detail: `旧节点晚到写携带过期 fencing token（${io.token} < ${volume?.fencingToken}），已拒绝`,
          });
        }
      }
    }

    return { blocks, validCaches, invalidationRanges, rejectedWrites, migrationBlockers };
  }
}
