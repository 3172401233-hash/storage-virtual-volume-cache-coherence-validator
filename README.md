# storage-virtual-volume-cache-coherence-validator

验证虚拟卷缓存映射、失效和故障切换。

> **本地模型说明**：本仓库中所有"卷"（volume）、"缓存节点"（cache node）、
> "块"（block）、"在途 I/O"和"fencing token"均为**纯内存中的本地数据模型**，
> 不连接任何真实存储、虚拟机或网络。验证器仅对输入的 JSON 风格对象做一致性
> 推演，用于验证缓存一致性规则本身。

## 问题背景

虚拟机从一个存储节点迁移到另一个节点后，源节点缓存中仍残留旧块；
旧虚拟机晚到的写入可能覆盖新节点上的数据。本验证器对每块计算可读位置，
并保证：

- 迁移完成前，同一块不会同时允许两个节点写入（单写者约束）；
- 携带旧 fencing token 的写入一律拒绝；
- `finalizing` 阶段存在未排空在途写时，迁移被阻断。

## 输入

```js
new CoherenceValidator({
  volumes: [{ id, blockCount, owner, fencingToken, versions, cached }],
  nodes: [{ id, restarted }],
  migrations: [{ volumeId, source, target, phase }],   // pre-copy | finalizing | completed
  invalidations: [{ node, volumeId, start, end, version }],
  inFlight: [{ node, volumeId, block, op: 'write', token }],
});
```

## 输出

`validate()` 返回：

- `blocks`：每块的可读位置（`readFrom` 节点 + `cache`/`store`）；
- `validCaches`：每个节点上仍然有效的缓存块；
- `invalidationRanges`：失效范围（连续块合并，含原因
  `invalidation-message` / `cache-restart` / `stale-version`）；
- `rejectedWrites`：被拒绝的在途写及原因；
- `migrationBlockers`：迁移阻断项（finalizing 未排空写、旧 token 晚写、
  双写者冲突）。

## 一致性规则

1. 迁移完成前权威节点为卷 owner（源），完成后为迁移 target；
2. 写准入要求 `token === 卷当前 fencingToken`，旧 token 拒绝；
3. `finalizing` 阶段暂停所有写，等待在途 I/O 排空；
4. 失效消息仅当缓存版本不新于消息版本时生效（晚到的旧消息不生效）；
5. 节点重启后其全部缓存视为失效，读回退到权威存储。

## 运行测试

需要 Node.js >= 24（开发验证使用 24.16.0）：

```sh
node --test
```

测试覆盖：迁移竞争、旧节点晚写、单写者约束、块失效、晚到的旧失效消息、
缓存重启、过期版本缓存。
