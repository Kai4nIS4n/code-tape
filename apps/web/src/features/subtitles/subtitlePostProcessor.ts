import type {
  SubtitleCorrectionResult,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitlePostProcessorInput,
} from "./types";
import { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
import { loadTransformersPipeline } from "./transformersLoader";
import {
  POSTPROCESSOR_CHUNK_SEGMENTS,
  buildSubtitlePostProcessorMessages,
  chunkSubtitleTrack,
  constrainCorrectionToTrack,
  estimateMaxNewTokens,
  extractSubtitleCorrectionResult,
  isRecoverableJsonOutputError,
  recoverSubtitleCorrectionResult,
  type SubtitlePostProcessorMessage,
} from "./subtitlePostProcessorShared";

export { DEFAULT_POSTPROCESSOR_MODEL } from "./subtitlePostProcessorConfig";
export {
  buildSubtitlePostProcessorMessages,
  buildSubtitlePostProcessorPrompt,
  extractSubtitleCorrectionResult,
} from "./subtitlePostProcessorShared";

const SMOLLM_CHAT_TEMPLATE = `{% for message in messages %}{% if loop.first and messages[0]['role'] != 'system' %}{{ '<|im_start|>system
You are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>
' }}{% endif %}{{'<|im_start|>' + message['role'] + '
' + message['content'] + '<|im_end|>' + '
'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant
' }}{% endif %}`;

type TextGenerationPipelineOptions = {
  device: "webgpu" | "wasm";
  dtype: "q4" | "q4f16" | "q8";
};

type TextGenerationPipeline = ((
  prompt: string | SubtitlePostProcessorMessage[],
  options: {
    max_new_tokens: number;
    do_sample: boolean;
    repetition_penalty: number;
    return_full_text: boolean;
    chat_template?: string;
  },
) => Promise<unknown>) & {
  tokenizer?: ((text: string) => {
    input_ids: { dims?: number[]; data?: ArrayLike<number | bigint> } | number[][] | number[];
  }) & { encode?: (text: string) => number[] };
  model?: { config?: { max_position_embeddings?: number } };
};

type PipelineFactory = (
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
) => Promise<TextGenerationPipeline>;

export const DEFAULT_POSTPROCESSOR_RUNTIME_CONFIG: TextGenerationPipelineOptions = {
  device: "wasm",
  dtype: "q8",
};

export type HuggingFaceSubtitlePostProcessorOptions = {
  model?: string;
  pipelineFactory?: PipelineFactory;
};

export function createHuggingFaceSubtitlePostProcessor(
  options: HuggingFaceSubtitlePostProcessorOptions = {},
): SubtitlePostProcessor {
  const model = options.model ?? DEFAULT_POSTPROCESSOR_MODEL;
  // Keep the cold-start path to the single validated browser target; final load errors are wrapped below.
  const pipelineOptions: TextGenerationPipelineOptions[] = [DEFAULT_POSTPROCESSOR_RUNTIME_CONFIG];
  let pipelinePromise: Promise<TextGenerationPipeline> | null = null;
  const getPipeline = () => {
    if (!pipelinePromise) {
      pipelinePromise = loadPipelineWithFallback({
        model,
        pipelineFactory: options.pipelineFactory,
        pipelineOptions,
      }).catch((error: unknown) => {
        pipelinePromise = null;
        throw error;
      });
    }
    return pipelinePromise;
  };

  return {
    async warmUp() {
      await getPipeline();
    },
    async process(input) {
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const pipeline = await getPipeline();
      if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      return processSubtitleTrack({
        input: { ...input, strictValidation: input.strictValidation ?? true },
        model,
        pipeline,
      });
    },
  };
}

async function processSubtitleTrack({
  input,
  model,
  pipeline,
}: {
  input: SubtitlePostProcessorInput;
  model: string;
  pipeline: TextGenerationPipeline;
}): Promise<SubtitleCorrectionResult> {
  if (input.track.segments.length <= POSTPROCESSOR_CHUNK_SEGMENTS) {
    return processSubtitleTrackChunk({ input, model, pipeline });
  }

  const chunks = chunkSubtitleTrack(input.track, POSTPROCESSOR_CHUNK_SEGMENTS);
  const merged: SubtitleCorrectionResult = { segments: [], chapters: [] };
  for (const chunk of chunks) {
    if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
    const result = await processSubtitleTrackChunk({
      input: { ...input, track: chunk },
      model,
      pipeline,
    });
    merged.segments.push(...result.segments);
    merged.chapters?.push(...(result.chapters ?? []));
    if (result.validationWarnings?.length)
      (merged.validationWarnings ??= []).push(...result.validationWarnings);
  }
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  return constrainCorrectionToTrack(merged, input.track, input.strictValidation);
}

async function processSubtitleTrackChunk({
  input,
  model,
  pipeline,
}: {
  input: SubtitlePostProcessorInput;
  model: string;
  pipeline: TextGenerationPipeline;
}): Promise<SubtitleCorrectionResult> {
  const maxNewTokens = estimateMaxNewTokens(input.track);
  const budgetedInput = input.strictValidation
    ? fitContextToTokenizer(input, pipeline, maxNewTokens)
    : input;
  if (!budgetedInput) {
    if (input.track.segments.length <= 1)
      throw new Error("字幕段超出模型输入预算，请缩短该段字幕后重试。");
    const split = chunkSubtitleTrack(input.track, Math.ceil(input.track.segments.length / 2));
    const merged: SubtitleCorrectionResult = { segments: [], chapters: [] };
    for (const track of split) {
      const result = await processSubtitleTrackChunk({
        input: { ...input, track },
        model,
        pipeline,
      });
      merged.segments.push(...result.segments);
      merged.chapters?.push(...(result.chapters ?? []));
      if (result.validationWarnings?.length)
        (merged.validationWarnings ??= []).push(...result.validationWarnings);
    }
    return merged;
  }
  const output = await pipeline(buildSubtitlePostProcessorMessages(budgetedInput), {
    max_new_tokens: maxNewTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    return_full_text: false,
    ...buildChatTemplateOption(model),
  });
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const generatedText = readGeneratedText(output);
  try {
    return constrainCorrectionToTrack(
      extractSubtitleCorrectionResult(generatedText, input.strictValidation),
      input.track,
      input.strictValidation,
    );
  } catch (error) {
    if (!isRecoverableJsonOutputError(error)) throw error;
    const recovered = input.strictValidation
      ? null
      : recoverSubtitleCorrectionResult(generatedText, input.track);
    if (recovered) return recovered;
  }
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const retryMessages = buildSubtitlePostProcessorMessages(budgetedInput, {
    previousOutput: generatedText,
  });
  // Repair context also consumes tokens; fall back to the original prompt if
  // adding an excerpt would exceed the same model window.
  const retryOutput = await pipeline(
    fitsTokenizer(retryMessages, pipeline, maxNewTokens)
      ? retryMessages
      : buildSubtitlePostProcessorMessages(budgetedInput),
    {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      repetition_penalty: 1.05,
      return_full_text: false,
      ...buildChatTemplateOption(model),
    },
  );
  if (input.signal?.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
  const retryGeneratedText = readGeneratedText(retryOutput);
  try {
    return constrainCorrectionToTrack(
      extractSubtitleCorrectionResult(retryGeneratedText, input.strictValidation),
      input.track,
      input.strictValidation,
    );
  } catch (error) {
    if (!isRecoverableJsonOutputError(error)) throw error;
    const recovered = input.strictValidation
      ? null
      : recoverSubtitleCorrectionResult(retryGeneratedText, input.track);
    if (recovered) return recovered;
    throw error;
  }
}

function fitsTokenizer(
  messages: SubtitlePostProcessorMessage[],
  pipeline: TextGenerationPipeline,
  outputTokens: number,
): boolean {
  const text = messages.map((message) => message.content).join("\n");
  const ids = pipeline.tokenizer?.encode?.(text) ?? pipeline.tokenizer?.(text).input_ids;
  const conservativeEstimate =
    Math.ceil(text.replace(/[^\p{ASCII}]/gu, "").length / 3) +
    (text.match(/[^\p{ASCII}]/gu)?.length ?? 0);
  const count =
    ids === undefined
      ? conservativeEstimate
      : Array.isArray(ids)
        ? Array.isArray(ids[0])
          ? ids[0].length
          : ids.length
        : (ids.dims?.at(-1) ?? ids.data?.length ?? conservativeEstimate);
  const window = pipeline.model?.config?.max_position_embeddings ?? 4096;
  return count + outputTokens + 256 <= window;
}

function fitContextToTokenizer(
  input: SubtitlePostProcessorInput,
  pipeline: TextGenerationPipeline,
  outputTokens: number,
): SubtitlePostProcessorInput | null {
  let context: SubtitlePostProcessorContext = { ...input.context };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = { ...input, context };
    if (fitsTokenizer(buildSubtitlePostProcessorMessages(candidate), pipeline, outputTokens))
      return candidate;
    context = {
      ...context,
      code: context.code?.slice(0, Math.floor((context.code.length ?? 0) / 2)),
      runtimeOutput: context.runtimeOutput?.slice(
        0,
        Math.floor((context.runtimeOutput.length ?? 0) / 2),
      ),
      glossary: context.glossary?.slice(0, Math.floor(context.glossary.length / 2)),
    };
  }
  const candidate = { ...input, context: { language: context.language } };
  return fitsTokenizer(buildSubtitlePostProcessorMessages(candidate), pipeline, outputTokens)
    ? candidate
    : null;
}

async function loadPipelineWithFallback({
  model,
  pipelineFactory,
  pipelineOptions,
}: {
  model: string;
  pipelineFactory?: PipelineFactory;
  pipelineOptions: TextGenerationPipelineOptions[];
}): Promise<TextGenerationPipeline> {
  for (const [index, options] of pipelineOptions.entries()) {
    try {
      return pipelineFactory
        ? await pipelineFactory("text-generation", model, options)
        : await loadDefaultPipeline("text-generation", model, options);
    } catch (error) {
      const hasNextOption = index < pipelineOptions.length - 1;
      if (!hasNextOption) {
        throw buildModelLoadError(error, options);
      }
      if (!isRecoverableModelLoadError(error, options)) {
        throw buildModelLoadError(error, options);
      }
    }
  }
  throw new Error("本地字幕 LLM 模型加载失败");
}

function buildModelLoadError(error: unknown, options: TextGenerationPipelineOptions): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `当前浏览器无法加载本地字幕 LLM 模型（${options.device}/${options.dtype}）。请确认已运行 npm run subtitle:vendor 拉取模型资产，关闭其他占用内存的页面、升级浏览器后重试，或稍后再运行字幕纠错。原始错误：${detail}`,
  );
  if (error instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = error;
  }
  return wrapped;
}

