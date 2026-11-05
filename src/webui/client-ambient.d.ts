/**
 * 浏览器侧面板契约的类型垫片。
 *
 * 面板 bundle 由 esbuild 打进浏览器，宿主内核的 `cortico/web/shared/client-panel.ts` 只提供类型，
 * 不参与运行；独立开包时 tsc 没有这份源码，因此这里镜像本插件用到的最小子集。
 * 与 Core 的声明保持一致，不额外发明成员。
 */
declare module 'cortico/web/shared/client-panel.ts' {
  export interface WebUiDisposable {
    dispose(): void;
  }

  export interface WebUiPanelContext {
    readonly pageId: string;
    readonly panelId: string;
    readonly language: string;
    readonly root: HTMLElement;
    readonly signal: AbortSignal;
    invoke<T = unknown>(method: string, args?: unknown[]): Promise<T>;
    ui: WebUiKit;
  }

  export interface WebUiKit {
    h<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className?: string,
      text?: string
    ): HTMLElementTagNameMap[K];
    input(opts?: { placeholder?: string; value?: string; onInput?: (value: string) => void }): HTMLInputElement;
    button(
      label: string,
      opts?: { size?: 'sm' | 'md'; tone?: 'primary' | 'plain'; variant?: string; onClick?: () => void | Promise<void> }
    ): HTMLButtonElement;
    pill(text: string, tone?: 'on' | 'off' | 'plain'): HTMLElement;
    msgline(text?: string, bad?: boolean): HTMLDivElement;
    placeholder(text: string): HTMLDivElement;
    rowbar(...children: HTMLElement[]): HTMLElement;
    segmented(
      items: Array<{ value: string; label: string }>,
      opts: { value: string; onChange: (value: string) => void }
    ): { el: HTMLElement; setValue(value: string): void };
    select?(opts: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void }): HTMLSelectElement;
  }

  export interface WebUiPanel {
    mount(ctx: WebUiPanelContext): void | Promise<void>;
    unmount?(): void | Promise<void>;
  }

  export interface WebUiClientBundle {
    panels: Record<string, WebUiPanel>;
  }
}

declare module '*.css' {
  const content: string;
  export default content;
}
