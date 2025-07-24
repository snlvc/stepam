import { Context } from 'telegraf';
import { IAgentRuntime, logger, ModelType } from '@elizaos/core';
import crypto from 'crypto';

export interface EditConfig {
  contentType: 'prompt' | 'post';
  storagePrefix: string;
  draftKey: string;
  aiEditModeKey: string;
  manualEditModeKey: string;
  modelType: string;
  buttons: {
    apply: string;
    cancel: string;
    editManual: string;
    editAI: string;
    regenerate: string;
  };
  callbacks?: {
    apply?: string;
    cancel?: string;
    editManual?: string;
    editAI?: string;
    regenerate?: string;
  };
  messages: {
    noActiveDraft: string;
    aiEditActivated: string;
    manualEditActivated: string;
    aiEditInstructions: string;
    manualEditInstructions: string;
    editResult: string;
    manualEditResult: string;
    expired: string;
    error: string;
  };
}

export class ContentEditManager {
  private runtime: IAgentRuntime;

  // Static in-memory storage that persists across character changes
  private static temporaryStorage: Map<string, { content: string; timestamp: number }> = new Map();
  private static readonly STORAGE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Cleans up expired temporary content
   */
  private static cleanupExpiredContent(): void {
    const now = Date.now();
    for (const [key, data] of ContentEditManager.temporaryStorage.entries()) {
      if (now - data.timestamp > ContentEditManager.STORAGE_TTL) {
        ContentEditManager.temporaryStorage.delete(key);
      }
    }
  }

