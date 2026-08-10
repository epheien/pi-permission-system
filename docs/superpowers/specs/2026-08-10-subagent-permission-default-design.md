# 设计:subagentPermission —— 「非主 agent」默认权限层

日期:2026-08-10
状态:待用户审阅(brainstorming 产物,实现前转 writing-plans)

## 1. 问题

用户需要:主 agent 会话遵循现有放行策略(`write`/`edit` 为 `allow`),而**任何** subagent 会话(名字随意、临时开出、无法逐一枚举)默认要求 `write`/`edit` 走 `ask`,除非该特定 agent 的 frontmatter 明确覆盖。

身份枚举不可行(用户原话:"没法确定 subagent 的标识,因为可以随便开的")。因此判定依据必须是**会话上下文**(是否 subagent),而不是**身份**(哪个 agent)。

## 2. 用户确认的模型(优先级,高 → 低)

```
specify(per-agent frontmatter)  >  not main(subagent 默认层)  >  main(现有 global/project 配置)
```

- **specify** 最高:某 subagent 自己的 `permission:` frontmatter 压过一切;
- **not main** 居中:凡"非主 agent"会话默认套这一层;
- **main** 最底:主 agent 会话完全不注入该层,行为与现状一致。

用户已确认:
- **yolo 保持全局 bypass,不写任何特殊代码**(选项 B):只要最终判定非 `deny`,yolo 开启即不询问,任何 agent 都一样;想 subagent 弹窗时用户手动关 yolo 即可。
- 不配置 `subagentPermission` 时行为不变(向后兼容)。

## 3. 正确性前置:检测修复(必须)

### 现状(已实测)

`isSubagentExecutionContext()`(`src/authority/subagent-context.ts`)按序检查:
1. 进程内 registry(`@gotgenes/pi-subagents` 之类注册子会话);
2. `SUBAGENT_ENV_HINT_KEYS`(`src/authority/permission-forwarding.ts`)—— 覆盖 pi-agent-router / nicobailon / HazAT 的多个键;
3. session 目录落在 subagent 根下的文件系统启发式。

**缺口**:用户实际使用的 `epheien/pi-subagents` 对子会话**只设 `PI_SUBAGENT_PARENT_SESSION`**(源码 `src/extension/index.ts` 在子会话设置、闭幕删除),而该键**不在** hint 列表里(仅被转发解析 `SUBAGENT_PARENT_SESSION_ENV_CANDIDATES` 使用)。实测当前会话(一个真 subagent)三个 hint 键全缺、不走 registry、session 目录不在 subagent 根下 —— **现有检测判定不出,会把它误归为"主 agent"→ fail-open**。

### 修复

在 `SUBAGENT_ENV_HINT_KEYS` 追加 `PI_SUBAGENT_PARENT_SESSION`,存在(非空)即视为 subagent。主会话不设该键,故「主 agent」= 四条信号全不命中,语义恰好为用户想要的补集。

> 注:`PI_SUBAGENT_PARENT_SESSION=""`(空串)保持不判定(现有 `trim()` 守卫),与转发解析共用同一键,行为一致。

## 4. 配置字段

### 形状

在 `src/config-schema.ts` 的 `unifiedConfigSchema` 增加可选顶层字段:

```ts
subagentPermission: permissionSchema.optional()
```

- 复用现成的 flat permission 地图 schema(工具名 / `bash` / `mcp` / `skill` / `external_directory` / `special` / 万用 `"*"`),无新类型。
- 全局与项目配置文件都可设置,项目级 `subagentPermission` 覆盖全局级(deep-shallow merge,与 `permission` 同语义)。

### 贯通路径

- `ScopeConfig`(`src/types.ts`)增加 `subagentPermission?: FlatPermissionConfig`;
- `PolicyLoader.loadGlobalConfig()` / `loadProjectConfig()` 从 `loadUnifiedConfig` 结果 surface `config.subagentPermission`(schema 增加后自动可读);
- `getCacheStamp` 已含全局/项目配置文件时间戳 → 文件变更自动失效缓存,无需新逻辑。

> **遵循包内不变量**:该字段确实在运行时被读(`PermissionManager.resolvePermissions`),不会成为"声明了但没读"的维护陷阱。
> `PermissionSystemExtensionConfig`(`extension-config.ts`)不需要携带它 —— `permission` 本身也只在 manager 侧经 loader 读取,不进 runtime config。

## 5. 合成与优先级

### RuleOrigin

`src/rule.ts` 的 `RuleOrigin` 增加 `"subagent"`。同步更新 `docs/architecture/architecture.md` 内联的 `Rule`/`RuleOrigin` 列示(SKILL 规定)。

### PermissionManager

- 增加构造选项 `isSubagent?: () => boolean`(镜像现有 `isYoloEnabled: () => boolean` 的惰性读取模式)。
- `resolvePermissions(agentName)`:
  - 将 `this.isSubagent()` 结果并入缓存 key(与 agentName/文件 stamp 同层);
  - 为 true 时计算 `subagentPermission = mergeFlatPermissions(global.subagentPermission ?? {}, project.subagentPermission ?? {})`(project 覆盖 global);
  - 非空时在 `mergeScopesWithOrigins` 中于 project 与 agent 之间注入:

    ```ts
    const scopes = [
      ["global", globalConfig],
      ["project", projectConfig],
      ...(isSubagent ? [["subagent", { permission: subagentPermission }] as const] : []),
      ["agent", agentConfig],
      ["project-agent", projectAgentConfig],
    ];
    ```

