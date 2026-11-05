/**
 * Cortico 宿主契约的类型垫片。
 *
 * 扩展在宿主内通过模块钩子按 `cortico/<路径>` 解析框架源码，但独立开包（tsc、测试、
 * 扩展市场校验）没有这份源码。这里按 Core 的真实声明逐字镜像最小子集，**不得声明契约以外
 * 的成员**：一旦插件实现了框架并不存在的钩子（历史 bug：tick / onEvent），编译器必须报错。
 *
 * 镜像来源：
 * - `cortico/core/types.ts`：EventEnvelope / EventStoreReader / WorldHost / RunPhase / World / ToolDef
 * - `cortico/core/config-schema.ts`：ConfigGroup
 * - `cortico/world.ts`：WorldContext / WorldDefinition
 */
declare module 'cortico/core/types.ts' {
  export type EventOrigin = 'external' | 'internal';
  export type EventTag = string;
  export type Language = string;
  export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

  export interface EventEnvelope {
    cursor: number;
    run?: string;
    type: string;
    ts: string;
    source: string;
    origin: EventOrigin;
    tags?: readonly EventTag[];
    contextDelivery?: 'deliver' | 'archive-only';
    text: string;
    senderKey?: string;
    meta?: Record<string, unknown>;
    blobs?: unknown[];
    ephemeral?: true;
  }

  export interface EventRangeQuery {
    fromCursor?: number;
    toCursor?: number;
    fromTs?: string;
    toTs?: string;
    senderKey?: string;
    source?: string;
    origin?: EventOrigin;
    limit?: number;
  }

  export interface EventGrepQuery {
    keyword: string;
    context: number;
    senderKey?: string;
    source?: string;
    origin?: EventOrigin;
    fromTs?: string;
    toTs?: string;
    limit?: number;
  }

  export interface EventGrepHit {
    hitCursor: number;
    events: EventEnvelope[];
  }

  /** WorldHost.store 的只读视图；写事件走 pushEvent。 */
  export interface EventStoreReader {
    get(cursor: number): EventEnvelope | undefined;
    latestCursor(): number;
    range(q: EventRangeQuery): EventEnvelope[];
    around(cursor: number, before: number, after: number): EventEnvelope[];
    grep(q: EventGrepQuery): EventGrepHit[];
  }

  export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }

  export interface ToolOutcome {
    text: string;
    blobs?: unknown[];
  }

  /** 工具执行上下文；本插件只用到 signal，其余按需裁剪。 */
  export interface ToolCallContext {
    signal?: AbortSignal;
  }

  export interface ToolDef extends ToolSchema {
    tags: readonly ToolTag[];
    barrierAfter?: boolean;
    endsTurn?: boolean;
    interruptible?: boolean;
    handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolOutcome>;
  }

  export type DescribeText = string | { zh: string; en: string };

  export interface ToolDescribe extends ToolSchema {
    tags: readonly ToolTag[];
    summary?: DescribeText;
  }

  export interface EventDescribe {
    type: string;
    description: DescribeText;
  }

  export interface PromptVarDecl {
    name: string;
    description: string;
  }

  export interface PromptDocDecl {
    key: string;
    title: string;
    description: string;
    path: string;
    deploymentPath?: string;
    role?: 'envPrompt' | 'prefix';
    vars?: PromptVarDecl[];
  }

  export interface ConfigProperty {
    type: 'integer' | 'number' | 'boolean' | 'string' | 'array' | 'object';
    title: string;
    description?: string;
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
    enum?: string[];
    items?: { type: 'integer' | 'number'; minimum?: number; maximum?: number };
    minItems?: number;
    maxItems?: number;
    nullable?: boolean;
    'x-scale'?: number;
    'x-suffix'?: string;
    'x-hot'?: boolean;
    'x-warning'?: boolean;
    'x-options'?: string;
    'x-path'?: { kind: 'file' | 'directory'; extensions?: string[]; recommendedDir?: string };
    'x-download'?: { href: string; label?: string };
  }

  export interface ConfigGroupSchema {
    type: 'object';
    title: string;
    description?: string;
    properties: Record<string, ConfigProperty>;
  }

  export interface ConfigGroup {
    id: string;
    owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
    schema: ConfigGroupSchema;
  }

  export interface WorldPanelDecl {
    id: string;
    title: string;
    getMethods?: string[];
  }

  export interface WorldWebUiDecl {
    label?: string;
    badges?: Array<{ label: string; value: string | number; tone?: 'on' | 'off' | 'plain' }>;
    panels?: WorldPanelDecl[];
    invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
    promptDocs?: PromptDocDecl[];
    links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
    config?: ConfigGroup[];
  }

  export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  }

  export interface PushOptions {
    trigger?: 'flush' | 'debounce' | 'preempt' | 'interrupt' | 'piggyback';
    deliver?: boolean;
  }

  /** Core 提供给 World 的宿主接口；只镜像本插件实际使用的成员。 */
  export interface WorldHost {
    pushEvent(
      e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & {
        origin?: EventOrigin;
        blobs?: unknown[];
      },
      opts?: PushOptions
    ): Promise<EventEnvelope>;
    store: EventStoreReader;
    log: Logger;
  }

  /** 主 session 循环此刻在做什么；字段都是 Core 直接观察到的事实。 */
  export interface RunPhase {
    state: 'idle' | 'delivering' | 'model' | 'tools' | 'backoff' | 'handoff';
    round?: number;
    running: readonly string[];
    retryAt?: string;
    enteredAt: string;
  }

  /** World 的环境描述、事件和工具契约；成员与 Core 完全一致，禁止增删。 */
  export interface World {
    id: string;
    envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
    tools(): ToolDef[];
    webUi?(language?: Language): WorldWebUiDecl;
    start(host: WorldHost): Promise<void>;
    stop(): Promise<void>;
    onHandoffEnded?(): void;
    onTurnEnded?(): void;
    onEventsSettled?(events: readonly EventEnvelope[], outcome: 'delivered' | 'discarded'): void;
    onRunPhase?(phase: RunPhase): void;
  }
}

declare module 'cortico/world.ts' {
  import type { World, ConfigGroup, Language, EventDescribe, ToolDescribe } from 'cortico/core/types.ts';

  export type DeepPartial<T> = T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

  export interface WorldSection {
    enabled: boolean;
  }

  /** 装配层提供给 World 构造函数的上下文；只镜像本插件实际使用的成员。 */
  export interface WorldContext<S extends WorldSection = WorldSection> {
    readonly id: string;
    readonly cfg: S;
    readonly timezone: string;
    readonly botName: string;
    readonly botDir: string;
    readonly packageDir: string;
    readonly dataDir: string;
    readonly repoRoot: string;
    secret(name: string): string;
    persist(patch: DeepPartial<S>): void;
    restart(): Promise<void>;
  }

  export interface WorldDescribe {
    tools: readonly ToolDescribe[];
    events: readonly EventDescribe[];
  }

  export interface WorldDefinition<S extends WorldSection = WorldSection> {
    id: string;
    label: string;
    defaults(): S;
    preflight?(ctx: WorldContext<S>): void;
    configOptions?(kind: string, language: Language): Array<{ value: string; label: string }>;
    create(ctx: WorldContext<S>): World;
    describe?: WorldDescribe;
  }
}