  /**
   * Generates a short hash for content storage
   */
  private generateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
  }

  /**
   * Strips surrounding quotes from content
   */
  private stripQuotes(content: string): string {
    if (!content) return content;

    // Remove surrounding quotes (both single and double)
    return content
      .replace(/^"(.*)"$/s, '$1') // Remove surrounding double quotes
      .replace(/^'(.*)'$/s, '$1') // Remove surrounding single quotes
      .trim();
  }

  /**
   * Stores content temporarily and returns a short hash
   */
  async storeTemporaryContent(content: string, prefix: string): Promise<string> {
    const hash = this.generateContentHash(content);
    const key = `${prefix}_${hash}`;

    logger.info(`[ContentEditManager] About to store content with key:`, {
      key,
      hash,
      contentLength: content.length,
    });

    // Store in static memory (character-agnostic)
    ContentEditManager.temporaryStorage.set(key, {
      content,
      timestamp: Date.now(),
    });

    // Also store in runtime settings as backup
    await this.runtime.setSetting(key, content);

    // Verify both storage methods worked
    const memoryContent = ContentEditManager.temporaryStorage.get(key)?.content;
    const runtimeContent = await this.runtime.getSetting(key);

    logger.info(`[ContentEditManager] Storage verification:`, {
      key,
      hash,
      memoryStored: !!memoryContent,
      runtimeStored: !!runtimeContent,
      memoryMatches: memoryContent === content,
      runtimeMatches: runtimeContent === content,
      contentLength: content.length,
    });

    return hash;
  }

  /**
   * Retrieves and removes content by hash
   */
  async getAndClearTemporaryContent(hash: string, prefix: string): Promise<string | null> {
    const key = `${prefix}_${hash}`;

    // Get content using the regular method
    const content = await this.getTemporaryContent(hash, prefix);

    if (content) {
      // Clear from both storage locations
      ContentEditManager.temporaryStorage.delete(key);
      await this.runtime.setSetting(key, null);

      logger.info(`[ContentEditManager] Cleared temporary content:`, { key, hash });
    }

    return content;
  }

  /**
   * Retrieves content without clearing it
   */
  async getTemporaryContent(hash: string, prefix: string): Promise<string | null> {
    const key = `${prefix}_${hash}`;

    logger.info(`[ContentEditManager] Attempting to get content with key:`, { key, hash });

    // Clean up expired content first
    ContentEditManager.cleanupExpiredContent();

    // Try memory storage first (more reliable)
    const memoryData = ContentEditManager.temporaryStorage.get(key);
    const memoryContent = memoryData?.content || null;

    // Also try runtime settings as fallback
    const runtimeContent = await this.runtime.getSetting(key);

    logger.info(`[ContentEditManager] Getting content result:`, {
      key,
      hash,
      memoryFound: !!memoryContent,
      runtimeFound: !!runtimeContent,
      memoryLength: memoryContent ? memoryContent.length : 0,
      runtimeLength: runtimeContent ? runtimeContent.length : 0,
      usingMemory: !!memoryContent,
      memoryAge: memoryData ? Date.now() - memoryData.timestamp : 0,
    });

    // Prefer memory storage, fallback to runtime
    return memoryContent || runtimeContent;
  }

  /**
   * Generates edit buttons for content
   */
  generateEditButtons(hash: string, config: EditConfig) {
    const callbacks = config.callbacks || {};

    return [
      [
        {
          text: config.buttons.apply,
          callback_data: `${callbacks.apply || `apply_${config.contentType}`}:${hash}`,
        },
        {
          text: config.buttons.cancel,
          callback_data: callbacks.cancel || `cancel_${config.contentType}`,
        },
      ],
      [
        {
          text: config.buttons.editManual,
          callback_data: `${callbacks.editManual || `edit_${config.contentType}`}:${hash}`,
        },
        {
          text: config.buttons.editAI,
          callback_data: `${callbacks.editAI || `ai_edit_${config.contentType}`}:${hash}`,
        },
      ],
      [
        {
          text: config.buttons.regenerate,
          callback_data: callbacks.regenerate || `regenerate_${config.contentType}`,
        },
      ],
    ];
  }

  /**
   * Handles AI-assisted content editing based on user instructions
   */
  async handleAiEdit(ctx: Context, userInput: string, config: EditConfig): Promise<void> {
    logger.info(`[ContentEditManager] Handling AI ${config.contentType} edit:`, { userInput });

    const currentDraft = await this.runtime.getSetting(config.draftKey);
    if (!currentDraft) {
      logger.warn(`[ContentEditManager] No ${config.contentType} draft found for AI edit`);
      await ctx.reply(config.messages.noActiveDraft);
      return;
    }

    const editPrompt = this.buildEditPrompt(currentDraft, userInput, config);

    try {
      const updatedContent = await this.runtime.useModel(config.modelType as any, {
        prompt: editPrompt,
      });

      // Strip any quotes that the AI might have added to the response
      const cleanUpdatedContent = this.stripQuotes(updatedContent);

      // Store the updated content
      const hash = await this.storeTemporaryContent(cleanUpdatedContent, config.storagePrefix);
      await this.runtime.setSetting(config.draftKey, cleanUpdatedContent);

      const buttons = this.generateEditButtons(hash, config);

      await ctx.reply(
        `${config.messages.editResult}\n\n${cleanUpdatedContent}\n\nЧто хотите сделать?`,
        {
          reply_markup: { inline_keyboard: buttons },
        }
      );
    } catch (error) {
      logger.error(`[ContentEditManager] Error handling AI ${config.contentType} edit:`, error);
      await ctx.reply(config.messages.error);
    }
  }

  /**
   * Handles manual content editing
   */
  async handleManualEdit(ctx: Context, newContent: string, config: EditConfig): Promise<void> {
    try {
      logger.info(`[ContentEditManager] Handling manual ${config.contentType} edit`);

      // Strip any quotes from user input for consistency
      const cleanNewContent = this.stripQuotes(newContent);

      // Generate a hash for the new version
      const hash = await this.storeTemporaryContent(cleanNewContent, config.storagePrefix);
      await this.runtime.setSetting(config.draftKey, cleanNewContent);

      const callbacks = config.callbacks || {};

      const buttons = [
        [
          {
            text: config.buttons.apply,
            callback_data: `${callbacks.apply || `apply_${config.contentType}`}:${hash}`,
          },
          {
            text: config.buttons.cancel,
            callback_data: callbacks.cancel || `cancel_${config.contentType}`,
          },
        ],
        [
          {
            text: config.buttons.editManual,
            callback_data: `${callbacks.editManual || `edit_${config.contentType}`}:${hash}`,
          },
        ],
      ];

      await ctx.reply(`${config.messages.manualEditResult}\n\n${cleanNewContent}`, {
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (error) {
      logger.error(`[ContentEditManager] Error handling manual ${config.contentType} edit:`, error);
      await ctx.reply(config.messages.error);
    }
  }

  /**
   * Handles edit mode callbacks
   */
  async handleEditCallback(ctx: Context, data: string, config: EditConfig): Promise<boolean> {
    const callbacks = config.callbacks || {};
    const editCallback = callbacks.editManual || `edit_${config.contentType}`;
    const aiEditCallback = callbacks.editAI || `ai_edit_${config.contentType}`;
    const cancelCallback = callbacks.cancel || `cancel_${config.contentType}`;
    const regenerateCallback = callbacks.regenerate || `regenerate_${config.contentType}`;

    if (data.startsWith(`${editCallback}:`)) {
      const hash = data.split(':')[1];
      logger.info(`[ContentEditManager] Starting manual edit for ${config.contentType} hash:`, {
        hash,
      });

      const content = await this.getTemporaryContent(hash, config.storagePrefix);
      if (!content) {
        logger.warn(`[ContentEditManager] ${config.contentType} content not found for hash:`, {
          hash,
        });
        await ctx.answerCbQuery(config.messages.expired);
        await ctx.reply(config.messages.expired);
        return true;
      }

      // Store as draft and activate manual edit mode
      await this.runtime.setSetting(config.draftKey, content);
      await this.runtime.setSetting(config.aiEditModeKey, 0);
      await this.runtime.setSetting(config.manualEditModeKey, 1);

      await ctx.answerCbQuery(config.messages.manualEditActivated);
      await ctx.reply(`${config.messages.manualEditInstructions}\n\n\`\`\`\n${content}\n\`\`\``, {
        parse_mode: 'Markdown',
      });
      return true;
    } else if (data.startsWith(`${aiEditCallback}:`)) {
      const hash = data.split(':')[1];
      logger.info(`[ContentEditManager] Starting AI edit for ${config.contentType} hash:`, {
        hash,
      });

      const content = await this.getTemporaryContent(hash, config.storagePrefix);
      if (!content) {
        logger.warn(`[ContentEditManager] ${config.contentType} content not found for hash:`, {
          hash,
        });
        await ctx.answerCbQuery(config.messages.expired);
        await ctx.reply(config.messages.expired);
        return true;
      }

      // Store as draft and activate AI edit mode
      await this.runtime.setSetting(config.draftKey, content);
      await this.runtime.setSetting(config.aiEditModeKey, 1);
      await this.runtime.setSetting(config.manualEditModeKey, 0);

      await ctx.answerCbQuery(config.messages.aiEditActivated);
      await ctx.reply(`${config.messages.aiEditInstructions}\n\n\`\`\`\n${content}\n\`\`\``, {
        parse_mode: 'Markdown',
      });
      return true;
    } else if (data === cancelCallback) {
      // Clean up session completely including theme settings
      await this.cleanupEditSession(config, false); // Clear everything including theme
      await ctx.answerCbQuery('Отменено');
      return true;
    } else if (data === regenerateCallback) {
      // Don't clean up session yet - let the calling manager handle regeneration and cleanup
      await ctx.answerCbQuery('Генерирую новую версию...');
      return true;
    }

    return false; // Not handled by this manager
  }

  /**
   * Cleans up edit session settings
   */
  async cleanupEditSession(config: EditConfig, preserveTheme: boolean = false): Promise<void> {
    logger.info(`[ContentEditManager] Cleaning up edit session for ${config.contentType}`, {
      preserveTheme,
    });
    await this.runtime.setSetting(config.draftKey, null);
    await this.runtime.setSetting(config.aiEditModeKey, 0);
    await this.runtime.setSetting(config.manualEditModeKey, 0);

    // Clean up theme settings for post content type only if not preserving theme
    if (config.contentType === 'post' && !preserveTheme) {
      await this.runtime.setSetting('current_post_theme', null);
      await this.runtime.setSetting('current_post_style', null);
      await this.runtime.setSetting('current_post_format', null);
      logger.info(`[ContentEditManager] Cleared theme settings`);
    } else if (config.contentType === 'post' && preserveTheme) {
      logger.info(`[ContentEditManager] Preserved theme settings for regeneration`);
    }

    logger.info(`[ContentEditManager] Edit session cleanup completed for ${config.contentType}`);
  }

  /**
   * Checks if content is in edit mode
   */
  async isInEditMode(config: EditConfig): Promise<{ isManual: boolean; isAI: boolean }> {
    const isManual = !!(await this.runtime.getSetting(config.manualEditModeKey));
    const isAI = !!(await this.runtime.getSetting(config.aiEditModeKey));
    return { isManual, isAI };
  }

  /**
   * Builds edit prompt based on content type
   */
  private buildEditPrompt(currentContent: string, userInput: string, config: EditConfig): string {
    // Strip any existing quotes from the content before using it in the prompt
    const cleanContent = this.stripQuotes(currentContent);

    if (config.contentType === 'prompt') {
      return `You are editing the following system prompt for an AI agent:

CURRENT PROMPT:
${cleanContent}

USER REQUEST:
${userInput}

Please modify only the part of the prompt that the user wants changed. Keep everything else intact. Return ONLY the full revised prompt text without any quotes or additional formatting.`;
    } else {
      return `Ты редактируешь следующий пост для Telegram-канала:

ТЕКУЩИЙ ПОСТ:
${cleanContent}

ЗАПРОС ПОЛЬЗОВАТЕЛЯ:
${userInput}

Пожалуйста, измени только ту часть поста, которую просит пользователь. Остальное оставь без изменений. Верни ТОЛЬКО полный исправленный текст поста без кавычек и дополнительного форматирования.`;
    }
  }
}
