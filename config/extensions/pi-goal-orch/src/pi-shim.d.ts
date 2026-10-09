/**
 * Minimal ExtensionAPI stub so this package type-checks / loads via jiti
 * without requiring @earendil-works/pi-coding-agent to be installed locally.
 * At runtime Pi injects the real API.
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionUIContext {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    hasUI?: boolean;
  }

  export interface ExtensionContext {
    cwd: string;
    mode?: string;
    hasUI?: boolean;
    ui: ExtensionUIContext;
    sessionManager: {
      getBranch(): Array<{
        type: string;
        customType?: string;
        data?: unknown;
        message?: unknown;
      }>;
    };
    isIdle?: () => boolean;
    hasPendingMessages?: boolean | (() => boolean);
  }

  export type ExtensionCommandContext = ExtensionContext;

  export interface SlashCommandInfo {
    name: string;
    description?: string;
    /** Skill / prompt / extension provenance */
    source?: string;
    sourceInfo?: {
      source?: string;
      origin?: string;
      scope?: string;
      path?: string;
      filePath?: string;
    };
    path?: string;
    filePath?: string;
  }

  export interface ToolInfo {
    name: string;
    description?: string;
    parameters?: unknown;
    exposure?: string;
  }

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
      },
    ): void;

    registerTool(definition: {
      name: string;
      label?: string;
      description?: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: ExtensionContext,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details?: unknown;
      }>;
    }): void;

    on(
      event: string,
      handler: (event: any, ctx: ExtensionContext) => void | Promise<void>,
    ): () => void;

    sendUserMessage(
      content: string,
      options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
    ): void;

    appendEntry(customType: string, data: unknown): void;

    getCommands(): SlashCommandInfo[];
    getAllTools(): ToolInfo[];
  }
}
