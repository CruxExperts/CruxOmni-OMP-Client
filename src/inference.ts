import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";

export const OMNIROUTE_GUARDED_API = "omniroute-native-guard" as Api;

export interface InferenceBinding {
  endpoint: string;
  credential: string;
  generation: number;
}

export interface BoundInferenceOptions {
  expectedEndpoint: string;
  expectedGeneration: number;
  modelApis: ReadonlyMap<string, "openai-responses" | "openai-completions">;
  currentBinding(): InferenceBinding | undefined;
  stopped(): boolean;
}

function endpointApiRoot(endpoint: string): URL {
  return new URL(`${endpoint.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/`);
}

export function createSingleDispatchFetch(endpoint: string, baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  const root = endpointApiRoot(endpoint);
  let attempts = 0;
  const guarded: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    attempts += 1;
    if (attempts > 1) throw Object.assign(new Error("inference replay suppressed"), { code: "inference-replay-suppressed" });
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      throw Object.assign(new Error("inference target changed"), { code: "inference-target-mismatch" });
    }
    const response = await baseFetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw Object.assign(new Error("inference redirect rejected"), { code: "inference-redirect" });
    }
    return response;
  }, { preconnect: baseFetch.preconnect });
  return guarded;
}

export function createBoundInferenceStream(options: BoundInferenceOptions) {
  return (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    const binding = options.currentBinding();
    if (options.stopped() || !binding || binding.endpoint !== options.expectedEndpoint || binding.generation !== options.expectedGeneration) {
      throw Object.assign(new Error("OmniRoute inference binding is no longer active"), { code: "inference-binding-invalid" });
    }
    if (streamOptions?.signal?.aborted) throw Object.assign(new Error("inference aborted"), { code: "aborted" });
    const nativeApi = options.modelApis.get(model.id);
    if (!nativeApi) throw Object.assign(new Error("model is not in the validated live catalog"), { code: "inference-model-invalid" });
    const nativeModel = {
      ...model,
      api: nativeApi,
      baseUrl: endpointApiRoot(binding.endpoint).toString().replace(/\/$/, ""),
    } as Model<"openai-responses"> | Model<"openai-completions">;
    const guardedOptions = {
      ...streamOptions,
      apiKey: binding.credential,
      fetch: createSingleDispatchFetch(binding.endpoint, streamOptions?.fetch ?? globalThis.fetch),
      statefulResponses: false,
    };
    return nativeApi === "openai-responses"
      ? streamOpenAIResponses(nativeModel as Model<"openai-responses">, context, guardedOptions)
      : streamOpenAICompletions(nativeModel as Model<"openai-completions">, context, guardedOptions);
  };
}
