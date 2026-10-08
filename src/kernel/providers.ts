export interface FetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;

export interface LlmRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

export interface LlmProvider {
  /** Host the provider talks to; checked against contract egress and data-class policy. */
  readonly host: string;
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/** The only doors to the outside world. Agents never see these directly, only broker tools. */
export interface Providers {
  readonly fetch: FetchLike;
  readonly llm?: LlmProvider;
}

export const nodeFetch: FetchLike = (url, init) => fetch(url, { signal: init.signal });
