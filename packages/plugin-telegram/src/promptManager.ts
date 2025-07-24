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
import { ContentEditManager, EditConfig } from './services/contentEditManager';

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
  private editManager: ContentEditManager;
  private promptEditConfig: EditConfig;
  private readonly promptUpdateTriggers = [
    '/update_prompt',
    'update your prompt',
    'Update your prompt',
    'change your character',
    'Change your character',
    'update your character',
    'Update your character',
    'change your prompt',
    'давай изменим промпт',
    'Давай изменим промпт',
    'давай изменим персонаж',
    'Давай изменим персонаж',
    'давай изменим характер',
    'Давай изменим характер',
    'давай изменим твою роль',
    'Давай изменим твою роль',
    'давай изменим твой промпт',
    'Давай изменим твой промпт',
    'давай изменим твой характер',
    'Давай изменим твой характер',
    'давай изменим твой персонаж',
    'Давай изменим твой персонаж',
    "let's update your prompt",
    "Let's update your prompt",
    'send comment',
    'Send comment',
    'update prompt',
    'Update prompt',
    'update character',
    'Update character',
    'update role',
    'Update role',
    'update system',
    'Update system',
    'update system prompt',
    'Update system prompt',
    'update system character',
    'Update system character',
    'update system role',
    'Update system role',
    'update system prompt',
    'Update system prompt',
  ].map((trigger) => trigger.toLowerCase());

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.editManager = new ContentEditManager(runtime);

    // Configure prompt editing settings
    this.promptEditConfig = {
      contentType: 'prompt',
      storagePrefix: 'prompt_suggestion',
      draftKey: 'prompt_draft',
      aiEditModeKey: 'is_ai_edit_mode',
      manualEditModeKey: 'is_manual_edit_mode',
      modelType: 'TEXT_LARGE',
      buttons: {
        apply: '✅ Apply',
        cancel: '❌ Dismiss',
        editManual: '✏️ Edit manually',
        editAI: '🤖 Edit with AI',
        regenerate: '🔄 Another',
      },
      messages: {
        noActiveDraft:
          'Sorry, there is no active prompt editing session. Please start a new prompt update.',
        aiEditActivated: 'AI edit mode activated',
        manualEditActivated: 'Manual edit mode activated',
        aiEditInstructions:
          '🤖 *AI Edit Mode*\n\nYou can now send me instructions to modify specific parts of the prompt. For example:\n- "Remove the part about English language"\n- "Make it sound more neutral"\n- "Soften the tone a bit"\n\nCurrent prompt:',
        manualEditInstructions:
          "✏️ *Manual Edit Mode*\n\nHere's the current prompt. Send me your complete edited version:",
        editResult: "I've updated the prompt based on your request. Here's the new version:",
        manualEditResult: "Here's your edited version of the prompt. Would you like to apply it?",
        expired: 'Sorry, the suggestion has expired. Please request a new prompt update.',
        error: 'Sorry, I encountered an error while updating the prompt.',
      },
    };

    logger.info('[PromptManager] Initialized');
  }

  public isPromptUpdateRequest(text: string): boolean {
    const isUpdate = this.promptUpdateTriggers.some((trigger) =>
      text.toLowerCase().includes(trigger)
    );
    logger.info(`[PromptManager] Checking if "${text}" is a prompt update request: ${isUpdate}`);
    return isUpdate;
  }

  /**
   * Handles AI-assisted prompt editing based on user instructions
   */
  public async handleAiPromptUpdate(ctx: Context, userInput: string): Promise<void> {
    return this.editManager.handleAiEdit(ctx, userInput, this.promptEditConfig);
  }

  /**
   * Handles manual prompt editing
   */
  public async handleManualEdit(ctx: Context, newPrompt: string): Promise<void> {
    return this.editManager.handleManualEdit(ctx, newPrompt, this.promptEditConfig);
  }

  /**
   * Checks if prompt is in edit mode
   */
  public async isInEditMode(): Promise<{ isManual: boolean; isAI: boolean }> {
    return this.editManager.isInEditMode(this.promptEditConfig);
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

      logger.info('[PromptManager] Calling TEXT_SMALL model...');
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

  public async handlePromptUpdate(ctx: Context): Promise<void> {
    try {
      logger.info('[PromptManager] Starting prompt update handling');
      const suggestion = await this.generatePromptSuggestion();

      // Store the suggestion as the current draft and initialize edit mode settings using shared manager
      await this.runtime.setSetting(this.promptEditConfig.draftKey, suggestion);
      await this.runtime.setSetting(this.promptEditConfig.aiEditModeKey, 0);
      await this.runtime.setSetting(this.promptEditConfig.manualEditModeKey, 0);

      // Store the suggestion temporarily using shared manager
      const hash = await this.editManager.storeTemporaryContent(
        suggestion,
        this.promptEditConfig.storagePrefix
      );
      logger.info('[PromptManager] Stored suggestion with hash:', { hash });

      // Generate buttons using shared manager
      const buttons = this.editManager.generateEditButtons(hash, this.promptEditConfig);

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
      // Try to handle with shared edit manager first
      const wasHandled = await this.editManager.handleEditCallback(
        ctx,
        data,
        this.promptEditConfig
      );
      if (wasHandled) {
        // Handle regenerate callback
        if (data === 'another_prompt') {
          await this.handlePromptUpdate(ctx);
        }

        // Remove the inline keyboard
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        return;
      }

      // Handle prompt-specific callbacks
      if (data.startsWith('apply_prompt:')) {
        const hash = data.split(':')[1];
        logger.info('[PromptManager] Applying prompt with hash:', { hash });

        const suggestion = await this.editManager.getAndClearTemporaryContent(
          hash,
          this.promptEditConfig.storagePrefix
        );
        if (!suggestion) {
          logger.warn('[PromptManager] Suggestion not found for hash:', { hash });
          await ctx.reply('Sorry, the suggestion has expired. Please request a new prompt update.');
          return;
        }

        // Clean up edit session
        await this.editManager.cleanupEditSession(this.promptEditConfig);
        await this.applyPromptAndMarkAnalyzed(suggestion);

        await ctx.answerCbQuery('Prompt applied successfully!');
        await ctx.reply('✅ System prompt updated successfully!');
      }

      // Remove the inline keyboard
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      logger.info('[PromptManager] Removed inline keyboard');
    } catch (error) {
      logger.error('[PromptManager] Error handling prompt callback:', error);
      await ctx.reply('Sorry, I encountered an error while processing your request.');
    }
  }
}