- 结果链条恰为用户模型:`main` → `not main` → `specify`。

### 万用兜底 `"*"`

`resolvePermissions` 从**合并后**的 `mergedPermission["*"]` 提取 universal fallback,故 `subagentPermission["*"]` 会覆盖 subagent 会话的兜底(不影响主 agent)。文档中说明。

### 显示与审计

`getComposedConfigRules()` / `/permission-system show` 会以 `subagent` origin 标注该层规则 —— 来源可审。

## 6. 合成接线(composition root)

`src/index.ts`:
- 复用既有 `subagentDetection`(`new SubagentDetection(...)`,第 62 行),它已注入 `AuthorizerSelection` / `ForwardingManager` / `PermissionServiceLifecycle`。
- manager 的 `isSubagent` 由工厂作用域内的可变 `let` 提供(与 `configStore` 前向声明/闭包同模式);在 `PermissionServiceLifecycle.activate()`(session_start,已有 ctx 且已做子会话判定 #302,拥有 `subagentDetection`)里计算 `isSubagentContext = subagentDetection.isSubagent(ctx)`,写回该 `let`,供 manager 惰性读取。

## 7. yolo:零改动

保持全局 `rewriteAsksToYolo` 语义:非 deny 一律放行(含 subagent 的 ask)。需求方已确认(选项 B):不为此功能编写任何 yolo 特殊分支。

## 8. fail-closed / 错误交互(不变)

- 既有"非全局 scope 无效 → `floorAllowsToAsk`"压 `allow→ask` 在合成后照常生效,subagent 层也受其约束。
- 无 `subagentPermission` 配置 → 不注入层 → 完全向后兼容。

## 9. 测试

- **manager**(manager-harness):
  - `isSubagent() === true` 注入 subagent 层、`false` 不注入;
  - 链条优先级 `main < subagent < agent-frontmatter`(agent frontmatter 的 `write: allow` 可压过 subagent 层的 `ask`);
  - 项目级 `subagentPermission` 覆盖全局级;
  - `subagentPermission["*"]` 覆盖 subagent 兜底、主 agent 不受影响;
  - 缓存 key 随 subagent 标志变化失效。
- **检测**(subagent-context):`PI_SUBAGENT_PARENT_SESSION` 存在 → 判为 subagent;空串 → 不判。
- **config**:schema 生成 parity 测试自动覆盖;`subagentPermission` 校验/容忍。
- **composition-root**:`isSubagent` thunk 是否正确接到 session_start 检测;subagent 会话通过 service 的 `checkPermission` 反映该层策略。

## 10. 文档对齐

- `pnpm run gen:schema` 再生成 `schemas/permissions.schema.json`;
- `config/config.example.json` 加带注释示例;
- `docs/configuration.md` 新增小节(链条、作用域、yolo 行为、`"*"` 兜底);
- `README.md` 简要提及;
- `docs/architecture/architecture.md` 内联 `RuleOrigin` 加 `"subagent"`。

## 11. 范围内 / 范围外

范围内:检测修复 + `subagentPermission` 配置层 + 合成 + 文档/测试。
范围外:yolo 特殊化(否决);完整替换式双配置(否决);per-agent yolo 覆盖;registry/转发相关改动。

## 12. 实施后修正:serving-node 裁决缺口(实机复现,2026-08-10)

### 缺口(用户实机复现)

用户实测:仅配 `subagentPermission = { write: "ask", edit: "ask" }`(主 `permission` 仍 `allow`)**不弹窗**;把 `permission.edit` 改成 `ask` 才弹窗。

根因:manager 层确实把子会话的 `edit` 算出 `ask`(用真实 config 复现已证明),但子会话无 UI,**`ask` 转发给父会话**后,父会话按 ADR 0008(serving-node decides)用**父会话自己的规则集**重裁决 —— 父会话是主会话、不含 subagent 层,`edit` 落到主 map 的 `allow` → `forwarded_permission.auto_approved` 静默放行。设计文档只写了组合侧,漏了"裁决发生在父会话、且父会话不带子会话层"这一环。

### 修复

1. **wire**:`ForwardedAccessIntent` 增加 `requesterIsSubagent?: boolean`(child-fixed 身份,只会**加严**、不会放松)。
2. **child**:`ParentAuthorizer.buildForwardedRequest` 盖 `requesterIsSubagent: true`(selectAuthorizer 只对无 UI 的 subagent 构造它,内建不变量)。
3. **serving**:父会话护栏对 `requesterIsSubagent === true` 的请求,在裁决链里叠加 **requester 的 `subagentPermission` 默认层**(main → requester subagentPermission → requester frontmatter),与子会话自身完全对称。实现:`PermissionManager.check(..., { requesterIsSubagent })` → `resolvePermissions(agentName, subagentOverride)`;`PermissionResolver.resolveForForwarded`;组合根 `servingPolicy.resolve` 透传。
4. **读取容错**:`asForwardedAccessIntent` 仅接受显式 `true`,其余(缺省/乱值)→ `false`(视为普通请求方)。
5. **yolo 不变**:父会话 yolo 开着时依旧静默(用户选项 B)。

### 实机效果(修复后,reload 生效)

默认非 yolo 会话:子会话 `write`/`edit` → 父会话裁决为 `ask` → 弹窗;主会话仍 `allow`;yolo 开着全静默。
