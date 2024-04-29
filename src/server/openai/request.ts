import { OpenAI } from "openai";
import { encode } from "gpt-tokenizer";
import type { SafeParseSuccess, ZodSchema } from "zod";
import { parse } from "jsonc-parser";

import {
  type BaseEventData,
  parseTemplate,
  removeMarkdownCodeblocks,
} from "../utils";
import { db } from "~/server/db/db";
import { TaskType } from "~/server/db/enums";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.portkey.ai/v1/proxy",
  defaultHeaders: {
    "x-portkey-api-key": process.env.PORTKEY_API_KEY,
    "x-portkey-mode": "proxy openai",
    "x-portkey-cache": "simple",
    "x-portkey-retry-count": "3",
  },
});

const CONTEXT_WINDOW = {
  "gpt-4-0613": 8192,
  "gpt-4-vision-preview": 128000,
  "gpt-4-turbo-preview": 128000,
};

// Note that gpt-4-turbo-preview has a max_tokens limit of 4K, despite having a context window of 128K
const MAX_OUTPUT = {
  "gpt-4-0613": 8192,
  "gpt-4-vision-preview": 4096,
  "gpt-4-turbo-preview": 4096,
};

const ONE_MILLION = 1000000;
const INPUT_TOKEN_COSTS = {
  "gpt-4-0613": 30 / ONE_MILLION,
  "gpt-4-vision-preview": 10 / ONE_MILLION,
  "gpt-4-turbo-preview": 10 / ONE_MILLION,
};
const OUTPUT_TOKEN_COSTS = {
  "gpt-4-0613": 60 / ONE_MILLION,
  "gpt-4-vision-preview": 30 / ONE_MILLION,
  "gpt-4-turbo-preview": 30 / ONE_MILLION,
};

type Model = keyof typeof CONTEXT_WINDOW;

export const getMaxTokensForResponse = async (
  inputText: string,
  model: Model,
): Promise<number> => {
  try {
    const tokens = encode(inputText);
    const numberOfInputTokens = tokens.length;

    const maxContextTokens = CONTEXT_WINDOW[model];
    const padding = Math.ceil(maxContextTokens * 0.01);

    const maxTokensForResponse =
      maxContextTokens - numberOfInputTokens - padding;

    if (maxTokensForResponse <= 0) {
      throw new Error(
        "Input text is too large to fit within the context window.",
      );
    }

    return Math.min(maxTokensForResponse, MAX_OUTPUT[model]);
  } catch (error) {
    console.log("Error in getMaxTokensForResponse: ", error);
    return Math.round(CONTEXT_WINDOW[model] / 2);
  }
};

export const sendGptRequest = async (
  userPrompt: string,
  systemPrompt = "You are a helpful assistant.",
  temperature = 0.2,
  baseEventData: BaseEventData | undefined = undefined,
  retries = 10,
  delay = 60000, // rate limit is 40K tokens per minute, so by default start with 60 seconds
  imagePrompt: OpenAI.Chat.ChatCompletionMessageParam | null = null,
  model: Model = "gpt-4-turbo-preview",
): Promise<string | null> => {
  console.log("\n\n --- User Prompt --- \n\n", userPrompt);
  console.log("\n\n --- System Prompt --- \n\n", systemPrompt);

  try {
    const max_tokens = await getMaxTokensForResponse(
      userPrompt + systemPrompt,
      model,
    );

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ] as OpenAI.Chat.ChatCompletionMessageParam[];

    if (imagePrompt) {
      messages.unshift(imagePrompt);
    }

    console.log(`\n +++ Calling ${model} with max_tokens: ${max_tokens} `);
    const startTime = Date.now();
    const response = await openai.chat.completions.create({
      model,
      messages,
      max_tokens,
      temperature,
    });
    const endTime = Date.now();
    const duration = endTime - startTime;
    console.log(`\n +++ ${model} Response time ${duration} ms`);

    const gptResponse = response.choices[0]?.message;

    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    const tokens = inputTokens + outputTokens;
    const cost =
      inputTokens * INPUT_TOKEN_COSTS[model] +
      outputTokens * OUTPUT_TOKEN_COSTS[model];
    const timestamp = new Date().toISOString();
    if (baseEventData) {
      // send an internal event to track the prompts, timestamp, cost, tokens, and other data
      await db.events.insert({
        ...baseEventData,
        type: TaskType.prompt,
        payload: {
          type: TaskType.prompt,
          metadata: {
            timestamp,
            cost,
            tokens,
            duration,
            model,
          },
          request: {
            prompts: messages.map((message) => ({
              promptType: (message.role?.toUpperCase() ?? "User") as
                | "User"
                | "System"
                | "Assistant",
              prompt:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              timestamp,
            })),
          },
          response: {
            prompt: {
              promptType: "Assistant",
              prompt: gptResponse?.content ?? "",
              timestamp,
            },
          },
        },
      });
    }

    return gptResponse?.content ?? null;
  } catch (error) {
    if (
      retries === 0 ||
      (error as { response?: Response })?.response?.status !== 429
    ) {
      console.error(`Error in GPT request: ${String(error)}`);
      throw error;
    } else {
      console.log(
        `Received 429, retries remaining: ${retries}. Retrying in ${delay} ms...`,
      );
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          sendGptRequest(
            userPrompt,
            systemPrompt,
            temperature,
            baseEventData,
            retries - 1,
            delay * 2,
          )
            .then(resolve)
            .catch(reject);
        }, delay);
      });
    }
  }
};

