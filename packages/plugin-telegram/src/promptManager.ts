import {
  type IAgentRuntime,
  type Memory,
  logger,
  ModelType,
  MemoryType,
  type MemoryMetadata,
  type UUID,
  type CustomMetadata,
} from '@elizaos/core';
import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import crypto from 'crypto';

interface MessageMetadata extends CustomMetadata {
  type: MemoryType.MESSAGE;
  fromBot?: boolean;
  isAnalyzed?: boolean;
  fromId?: number;
  entityName?: string;
  entityUserName?: string;
}

export class PromptManager {
  private runtime: IAgentRuntime;
  private readonly promptUpdateTriggers = [
    'update your prompt',
    'change your character',
    'update your character',
    'change your prompt',
    'давай изменим промпт',
    'давай изменим персонаж',
    'давай изменим характер',
    'давай изменим твою роль',
    'давай изменим твой промпт',
    'давай изменим твой характер',
    'давай изменим твой персонаж',
    "let's update your prompt",
    'send comment',
    'update prompt',
  ].map((trigger) => trigger.toLowerCase());

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    logger.info('[PromptManager] Initialized');
  }

  public isPromptUpdateRequest(text: string): boolean {
    const isUpdate = this.promptUpdateTriggers.some((trigger) =>
      text.toLowerCase().includes(trigger)
    );
    logger.info(`[PromptManager] Checking if "${text}" is a prompt update request: ${isUpdate}`);
    return isUpdate;
  }

  private async generatePromptSuggestion(): Promise<string> {
    try {
      logger.info('[PromptManager] Starting prompt suggestion generation');

      // Get current system prompt from both possible sources
      const settingPrompt = await this.runtime.getSetting('SYSTEM');
      const characterPrompt = this.runtime.character.system;
      const currentSystem = settingPrompt || characterPrompt || '';
      logger.info('[PromptManager] Current system prompt:', {
        fromSettings: !!settingPrompt,
        fromCharacter: !!characterPrompt,
        currentSystem,
      });

      // Get recent messages from the last 24 hours
      logger.info('[PromptManager] Fetching recent messages...');
      const recentMessages = await this.runtime.getMemories({
        tableName: 'messages',
        unique: true,
        agentId: this.runtime.agentId,
        isAnalyzed: false,
        count: 100,
      });
      logger.info('[PromptManager] Fetched messages:', { count: recentMessages.length });

      // Filter messages after fetching
      const filteredMessages = recentMessages
        .filter((msg) => {
          const metadata = msg.metadata as MessageMetadata;
          return (
            metadata &&
            metadata.type === MemoryType.MESSAGE &&
            !metadata.fromBot &&
            !metadata.isAnalyzed
          );
        })
        .slice(0, 10); // Take only the first 10 after filtering

      logger.info('[PromptManager] Filtered messages:', {
        total: recentMessages.length,
        filtered: filteredMessages.length,
      });

      // Get relevant facts about the user
      logger.info('[PromptManager] Fetching user facts...');
      const userFacts = await this.runtime.getMemories({
        tableName: 'facts',
        count: 5,
        unique: true,
        agentId: this.runtime.agentId,
      });
      logger.info('[PromptManager] Fetched facts:', { count: userFacts.length });

      // Format messages and facts for context
      const messageContext = filteredMessages
        .map((m) => m.content.text)
        .filter(Boolean)
        .join('\n');
      logger.info('[PromptManager] Message context length:', {
        chars: messageContext.length,
        messages: filteredMessages.length,
      });

      const factContext = userFacts
        .map((f) => f.content.text)
        .filter(Boolean)
        .map((fact) => `- ${fact}`)
        .join('\n');
      logger.info('[PromptManager] Fact context length:', {
        chars: factContext.length,
        facts: userFacts.length,
      });

      const systemPrompt =
        "You are an AI assistant helping to improve an agent's system prompt. Generate a concise but effective prompt based on the conversation context and known facts about the user. The prompt should be specific and actionable.";

      const userPrompt = `Current system prompt: "${currentSystem}"

Recent conversation context:
${messageContext}

Known facts about the user:
${factContext}

Based on this context and these facts, suggest an improved system prompt that would help me better assist this user.`;

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      logger.info('[PromptManager] Generated prompt for model:', {
        systemLength: systemPrompt.length,
        userLength: userPrompt.length,
      });

      logger.info('[PromptManager] Calling TEXT_LARGE model...');
      const suggestion = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: fullPrompt,
      });
      logger.info('[PromptManager] Got suggestion:', { length: suggestion.length });

      return suggestion;
    } catch (error) {
      logger.error('[PromptManager] Error generating prompt suggestion:', error);
      throw error;
    }
  }

  public async handlePromptUpdate(ctx: Context): Promise<void> {
    try {
      logger.info('[PromptManager] Starting prompt update handling');
      const suggestion = await this.generatePromptSuggestion();

      // Generate a short hash for the suggestion
      const hash = crypto.createHash('sha256').update(suggestion).digest('hex').slice(0, 8);
      logger.info('[PromptManager] Generated suggestion hash:', { hash });

      // Store the suggestion temporarily
      await this.runtime.setSetting(`prompt_suggestion_${hash}`, suggestion);
      logger.info('[PromptManager] Stored suggestion with hash');

      const buttons = [
        [
          Markup.button.callback('✅ Apply', `apply_prompt:${hash}`),
          Markup.button.callback('❌ Dismiss', 'dismiss_prompt'),
        ],
        [
          Markup.button.callback('✏️ Edit', `edit_prompt:${hash}`),
          Markup.button.callback('🔄 Another', 'another_prompt'),
        ],
      ];

      logger.info('[PromptManager] Sending suggestion to user');
      await ctx.reply(
        `Based on our recent conversations and what I know about you, I suggest updating the system prompt to:\n\n${suggestion}\n\nWhat would you like to do?`,
        Markup.inlineKeyboard(buttons)
      );
      logger.info('[PromptManager] Suggestion sent successfully');
    } catch (error) {
      logger.error('[PromptManager] Error handling prompt update:', error);
      await ctx.reply('Sorry, I encountered an error while generating a prompt suggestion.');
    }
  }

  public async handleEditMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !('text' in ctx.message) || !ctx.message.text) return;

    const text = ctx.message.text;
    if (!text.toUpperCase().startsWith('EDIT:')) return;

    try {
      logger.info('[PromptManager] Processing edit message');

      // Extract the edited prompt (remove the "EDIT:" prefix and trim)
      const editedPrompt = text.slice(5).trim();

      if (!editedPrompt) {
        await ctx.reply('Please provide the edited prompt text after "EDIT:"');
        return;
      }

      // Apply the edited prompt
      await this.runtime.setSetting('SYSTEM', editedPrompt);
      logger.info('[PromptManager] Applied edited system prompt');

      await ctx.reply('✅ System prompt updated with your edited version!');
    } catch (error) {
      logger.error('[PromptManager] Error handling edit message:', error);
      await ctx.reply('Sorry, I encountered an error while updating the prompt.');
    }
  }

  public async handlePromptCallback(ctx: Context): Promise<void> {
    logger.info('[PromptManager] Handling prompt callback');
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

    const data = ctx.callbackQuery.data;
    logger.info('[PromptManager] Handling callback:', { data });

    try {
      if (data.startsWith('apply_prompt:')) {
        const hash = data.split(':')[1];
        logger.info('[PromptManager] Applying prompt with hash:', { hash });

        const suggestion = await this.runtime.getSetting(`prompt_suggestion_${hash}`);
        if (!suggestion) {
          logger.warn('[PromptManager] Suggestion not found for hash:', { hash });
          await ctx.reply('Sorry, the suggestion has expired. Please request a new prompt update.');
          return;
        }

        await this.runtime.setSetting('SYSTEM', suggestion);
        await this.runtime.setSetting(`prompt_suggestion_${hash}`, null);
        logger.info('[PromptManager] Applied new system prompt');

        // Mark messages as analyzed after successfully applying the prompt
        const recentMessages = await this.runtime.getMemories({
          tableName: 'messages',
          unique: true,
          agentId: this.runtime.agentId,
          isAnalyzed: false,
          count: 100,
        });

        const filteredMessages = recentMessages
          .filter((msg) => {
            const metadata = msg.metadata as MessageMetadata;
            return (
              metadata &&
              metadata.type === MemoryType.MESSAGE &&
              !metadata.fromBot &&
              !metadata.isAnalyzed
            );
          })
          .slice(0, 10);

        logger.info('[PromptManager] Marking messages as analyzed after applying prompt...');
        await Promise.all(
          filteredMessages.map(async (message) => {
            if (!message.id) {
              logger.warn('[PromptManager] Message has no ID:', message);
              return;
            }

            const metadata = message.metadata as MessageMetadata;
            await this.runtime.updateMemory({
              id: message.id as UUID,
              metadata: {
                ...metadata,
                type: MemoryType.MESSAGE,
                isAnalyzed: true,
              },
            });
          })
        );
        logger.info('[PromptManager] Messages marked as analyzed');

        await ctx.reply('✅ System prompt updated successfully!');
      } else if (data === 'dismiss_prompt') {
        logger.info('[PromptManager] Dismissing prompt update');
        await ctx.reply('Prompt update dismissed.');
      } else if (data.startsWith('edit_prompt:')) {
        const hash = data.split(':')[1];
        logger.info('[PromptManager] Starting prompt edit for hash:', { hash });

        const suggestion = await this.runtime.getSetting(`prompt_suggestion_${hash}`);
        if (!suggestion) {
          logger.warn('[PromptManager] Suggestion not found for hash:', { hash });
          await ctx.reply('Sorry, the suggestion has expired. Please request a new prompt update.');
          return;
        }

        await ctx.reply(
          'To edit the prompt, please send your modified version starting with "EDIT:"'
        );
      } else if (data === 'another_prompt') {
        logger.info('[PromptManager] Generating another prompt suggestion');
        await this.handlePromptUpdate(ctx);
      }

      // Remove the inline keyboard
      if (ctx.callbackQuery.message) {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        logger.info('[PromptManager] Removed inline keyboard');
      }
    } catch (error) {
      logger.error('[PromptManager] Error handling prompt callback:', error);
      await ctx.reply('Sorry, I encountered an error while processing your request.');
    }
  }
}
