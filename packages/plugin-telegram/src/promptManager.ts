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
  fromId?: number;
  entityName?: string;
  entityUserName?: string;
  isAnalyzed?: boolean;
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
      const allMessages = await this.runtime.getMemories({
        tableName: 'messages',
        unique: true,
        agentId: this.runtime.agentId,
        count: 100,
      });

      // Filter messages that haven't been analyzed
      const recentMessages = allMessages.filter((msg) => {
        const metadata = msg.metadata as MessageMetadata;
        return !metadata?.isAnalyzed;
      });
      logger.info('[PromptManager] Fetched messages:', { count: recentMessages.length });

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
      const messageContext = recentMessages
        .map((m) => m.content.text)
        .filter(Boolean)
        .join('\n');
      logger.info('[PromptManager] Message context length:', {
        chars: messageContext.length,
        messages: recentMessages.length,
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
      const suggestion = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: fullPrompt,
      });
      logger.info('[PromptManager] Got suggestion:', { length: suggestion.length });

      return suggestion;
    } catch (error) {
      logger.error('[PromptManager] Error generating prompt suggestion:', error);
      throw error;
    }
  }

  private async applyPromptAndMarkAnalyzed(prompt: string): Promise<void> {
    logger.info('[PromptManager] Applying new prompt and marking messages as analyzed');

    // Update runtime setting and character object
    await this.runtime.setSetting('SYSTEM', prompt);
    this.runtime.character.system = prompt;

    // Update the agent's system prompt in the database
    await this.runtime.updateAgent(this.runtime.agentId, {
      system: prompt,
      updatedAt: Date.now(),
    });

    // Get all messages and facts
    const allMessages = await this.runtime.getMemories({
      tableName: 'messages',
      unique: true,
      agentId: this.runtime.agentId,
      count: 100,
    });

    const allFacts = await this.runtime.getMemories({
      tableName: 'facts',
      unique: true,
      agentId: this.runtime.agentId,
      count: 100,
    });

    // Filter messages that haven't been analyzed
    const recentMessages = allMessages.filter((msg) => {
      const metadata = msg.metadata as MessageMetadata;
      return !metadata?.isAnalyzed;
    });

    const allMemories = [...recentMessages, ...allFacts];

    logger.info('[PromptManager] Marking messages as analyzed', {
      count: allMemories.length,
    });

    await Promise.all(
      allMemories.map(async (message) => {
        if (!message.id) {
          logger.warn('[PromptManager] Message has no ID:', message);
          return;
        }

        const metadata = message.metadata as MessageMetadata;
        await this.runtime.updateMemory({
          id: message.id as UUID,
          metadata: {
            ...metadata,
            isAnalyzed: true,
          },
        });
      })
    );

    logger.info('[PromptManager] Messages marked as analyzed', {
      count: allMemories.length,
    });
  }

  public async handleAiPromptUpdate(ctx: Context, userInput: string): Promise<void> {
    logger.info('[PromptManager] Handling partial prompt update:', { userInput });

    const currentDraft = await this.runtime.getSetting('prompt_draft');
    if (!currentDraft) {
      logger.warn('[PromptManager] No prompt draft found for partial update');
      await ctx.reply(
        'Sorry, there is no active prompt editing session. Please start a new prompt update.'
      );
      return;
    }

    const editPrompt = `You are editing the following system prompt for an AI agent:

    CURRENT PROMPT:
    "${currentDraft}"

    USER REQUEST:
    "${userInput}"

    Please modify only the part of the prompt that the user wants changed. Keep everything else intact. Return the full revised prompt only.`;

    try {
      const updatedPrompt = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: editPrompt,
      });

      // Generate a short hash for the suggestion
      const hash = crypto.createHash('sha256').update(updatedPrompt).digest('hex').slice(0, 8);
      logger.info('[PromptManager] Generated hash for updated prompt:', { hash });

      // Store the updated suggestion
      await this.runtime.setSetting(`prompt_suggestion_${hash}`, updatedPrompt);

      const buttons = [
        [
          Markup.button.callback('✅ Apply', `apply_prompt:${hash}`),
          Markup.button.callback('❌ Cancel', 'dismiss_prompt'),
        ],
        [
          Markup.button.callback('✏️ Edit manually', `edit_prompt:${hash}`),
          Markup.button.callback('🤖 Edit with AI', `ai_edit_prompt:${hash}`),
        ],
        [Markup.button.callback('🔄 Another', 'another_prompt')],
      ];

      await ctx.reply(
        `I've updated the prompt based on your request. Here's the new version:\n\n${updatedPrompt}\n\nWhat would you like to do?`,
        Markup.inlineKeyboard(buttons)
      );
    } catch (error) {
      logger.error('[PromptManager] Error handling partial prompt update:', error);
      await ctx.reply('Sorry, I encountered an error while updating the prompt.');
    }
  }

  public async handlePromptUpdate(ctx: Context): Promise<void> {
    try {
      logger.info('[PromptManager] Starting prompt update handling');
      const suggestion = await this.generatePromptSuggestion();

      // Store the suggestion as the current draft and initialize edit mode settings
      await this.runtime.setSetting('prompt_draft', suggestion);
      await this.runtime.setSetting('is_ai_edit_mode', 0);
      await this.runtime.setSetting('is_manual_edit_mode', 0);

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
          Markup.button.callback('✏️ Edit manually', `edit_prompt:${hash}`),
          Markup.button.callback('🤖 Edit with AI', `ai_edit_prompt:${hash}`),
        ],
        [Markup.button.callback('🔄 Another', 'another_prompt')],
      ];

      logger.info('[PromptManager] Sending suggestion to user');
      await ctx.reply(
        `Based on our recent conversations and what I know about you, I suggest updating the system prompt to:\n\n${suggestion}\n\nWhat would you like to do?\n\n- Choose "Edit manually" to copy and edit the entire prompt yourself\n- Choose "Edit with AI" to give me instructions to modify specific parts`,
        Markup.inlineKeyboard(buttons)
      );
      logger.info('[PromptManager] Suggestion sent successfully');
    } catch (error) {
      logger.error('[PromptManager] Error handling prompt update:', error);
      await ctx.reply('Sorry, I encountered an error while generating a prompt suggestion.');
    }
  }

  public async handlePromptCallback(ctx: Context): Promise<void> {
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

        await this.runtime.setSetting(`prompt_suggestion_${hash}`, null);
        await this.runtime.setSetting('prompt_draft', null);
        await this.runtime.setSetting('is_ai_edit_mode', 0);
        await this.runtime.setSetting('is_manual_edit_mode', 0);
        await this.applyPromptAndMarkAnalyzed(suggestion);

        await ctx.answerCbQuery('Prompt applied successfully!');
        await ctx.reply('✅ System prompt updated successfully!');
      } else if (data === 'dismiss_prompt') {
        logger.info('[PromptManager] Dismissing prompt update');
        await this.runtime.setSetting('prompt_draft', null);
        await this.runtime.setSetting('is_ai_edit_mode', 0);
        await this.runtime.setSetting('is_manual_edit_mode', 0);
        await ctx.answerCbQuery('Prompt update dismissed');
        await ctx.reply('Prompt update dismissed.');
      } else if (data.startsWith('edit_prompt:')) {
        const hash = data.split(':')[1];
        logger.info('[PromptManager] Starting manual edit for hash:', { hash });

        const suggestion = await this.runtime.getSetting(`prompt_suggestion_${hash}`);
        if (!suggestion) {
          logger.warn('[PromptManager] Suggestion not found for hash:', { hash });
          await ctx.answerCbQuery('Suggestion has expired');
          await ctx.reply('Sorry, the suggestion has expired. Please request a new prompt update.');
          return;
        }

        // Store the current suggestion as draft and activate manual edit session
        await this.runtime.setSetting('prompt_draft', suggestion);
        await this.runtime.setSetting('is_ai_edit_mode', 0);
        await this.runtime.setSetting('is_manual_edit_mode', 1);

        await ctx.answerCbQuery('Manual edit mode activated');
        await ctx.reply(
          `✏️ *Manual Edit Mode*\n\nHere's the current prompt. Send me your complete edited version:\n\n\`\`\`\n${suggestion}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } else if (data.startsWith('ai_edit_prompt:')) {
        const hash = data.split(':')[1];
        logger.info('[PromptManager] Starting AI edit for hash:', { hash });

        const suggestion = await this.runtime.getSetting(`prompt_suggestion_${hash}`);
        if (!suggestion) {
          logger.warn('[PromptManager] Suggestion not found for hash:', { hash });
          await ctx.answerCbQuery('Suggestion has expired');
          await ctx.reply('Sorry, the suggestion has expired. Please request a new prompt update.');
          return;
        }

        // Store the current suggestion as draft and activate AI edit session
        await this.runtime.setSetting('prompt_draft', suggestion);
        await this.runtime.setSetting('is_ai_edit_mode', 1);
        await this.runtime.setSetting('is_manual_edit_mode', 0);

        logger.info('[PromptManager] AI edit mode activated', {
          is_ai_edit_mode: await this.runtime.getSetting('is_ai_edit_mode'),
          is_manual_edit_mode: await this.runtime.getSetting('is_manual_edit_mode'),
        });

        await ctx.answerCbQuery('AI edit mode activated');
        await ctx.reply(
          `🤖 *AI Edit Mode*\n\nYou can now send me instructions to modify specific parts of the prompt. For example:\n- "Remove the part about English language"\n- "Make it sound more neutral"\n- "Soften the tone a bit"\n\nCurrent prompt:\n\n\`\`\`\n${suggestion}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } else if (data === 'another_prompt') {
        logger.info('[PromptManager] Generating another prompt suggestion');
        await ctx.answerCbQuery('Generating new suggestion...');
        await this.handlePromptUpdate(ctx);
      }

      // Remove the inline keyboard
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      logger.info('[PromptManager] Removed inline keyboard');
    } catch (error) {
      logger.error('[PromptManager] Error handling prompt callback:', error);
      await ctx.reply('Sorry, I encountered an error while processing your request.');
    }
  }

  public async handleManualEdit(ctx: Context, newPrompt: string): Promise<void> {
    try {
      logger.info('[PromptManager] Handling manual prompt edit');

      // Generate a hash for the new version
      const hash = crypto.createHash('sha256').update(newPrompt).digest('hex').slice(0, 8);
      logger.info('[PromptManager] Generated hash for manual edit:', { hash });

      // Store the edited version
      await this.runtime.setSetting(`prompt_suggestion_${hash}`, newPrompt);

      const buttons = [
        [
          Markup.button.callback('✅ Apply', `apply_prompt:${hash}`),
          Markup.button.callback('❌ Cancel', 'dismiss_prompt'),
        ],
        [Markup.button.callback('✏️ Edit again', `edit_prompt:${hash}`)],
      ];

      await ctx.reply(
        `Here's your edited version of the prompt. Would you like to apply it?\n\n\`\`\`\n${newPrompt}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        }
      );
    } catch (error) {
      logger.error('[PromptManager] Error handling manual edit:', error);
      await ctx.reply('Sorry, I encountered an error while processing your edited prompt.');
    }
  }
}