// Return type should be a ZodSchema or an array of ZodSchema objects
export const sendGptRequestWithSchema = async (
  userPrompt: string,
  systemPrompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zodSchema: ZodSchema<any>,
  maxRetries = 3,
  temperature = 0.2,
  baseEventData?: BaseEventData,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
  let extractedInfo;
  let retries = 0; // Initialize a retries counter

  // Loop until a valid response is received or the maxRetries limit is reached
  while (retries < maxRetries) {
    let gptResponse: string | null = null;

    try {
      gptResponse = await sendGptRequest(
        userPrompt,
        systemPrompt,
        temperature, // Use a lower temperature for retries
        baseEventData,
      );

      if (!gptResponse) {
        throw new Error("/n/n/n/n **** Empty response from GPT **** /n/n/n/n");
      }

      // Remove any code blocks from the response prior to attempting to parse it
      gptResponse = removeMarkdownCodeblocks(gptResponse);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      extractedInfo = parse(gptResponse);

      // if the response is an array of objects, validate each object individually and return the full array if successful
      if (Array.isArray(extractedInfo)) {
        const validatedInfo = extractedInfo.map(
          (info) => zodSchema.safeParse(info), // as SafeParseReturnType<any, any>,
        );

        const failedValidations = validatedInfo.filter(
          (result) => result.success === false,
        );

        if (failedValidations.length > 0) {
          throw new Error(
            `Invalid response from GPT - object is not able to be parsed using the provided schema: ${JSON.stringify(
              failedValidations,
            )}`,
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
        return (validatedInfo as SafeParseSuccess<any>[]).map(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          (result) => result.data,
        );
      }

      // if the response is a single object, validate it and return it if successful
      const validationResult = zodSchema.safeParse(
        extractedInfo,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      );

      if (validationResult.success) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return validationResult.data;
      }

      throw new Error(
        `Invalid response from GPT - object is not able to be parsed using the provided schema: ${JSON.stringify(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          validationResult.error,
        )}`,
      );
    } catch (error) {
      console.log(
        `Error occurred during GPT request: ${
          (error as { message?: string })?.message
        }`,
      );
      retries++;
    }
  }

  throw new Error(`Max retries exceeded for GPT request: ${userPrompt}`);
};

export const sendGptVisionRequest = async (
  userPrompt: string,
  systemPrompt = "You are a helpful assistant.",
  snapshotUrl = "",
  temperature = 0.2,
  baseEventData: BaseEventData | undefined = undefined,
  retries = 10,
  delay = 60000,
): Promise<string | null> => {
  let model: Model = "gpt-4-turbo-preview";
  let imagePrompt = null;
  if (snapshotUrl?.length > 0) {
    model = "gpt-4-vision-preview";

    const prompt = parseTemplate("dev", "vision", "user", {});

    imagePrompt = {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: snapshotUrl,
            detail: "high",
          },
        },
        {
          type: "text",
          text: prompt,
        },
      ],
    } as OpenAI.Chat.ChatCompletionMessageParam;
  }

  return sendGptRequest(
    userPrompt,
    systemPrompt,
    temperature,
    baseEventData,
    retries,
    delay,
    imagePrompt,
    model,
  );
};
