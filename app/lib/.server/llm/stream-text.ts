import { streamText as _streamText } from 'ai';
import { MAX_TOKENS, type FileMap } from './constants';
import { getSystemPrompt } from '~/lib/common/prompts/prompts';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, MODIFICATIONS_TAG_NAME, PROVIDER_LIST, WORK_DIR } from '~/utils/constants';
import type { IProviderSetting } from '~/types/model';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { allowedHTMLElements } from '~/utils/markdown';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';
import { createFilesContext, extractPropertiesFromMessage, simplifyBoltActions } from './utils';
import { getFilePaths } from './select-context';
import { countTokens } from '~/utils/token-counter';

interface ToolResult<Name extends string, Args, Result> {
  toolCallId: string;
  toolName: Name;
  args: Args;
  result: Result;
  state: 'result';
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolInvocations?: ToolResult<string, unknown, unknown>[];
  model?: string;
}

export type Messages = Message[];

export type StreamingOptions = Omit<Parameters<typeof _streamText>[0], 'model'>;

const logger = createScopedLogger('stream-text');

interface TokenStats {
  characterCount: number;
  tokenCount: number;
  inputCost?: number;
  outputCost?: number;
}

interface MessageContent {
  type: string;
  text?: string;
}

interface StreamResponse {
  content?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    stats?: {
      input: TokenStats;
      output: TokenStats;
    };
  };
}

interface ExtendedStreamingOptions extends StreamingOptions {
  callbacks?: {
    onCompletion?: (completion: string) => void;
    onResponse?: (response: StreamResponse) => void;
  };
}

export async function streamText(props: {
  messages: Messages;
  env: Env;
  options?: ExtendedStreamingOptions;
  apiKeys?: Record<string, string>;
  files?: FileMap;
  providerSettings?: Record<string, IProviderSetting>;
  promptId?: string;
  contextOptimization?: boolean;
  contextFiles?: FileMap;
  summary?: string;
}) {
  const {
    messages,
    env: serverEnv,
    options,
    apiKeys,
    files,
    providerSettings,
    promptId,
    contextOptimization,
    contextFiles,
    summary,
  } = props;

  let currentModel = DEFAULT_MODEL;
  let currentProvider = DEFAULT_PROVIDER.name;
  let processedMessages = messages.map((message) => {
    if (message.role === 'user') {
      const { model, provider, content } = extractPropertiesFromMessage(message);
      currentModel = model;
      currentProvider = provider;

      return { ...message, content };
    } else if (message.role === 'assistant') {
      let content = message.content;

      if (contextOptimization) {
        content = simplifyBoltActions(content);
      }

      return { ...message, content };
    }

    return message;
  });

  const provider = PROVIDER_LIST.find((p) => p.name === currentProvider) || DEFAULT_PROVIDER;
  const staticModels = LLMManager.getInstance().getStaticModelListFromProvider(provider);
  let modelDetails = staticModels.find((m) => m.name === currentModel);

  if (!modelDetails) {
    const modelsList = [
      ...(provider.staticModels || []),
      ...(await LLMManager.getInstance().getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: serverEnv as any,
      })),
    ];

    if (!modelsList.length) {
      throw new Error(`No models found for provider ${provider.name}`);
    }

    modelDetails = modelsList.find((m) => m.name === currentModel);

    if (!modelDetails) {
      logger.warn(
        `MODEL [${currentModel}] not found in provider [${provider.name}]. Falling back to first model. ${modelsList[0].name}`,
      );
      modelDetails = modelsList[0];
    }
  }

  const dynamicMaxTokens = modelDetails && modelDetails.maxTokenAllowed ? modelDetails.maxTokenAllowed : MAX_TOKENS;

  let systemPrompt =
    PromptLibrary.getPropmtFromLibrary(promptId || 'default', {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
    }) ?? getSystemPrompt();

  if (files && contextFiles && contextOptimization) {
    const codeContext = createFilesContext(contextFiles, true);
    const filePaths = getFilePaths(files);

    systemPrompt = `${systemPrompt}
Below are all the files present in the project:
---
${filePaths.join('\n')}
---

Below is the context loaded into context buffer for you to have knowledge of and might need changes to fullfill current user request.
CONTEXT BUFFER:
---
${codeContext}
---
`;

    if (summary) {
      systemPrompt = `${systemPrompt}
      below is the chat history till now
CHAT SUMMARY:
---
${summary}
---
`;

      const lastMessage = processedMessages.pop();

      if (lastMessage) {
        processedMessages = [lastMessage];
      }
    }
  }

  const systemPromptTokens = countTokens(systemPrompt);

  logger.info(`Sending llm call to ${provider.name} with model ${modelDetails.name}`);

  const streamOptions = {
    ...options,
    callbacks: {
      ...options?.callbacks,
      onCompletion: (completion: string) => {
        options?.callbacks?.onCompletion?.(completion);
      },
      onResponse: (response: StreamResponse) => {
        if (response.usage) {
          const lastMessage = messages[messages.length - 1];
          const messageContent =
            typeof lastMessage.content === 'string'
              ? lastMessage.content
              : Array.isArray(lastMessage.content)
                ? (lastMessage.content as MessageContent[]).find((c: MessageContent) => c.type === 'text')?.text || ''
                : '';

          const rawPromptTokens = response.usage.promptTokens || 0;
          const rawCompletionTokens = response.usage.completionTokens || 0;

          // Only count tokens from actual chat messages by subtracting system prompt tokens
          const promptTokens = Math.max(0, rawPromptTokens - systemPromptTokens);
          const completionTokens = rawCompletionTokens;
          const totalTokens = promptTokens + completionTokens;

          // Update stats with actual message tokens
          response.usage = {
            promptTokens: Number(promptTokens),
            completionTokens: Number(completionTokens),
            totalTokens: Number(totalTokens),
            stats: {
              input: {
                characterCount: messageContent.length,
                tokenCount: promptTokens,
                inputCost: (promptTokens * 0.14) / 1000000, // $0.14 per 1M tokens
              },
              output: {
                characterCount: (response.content || '').length,
                tokenCount: completionTokens,
                outputCost: (completionTokens * 0.28) / 1000000, // $0.28 per 1M tokens
              },
            },
          };
        }

        options?.callbacks?.onResponse?.(response);
      },
    },
  };

  return await _streamText({
    ...streamOptions,
    messages: [{ role: 'system', content: systemPrompt }, ...processedMessages],
    maxTokens: dynamicMaxTokens,
    model: provider.getModelInstance({
      model: modelDetails.name,
      serverEnv,
      apiKeys,
      providerSettings,
    }),
  });
}
