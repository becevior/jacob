import { Role, type Message } from "~/types";
import { type NextRequest } from "next/server";
import { openai } from "@ai-sdk/openai";
import { convertToCoreMessages, streamText, generateText } from "ai";
import { type ChatModel } from "~/app/dashboard/[org]/[repo]/chat/components/ModelSelector";
import { type ContextItem } from "~/server/utils/codebaseContext";
import {
  getCodebasePrompt,
  getFilesToIncludeContextPrompt,
  getO1Prompt,
  systemPrompt,
} from "../prompts";
import { type CodeFile } from "~/app/dashboard/[org]/[repo]/chat/components/Chat";
import { getContextOverview } from "../utils";
import { type Model } from "~/server/openai/request";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const {
      messages,
      model,
      contextItems,
      temperature = 0.3,
      codeContent,
    } = (await req.json()) as {
      messages: Message[];
      model: ChatModel;
      contextItems: ContextItem[];
      temperature: number;
      codeContent: CodeFile[] | undefined;
    };
    if (!model) {
      return new Response("Model is required", { status: 400 });
    }
    if (!contextItems) {
      return new Response("No context items provided", { status: 200 });
    }

    const isO1 = model.modelName?.startsWith("o1") ?? false;

    const modelName = model.modelName as Model;
    const context = getContextOverview(contextItems, modelName);

    const prompts: {
      type: "text";
      text: string;
    }[] = [];

    if (isO1) {
      prompts.push({
        type: "text",
        text: getO1Prompt(),
      });
    }

    if (codeContent) {
      codeContent.map((c) => {
        const codeFilePrompt = getFilesToIncludeContextPrompt(
          `The user is specifically asking for information related to this file. If the user is asking for changes, it is critically important to ALWAYS use the "editFile" tool.${c.path}: ${c.content}`,
        );
        prompts.push({
          type: "text",
          text: codeFilePrompt,
        });
      });
    }

    const codebasePrompt = getCodebasePrompt(context);

    prompts.push({
      type: "text",
      text: codebasePrompt,
    });

    // find the first user message. Add the code context and file details to it.
    const userMessage = messages.find((m) => m.role === Role.USER);
    if (!userMessage) {
      return new Response("User message is required", { status: 400 });
    }
    prompts.push({
      type: "text",
      text: userMessage.content,
    });

    // now add the codebase context to the existing user message
    const newUserMessage = {
      ...userMessage,
      content: prompts,
    };

    // replace the first user message with the new user message. ONLY replace the first one.
    let hasReplacedMessage = false;
    const newMessages = [];
    for (const m of messages) {
      if (m.role === Role.USER && !hasReplacedMessage) {
        newMessages.push(newUserMessage);
        hasReplacedMessage = true;
      } else {
        newMessages.push(m);
      }
    }

    // BUGBUG remove any toolInvocations values from the messages
    const messagesWithoutToolInvocations = newMessages.map((m) => {
      return {
        role: m.role,
        content:
          m.content?.length > 0
            ? m.content
            : JSON.stringify(m) ?? "empty message",
      };
    });

    // For O1 models, change any role that's not 'user' or 'assistant' to 'user'
    const adjustedMessages = isO1
      ? messagesWithoutToolInvocations.map((m) => ({
          ...m,
          role: m.role === Role.ASSISTANT ? Role.ASSISTANT : Role.USER,
        }))
      : messagesWithoutToolInvocations;

    const gptOptions = {
      model: openai(model.modelName),
      messages: convertToCoreMessages(adjustedMessages as Message[]),
      system: systemPrompt,
      maxTokens: 8000,
      experimental_toolCallStreaming: false,
      toolChoice: "auto" as any,
      temperature,
    };

    const o1Options = {
      model: openai(model.modelName),
      messages: convertToCoreMessages(adjustedMessages as Message[]),
      temperature: 1,
      experimental_providerMetadata: {
        openai: { maxCompletionTokens: 8000 },
      },
    };

    if (isO1) {
      const result = await generateText(o1Options);
      return new Response(result.text);
    } else {
      // Initialize the stream using @ai-sdk/openai
      const result = await streamText(gptOptions);
      return result.toDataStreamResponse();
    }
  } catch (error) {
    console.error("Error with chat endpoint", error);
    console.log(JSON.stringify(error));
    return new Response("Error with chat endpoint", { status: 500 });
  }
}