function isRecoverableModelLoadError(
  error: unknown,
  options: TextGenerationPipelineOptions,
): boolean {
  return (
    options.device === "webgpu" ||
    isQuantizedWeightCompatibilityError(error) ||
    isMissingModelArtifactError(error)
  );
}

function buildChatTemplateOption(model: string): { chat_template?: string } {
  return model.includes("code-tape-subtitle-postprocessor")
    ? { chat_template: SMOLLM_CHAT_TEMPLATE }
    : {};
}

function isQuantizedWeightCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("TransposeDQWeightsForMatMulNBits") ||
    message.includes("MatMulNBits") ||
    message.includes("Missing required scale")
  );
}

function isMissingModelArtifactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not locate file") ||
    message.includes("Could not load model") ||
    message.includes("404") ||
    message.includes("Not Found")
  );
}

async function loadDefaultPipeline(
  task: "text-generation",
  model: string,
  options: TextGenerationPipelineOptions,
): Promise<TextGenerationPipeline> {
  return loadTransformersPipeline<TextGenerationPipeline>(
    task,
    model,
    options,
    {},
    {
      vendored: model === DEFAULT_POSTPROCESSOR_MODEL,
    },
  );
}

function readGeneratedText(output: unknown): string {
  const text = readGeneratedTextCandidate(output);
  if (text !== null) return text;
  throw new Error("LLM 输出缺少 generated_text");
}

function readGeneratedTextCandidate(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const assistantContent = readAssistantMessageContent(output);
    if (assistantContent !== null) return assistantContent;
    return output.length > 0 ? readGeneratedTextCandidate(output[0]) : null;
  }
  if (isPlainObject(output)) {
    return readGeneratedTextCandidate(output.generated_text);
  }
  return null;
}

function readAssistantMessageContent(messages: unknown[]): string | null {
  const assistantMessage = [...messages]
    .reverse()
    .find(
      (message): message is { role: string; content: string } =>
        isPlainObject(message) &&
        message.role === "assistant" &&
        typeof message.content === "string",
    );
  return assistantMessage?.content ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
