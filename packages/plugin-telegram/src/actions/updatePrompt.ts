import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  type Validator,
  type Handler,
  createUniqueUuid,
} from '@elizaos/core';
import { Markup } from 'telegraf';
import type { InlineKeyboardButton } from '@telegraf/types';

export function createUpdatePromptAction(runtime: IAgentRuntime): Action {
  return {
    name: 'update_prompt',
    description: "Update the agent's prompt/character definition",
    validate: (async (runtime: IAgentRuntime, memory: Memory) => {
      const text = memory.content.text?.toLowerCase() || '';
      return (
        text.includes('update your prompt') ||
        text.includes('change your character') ||
        text.includes('update your character') ||
        text.includes('change your prompt')
      );
    }) as Validator,
    handler: (async (runtime: IAgentRuntime, memory: Memory, state: undefined) => {
      const callback = state as unknown as HandlerCallback;
      // Get the current prompt
      const currentPrompt = runtime.getSetting('PROMPT');

      // Create a unique ID for this suggestion
      const suggestionId = createUniqueUuid(runtime, `prompt_suggestion_${Date.now()}`) as UUID;

      // Store the current prompt as a suggestion in memory
      const suggestionMemory: Memory = {
        id: suggestionId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: memory.roomId,
        content: {
          text: currentPrompt,
          source: 'telegram',
          channelType: memory.content.channelType,
        },
        metadata: {
          type: 'prompt_suggestion',
          ...memory.metadata,
        },
        createdAt: Date.now(),
      };

      await runtime.createMemory(suggestionMemory, 'state');

      // Create inline keyboard buttons
      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirm', 'confirm_prompt'),
        Markup.button.callback('✏️ Edit', 'edit_prompt'),
        Markup.button.callback('❌ Dismiss', 'dismiss_prompt'),
      ]);

      // Send response with the current prompt and buttons
      const content: Content = {
        text: `Here is my current character definition/prompt:\n\n${currentPrompt}\n\nWould you like to confirm this prompt, edit it, or dismiss this update?`,
        buttons: keyboard.reply_markup.inline_keyboard[0].map((btn: InlineKeyboardButton) => ({
          text: btn.text || '',
          kind: 'callback',
          url: 'callback_data' in btn ? btn.callback_data : '',
        })),
      };

      await callback(content);
    }) as Handler,
  };
}
