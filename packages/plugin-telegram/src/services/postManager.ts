import { Context } from 'telegraf';
import telegramPoster from '../../../cli/src/characters/telegram-poster.json';
import {
  IAgentRuntime,
  createUniqueUuid,
  UUID,
  EventType,
  Character,
  logger,
  AgentStatus,
  Agent,
} from '@elizaos/core';
import { ContentEditManager, EditConfig } from './contentEditManager';

export class PostManager {
  private runtime: IAgentRuntime;
  private AGENT_NAME = 'TelegramPoster';
  private editManager: ContentEditManager;
  private postEditConfig: EditConfig;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.editManager = new ContentEditManager(runtime);

    // Configure post editing settings
    this.postEditConfig = {
      contentType: 'post',
      storagePrefix: 'post_content',
      draftKey: 'post_draft',
      aiEditModeKey: 'is_post_ai_edit_mode',
      manualEditModeKey: 'is_post_manual_edit_mode',
      modelType: 'TEXT_SMALL',
      buttons: {
        apply: '✅ Опубликовать',
        cancel: '❌ Отменить',
        editManual: '✏️ Редактировать вручную',
        editAI: '🤖 Редактировать с ИИ',
        regenerate: '🔄 Создать новый',
      },
      callbacks: {
        apply: 'publish_post', // Use publish_post instead of apply_post
        cancel: 'cancel_post',
        editManual: 'edit_post',
        editAI: 'ai_edit_post',
        regenerate: 'regenerate_post',
      },
      messages: {
        noActiveDraft:
          'Нет активной сессии редактирования поста. Пожалуйста, сгенерируйте новый пост.',
        aiEditActivated: 'Режим редактирования с ИИ активирован',
        manualEditActivated: 'Режим ручного редактирования активирован',
        aiEditInstructions:
          '🤖 *Режим редактирования с ИИ*\n\nТеперь вы можете отправить мне инструкции для изменения поста. Например:\n- "Убери часть про английский язык"\n- "Сделай тон более нейтральным"\n- "Добавь больше эмоций"\n\nТекущий пост:',
        manualEditInstructions:
          '✏️ *Режим ручного редактирования*\n\nВот текущий пост. Отправьте мне вашу полную отредактированную версию:',
        editResult: 'Я обновил пост согласно вашей просьбе:',
        manualEditResult: 'Вот ваша отредактированная версия поста. Хотите её опубликовать?',
        expired: 'Пост истёк. Пожалуйста, создайте новый пост.',
        error: 'Произошла ошибка при редактировании поста.',
      },
    };
  }

  /**
   * Handles AI-assisted post editing based on user instructions
   */
  public async handleAiPostEdit(ctx: Context, userInput: string): Promise<void> {
    return this.editManager.handleAiEdit(ctx, userInput, this.postEditConfig);
  }

  /**
   * Handles manual post editing
   */
  public async handleManualPostEdit(ctx: Context, newPost: string): Promise<void> {
    return this.editManager.handleManualEdit(ctx, newPost, this.postEditConfig);
  }

  /**
   * Checks if post is in edit mode
   */
  public async isInEditMode(): Promise<{ isManual: boolean; isAI: boolean }> {
    return this.editManager.isInEditMode(this.postEditConfig);
  }

  /**
   * Checks if we're waiting for user to provide a theme
   */
  public async isWaitingForTheme(): Promise<boolean> {
    const waitingState = await this.runtime.getSetting('waiting_for_theme');
    return waitingState === '1' || waitingState === 1;
  }

  /**
   * Initiates the theme request flow
   */
  public async requestThemeFromUser(ctx: Context): Promise<void> {
    try {
      logger.info('[PostManager] Requesting theme from user');

      // Set waiting state
      await this.runtime.setSetting('waiting_for_theme', '1');

      await ctx.reply(
        '🎨 **Генерация поста по теме**\n\n' +
          'Пожалуйста, опишите тему для поста. Например:\n' +
          '• "страх перемен"\n' +
          '• "чайные ритуалы"\n' +
          '• "горы и тишина"\n' +
          '• "усталость от городской суеты"\n\n' +
          'Я найду связанные воспоминания и создам пост на основе вашего опыта.',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error('[PostManager] Error requesting theme from user:', error);
      await ctx.reply('❌ Произошла ошибка при запросе темы.');
    }
  }

  /**
   * Handles user input when waiting for theme
   */
  public async handleThemeInput(ctx: Context, theme: string): Promise<void> {
    try {
      logger.info('[PostManager] Processing user theme input:', theme);

      // Clear waiting state
      await this.runtime.setSetting('waiting_for_theme', '0');

      // Generate post based on user-provided theme
      await this.generatePostByUserTheme(ctx, theme);
    } catch (error) {
      logger.error('[PostManager] Error handling theme input:', error);
      await ctx.reply('❌ Произошла ошибка при обработке темы.');

      // Clear waiting state on error
      await this.runtime.setSetting('waiting_for_theme', '0');
    }
  }

  /**
   * Extracts themes from recent memories for theme-based post generation
   */
  public async getThemesFromMemory(days: number = 7, maxThemes: number = 4): Promise<string[]> {
    try {
      logger.info(`[PostManager] Extracting themes from last ${days} days`);

      // Calculate date range
      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;

      // Get recent memories from the runtime
      const recentMemories = await this.runtime.getMemories({
        tableName: 'messages',
        start: startTime,
        end: endTime,
        count: 100, // Limit to prevent overwhelming analysis
      });

      if (!recentMemories || recentMemories.length === 0) {
        logger.warn('[PostManager] No recent memories found for theme extraction');
        return [
          'Размышления о повседневности',
          'Моменты тишины и покоя',
          'Внутренние переживания',
          'Простые радости жизни',
        ];
      }

      // Extract text content from memories
      const memoryTexts = recentMemories
        .map((memory) => memory.content?.text)
        .filter((text) => text && text.length > 10)
        .join('\n\n');

      if (!memoryTexts) {
        logger.warn('[PostManager] No meaningful text content found in memories');
        return ['Размышления о текущем моменте', 'Внутренние ощущения', 'Повседневные наблюдения'];
      }

      // Use AI to analyze and extract themes
      const themeAnalysisPrompt = `Проанализируй следующие разговоры и заметки, чтобы выявить ${maxThemes} основные темы или мотивы:

        ${memoryTexts}

        Найди повторяющиеся темы, эмоциональные состояния, или философские размышления. Верни ${maxThemes} кратких формулировки тем в формате:
        1. "тема 1"
        2. "тема 2"
        3. "тема 3"
        ${maxThemes > 3 ? '4. "тема 4"' : ''}

        Темы должны быть:
        - Конкретными и осмысленными
        - Подходящими для создания постов в социальных сетях
        - Отражающими реальные переживания из текста
        - Написанными простым, понятным языком

        Примеры хороших тем:
        - "тяга к сладкому в моменты тишины"
        - "усталость от слишком большого количества разговоров"
        - "паузы как способ сохранить себя"
        - "ощущение, что внутренняя тишина никогда не приходит"`;

      const themesResponse = await this.runtime.useModel('TEXT_SMALL', {
        prompt: themeAnalysisPrompt,
      });

      // Parse themes from response
      const themes = this.parseThemesFromResponse(themesResponse);

      logger.info('[PostManager] Extracted themes:', { themes });
      return themes.slice(0, maxThemes);
    } catch (error) {
      logger.error('[PostManager] Error extracting themes from memory:', error);
      return [
        'Внутренние размышления',
        'Моменты осознанности',
        'Повседневная философия',
        'Эмоциональные состояния',
      ];
    }
  }

  /**
   * Generates a post based on user-provided theme with memory search
   */
  public async generatePostByUserTheme(
    ctx: Context,
    userTheme: string,
    style: string = 'honest, without poetry',
    format: string = 'short_post'
  ): Promise<void> {
    try {
      logger.info('[PostManager] Generating user theme-based post:', { userTheme, style, format });

      if (!ctx.from || !ctx.chat) {
        logger.error('[PostManager] Missing required context objects:', {
          hasFrom: !!ctx.from,
          hasChat: !!ctx.chat,
        });
        return;
      }

      logger.info('[PostManager] Searching for relevant memories...');
      await ctx.reply(`🔍 Ищу воспоминания по теме: "${userTheme}"...`);

      // Search for relevant memories based on the theme
      const relevantMemories = await this.searchMemoriesByTheme(userTheme);

      logger.info('[PostManager] Found relevant memories:', {
        count: relevantMemories.length,
        theme: userTheme,
      });

      if (relevantMemories.length === 0) {
        await ctx.reply(
          `😔 Не нашёл воспоминаний по теме "${userTheme}".\n\n` +
            'Попробуйте другую тему или создайте обычный пост с помощью команды без аргументов.'
        );
        return;
      }

      await ctx.reply(`✨ Нашёл ${relevantMemories.length} связанных воспоминаний. Создаю пост...`);

      // Create unique IDs
      const userId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
      const worldId = createUniqueUuid(this.runtime, `telegram-${userId}`) as UUID;
      const roomId = createUniqueUuid(this.runtime, process.env.TELEGRAM_CHANNEL_ID || '') as UUID;
      logger.info('[PostManager] Generated UUIDs for user theme post:', {
        userId,
        worldId,
        roomId,
      });

      // Load TelegramPoster character if needed
      let currentRuntime = this.runtime;
      let originalCharacter: Character | null = null;

      if (this.runtime.character.name !== 'TelegramPoster') {
        logger.info('[PostManager] Loading TelegramPoster character for user theme...');
        try {
          const telegramPosterChar = await this.loadTelegramPosterCharacter();
          originalCharacter = this.runtime.character;
          (currentRuntime as any).character = telegramPosterChar;
          logger.info('[PostManager] TelegramPoster character loaded successfully for user theme');
        } catch (error) {
          logger.error(
            '[PostManager] Failed to load TelegramPoster character for user theme:',
            error
          );
          await ctx.reply('Ошибка: Не удалось загрузить конфигурацию TelegramPoster');
          return;
        }
      } else {
        logger.info('[PostManager] Using existing TelegramPoster character for user theme');
      }

      try {
        // Create enhanced post generation prompt using found memories
        const memoryContext = this.formatMemoriesForContext(relevantMemories);

        const userThemePostPrompt = `Создай пост для Telegram-канала на основе предоставленной темы и связанных воспоминаний:

        ТЕМА: "${userTheme}"
        
        СВЯЗАННЫЕ ВОСПОМИНАНИЯ:
        ${memoryContext}

        СТИЛЬ: ${style}

        Требования:
        - Пост должен раскрывать тему "${userTheme}" через призму личного опыта из воспоминаний
        - Используй конкретные детали и ситуации из воспоминаний
        - Стиль должен быть ${style}
        - Тон: личный, искренний, основанный на реальном опыте
        - Без излишней метафоричности
        - Понятный и близкий читателю
        - Объедини воспоминания в цельное размышление на заданную тему

        Верни только текст поста без кавычек и дополнительного форматирования.`;

        logger.info('[PostManager] Calling AI model for user theme content generation...');
        const userThemeBasedContent = await currentRuntime.useModel('TEXT_SMALL', {
          prompt: userThemePostPrompt,
        });

        logger.info('[PostManager] AI model response received for user theme:', {
          contentLength: userThemeBasedContent?.length || 0,
          contentPreview: userThemeBasedContent?.substring(0, 100) || 'No content',
        });

        if (!userThemeBasedContent) {
          logger.error('[PostManager] AI model returned empty content for user theme');
          await ctx.reply('Не удалось создать пост на эту тему.');
          return;
        }

        logger.info('[PostManager] Storing user theme content and creating buttons...');

        // Store the generated content for editing
        const hash = await this.editManager.storeTemporaryContent(
          userThemeBasedContent,
          this.postEditConfig.storagePrefix
        );
        await this.runtime.setSetting(this.postEditConfig.draftKey, userThemeBasedContent);
        await this.runtime.setSetting(this.postEditConfig.aiEditModeKey, 0);
        await this.runtime.setSetting(this.postEditConfig.manualEditModeKey, 0);

        // Store theme settings for potential regeneration
        await this.runtime.setSetting('current_post_theme', userTheme);
        await this.runtime.setSetting('current_post_style', style);
        await this.runtime.setSetting('current_post_format', format);

        const buttons = this.editManager.generateEditButtons(hash, this.postEditConfig);
        logger.info('[PostManager] Buttons generated for user theme, sending final message...');

        await ctx.reply(
          `📝 **Пост на тему "${userTheme}":**\n\n${userThemeBasedContent}\n\n` +
            `💭 *Основано на ${relevantMemories.length} воспоминаниях*`,
          {
            reply_markup: { inline_keyboard: buttons },
            parse_mode: 'Markdown',
          }
        );

        logger.info('[PostManager] Final user theme post message sent successfully');
      } finally {
        if (originalCharacter) {
          (currentRuntime as any).character = originalCharacter;
          logger.info('[PostManager] Restored original character after user theme generation');
        }
      }
    } catch (error) {
      logger.error('[PostManager] Error generating user theme-based post:', error);
      await ctx.reply('Произошла ошибка при создании поста по теме.');
    }
  }

  /**
   * Generates a post based on a specific theme
   */
  public async generatePostByTheme(
    ctx: Context,
    theme: string,
    style: string = 'honest, without poetry',
    format: string = 'short_post'
  ): Promise<void> {
    try {
      logger.info('[PostManager] Generating theme-based post:', { theme, style, format });

      if (!ctx.from || !ctx.chat) {
        logger.error('[PostManager] Missing required context objects:', {
          hasFrom: !!ctx.from,
          hasChat: !!ctx.chat,
        });
        return;
      }

      logger.info('[PostManager] Sending status message...');
      await ctx.reply(`Создаю пост на тему: "${theme}"...`);
      logger.info('[PostManager] Status message sent');

      // Create unique IDs
      const userId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
      const worldId = createUniqueUuid(this.runtime, `telegram-${userId}`) as UUID;
      const roomId = createUniqueUuid(this.runtime, process.env.TELEGRAM_CHANNEL_ID || '') as UUID;
      logger.info('[PostManager] Generated UUIDs:', { userId, worldId, roomId });

      // Load TelegramPoster character if needed
      let currentRuntime = this.runtime;
      let originalCharacter: Character | null = null;

      if (this.runtime.character.name !== 'TelegramPoster') {
        logger.info('[PostManager] Loading TelegramPoster character...');
        try {
          const telegramPosterChar = await this.loadTelegramPosterCharacter();
          originalCharacter = this.runtime.character;
          (currentRuntime as any).character = telegramPosterChar;
          logger.info('[PostManager] TelegramPoster character loaded successfully');
        } catch (error) {
          logger.error('[PostManager] Failed to load TelegramPoster character:', error);
          await ctx.reply('Ошибка: Не удалось загрузить конфигурацию TelegramPoster');
          return;
        }
      } else {
        logger.info('[PostManager] Using existing TelegramPoster character');
      }

      try {
        // Create a custom theme-based post generation prompt
        const themePostPrompt = `Создай пост для Telegram-канала на основе следующей темы:

        ТЕМА: "${theme}"

        СТИЛЬ: ${style}

        Требования:
        - Пост должен раскрывать указанную тему
        - Стиль должен быть ${style}
        - Тон: личный, искренний, релевантный
        - Без излишней метафоричности
        - Понятный и близкий читателю

        Верни только текст поста без кавычек и дополнительного форматирования.`;

        logger.info('[PostManager] Calling AI model for content generation...');
        const themeBasedContent = await currentRuntime.useModel('TEXT_SMALL', {
          prompt: themePostPrompt,
        });

        logger.info('[PostManager] AI model response received:', {
          contentLength: themeBasedContent?.length || 0,
          contentPreview: themeBasedContent?.substring(0, 100) || 'No content',
        });

        if (!themeBasedContent) {
          logger.error('[PostManager] AI model returned empty content');
          await ctx.reply('Не удалось создать пост на эту тему.');
          return;
        }

        logger.info('[PostManager] Storing content and creating buttons...');

        // Store the generated content for editing
        const hash = await this.editManager.storeTemporaryContent(
          themeBasedContent,
          this.postEditConfig.storagePrefix
        );
        await this.runtime.setSetting(this.postEditConfig.draftKey, themeBasedContent);
        await this.runtime.setSetting(this.postEditConfig.aiEditModeKey, 0);
        await this.runtime.setSetting(this.postEditConfig.manualEditModeKey, 0);

        const buttons = this.editManager.generateEditButtons(hash, this.postEditConfig);
        logger.info('[PostManager] Buttons generated, sending final message...');

        await ctx.reply(`📝 **Пост на тему "${theme}":**\n\n${themeBasedContent}`, {
          reply_markup: { inline_keyboard: buttons },
          parse_mode: 'Markdown',
        });

        logger.info('[PostManager] Final post message sent successfully');
      } finally {
        if (originalCharacter) {
          (currentRuntime as any).character = originalCharacter;
          logger.info('[PostManager] Restored original character');
        }
      }
    } catch (error) {
      logger.error('[PostManager] Error generating theme-based post:', error);
      await ctx.reply('Произошла ошибка при создании поста по теме.');
    }
  }

  /**
   * Searches for memories related to a specific theme using keyword matching and AI analysis
   */
  private async searchMemoriesByTheme(theme: string, maxResults: number = 10): Promise<any[]> {
    try {
      logger.info('[PostManager] Searching memories for theme:', { theme, maxResults });

      // Get recent memories (last 30 days by default, can be adjusted)
      const endTime = Date.now();
      const startTime = endTime - 30 * 24 * 60 * 60 * 1000; // 30 days

      // First, get a broader set of recent memories
      const recentMemories = await this.runtime.getMemories({
        tableName: 'messages',
        start: startTime,
        end: endTime,
        count: 200, // Get more to filter from
      });

      if (!recentMemories || recentMemories.length === 0) {
        logger.warn('[PostManager] No recent memories found for theme search');
        return [];
      }

      logger.info('[PostManager] Retrieved memories for filtering:', {
        count: recentMemories.length,
      });

      // Extract keywords from the theme for initial filtering
      const themeKeywords = this.extractKeywords(theme);
      logger.info('[PostManager] Extracted theme keywords:', { themeKeywords });

      // Filter memories that contain theme-related keywords
      const keywordFilteredMemories = recentMemories.filter((memory) => {
        const text = memory.content?.text?.toLowerCase() || '';
        return themeKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
      });

      logger.info('[PostManager] Memories after keyword filtering:', {
        count: keywordFilteredMemories.length,
      });

      // If we have some keyword matches, use AI to find the most relevant ones
      if (keywordFilteredMemories.length > 0) {
        const relevantMemories = await this.aiFilterMemoriesByRelevance(
          theme,
          keywordFilteredMemories,
          maxResults
        );
        return relevantMemories;
      }

      // If no keyword matches, use AI to analyze all recent memories for thematic relevance
      logger.info('[PostManager] No keyword matches, using AI for semantic analysis...');
      const semanticMatches = await this.aiFilterMemoriesByRelevance(
        theme,
        recentMemories.slice(0, 50), // Limit to prevent overwhelming the AI
        maxResults
      );

      return semanticMatches;
    } catch (error) {
      logger.error('[PostManager] Error searching memories by theme:', error);
      return [];
    }
  }

  /**
   * Extracts keywords from a theme for initial filtering
   */
  private extractKeywords(theme: string): string[] {
    // Simple keyword extraction - split by spaces and remove common words
    const commonWords = [
      'и',
      'в',
      'на',
      'с',
      'по',
      'для',
      'от',
      'до',
      'из',
      'о',
      'про',
      'у',
      'к',
      'через',
      'при',
      'без',
      'за',
      'над',
      'под',
      'перед',
      'после',
      'во',
      'со',
      'со',
      'the',
      'and',
      'or',
      'but',
      'in',
      'on',
      'at',
      'to',
      'for',
      'of',
      'with',
      'by',
      'from',
      'up',
      'about',
      'into',
      'over',
      'after',
    ];

    const keywords = theme
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((word) => word.length > 2 && !commonWords.includes(word))
      .map((word) => word.trim())
      .filter((word) => word.length > 0);

    // Also add the full theme as a potential match
    if (theme.length > 3) {
      keywords.push(theme.toLowerCase());
    }

    return keywords;
  }

  /**
   * Uses AI to filter memories by relevance to the theme
   */
  private async aiFilterMemoriesByRelevance(
    theme: string,
    memories: any[],
    maxResults: number
  ): Promise<any[]> {
    try {
      if (memories.length === 0) return [];

      logger.info('[PostManager] Using AI to filter memories by relevance:', {
        theme,
        memoryCount: memories.length,
        maxResults,
      });

      // Create a summary of memories for AI analysis
      const memorySummaries = memories
        .map((memory, index) => {
          const text = memory.content?.text || '';
          const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
          return `${index}: ${preview}`;
        })
        .join('\n\n');

      const relevancePrompt = `Проанализируй следующие воспоминания и определи, какие из них наиболее релевантны теме "${theme}".

      ВОСПОМИНАНИЯ:
      ${memorySummaries}

      ЗАДАЧА:
      Выбери до ${maxResults} наиболее релевантных воспоминаний, которые связаны с темой "${theme}".
      Учитывай как прямые упоминания, так и косвенную связь через эмоции, ситуации или контекст.

      ФОРМАТ ОТВЕТА:
      Верни только номера релевантных воспоминаний через запятую, например: 1, 5, 12, 15
      Если релевантных воспоминаний нет, верни: "none"`;

      const aiResponse = await this.runtime.useModel('TEXT_SMALL', {
        prompt: relevancePrompt,
      });

      logger.info('[PostManager] AI relevance analysis response:', { aiResponse });

      if (!aiResponse || aiResponse.toLowerCase().includes('none')) {
        logger.info('[PostManager] AI found no relevant memories');
        return [];
      }

      // Parse the AI response to get memory indices
      const selectedIndices = aiResponse
        .split(',')
        .map((str) => parseInt(str.trim()))
        .filter((num) => !isNaN(num) && num >= 0 && num < memories.length);

      logger.info('[PostManager] AI selected memory indices:', { selectedIndices });

      // Return the selected memories
      const selectedMemories = selectedIndices.map((index) => memories[index]);

      logger.info('[PostManager] Returning AI-filtered memories:', {
        count: selectedMemories.length,
      });

      return selectedMemories;
    } catch (error) {
      logger.error('[PostManager] Error in AI memory filtering:', error);
      // Fallback to keyword-based selection if AI fails
      return memories.slice(0, maxResults);
    }
  }

  /**
   * Formats memories for use in AI context
   */
  private formatMemoriesForContext(memories: any[]): string {
    if (memories.length === 0) {
      return 'Нет доступных воспоминаний.';
    }

    return memories
      .map((memory, index) => {
        const text = memory.content?.text || '';
        const date = memory.createdAt
          ? new Date(memory.createdAt).toLocaleDateString('ru-RU')
          : 'неизвестно';

        // Limit memory text length to avoid overwhelming the context
        const truncatedText = text.length > 300 ? text.substring(0, 300) + '...' : text;

        return `Воспоминание ${index + 1} (${date}): ${truncatedText}`;
      })
      .join('\n\n');
  }

  /**
   * Parses themes from AI response
   */
  private parseThemesFromResponse(response: string): string[] {
    try {
      // Extract themes from numbered list format
      const lines = response.split('\n').filter((line) => line.trim());
      const themes: string[] = [];

      for (const line of lines) {
        // Match patterns like: "1. "theme"" or "- "theme""
        const match =
          line.match(/^\d+\.\s*["«"](.+?)["»"]/) || line.match(/^[-*]\s*["«"](.+?)["»"]/);
        if (match && match[1]) {
          themes.push(match[1].trim());
        }
      }

      // If no structured format found, try to extract quoted strings
      if (themes.length === 0) {
        const quotedMatches = response.match(/["«"]([^"«»"]+)["»"]/g);
        if (quotedMatches) {
          themes.push(...quotedMatches.map((match) => match.replace(/["«»"]/g, '').trim()));
        }
      }

      return themes.length > 0
        ? themes
        : ['Внутренние размышления', 'Моменты тишины', 'Повседневная философия'];
    } catch (error) {
      logger.error('[PostManager] Error parsing themes:', error);
      return ['Размышления о жизни', 'Внутренние переживания', 'Моменты осознанности'];
    }
  }

  /**
   * Resolves environment variable template strings in an object
   * @param obj - Object that may contain template strings like ${ENV_VAR}
   * @returns Object with template strings resolved to actual environment variable values
   */
  private resolveEnvTemplates(obj: any): any {
    if (typeof obj === 'string') {
      // Replace ${VAR_NAME} with actual environment variable value
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const envValue = process.env[varName];
        if (envValue === undefined) {
          logger.warn(`Environment variable ${varName} is not set`);
          return match; // Return original template if env var not found
        }
        return envValue;
      });
    } else if (Array.isArray(obj)) {
      return obj.map((item) => this.resolveEnvTemplates(item));
    } else if (obj && typeof obj === 'object') {
      const resolved: any = {};
      for (const [key, value] of Object.entries(obj)) {
        resolved[key] = this.resolveEnvTemplates(value);
      }
      return resolved;
    }
    return obj;
  }

  private async loadTelegramPosterCharacter(): Promise<Character> {
    try {
      logger.info('[PostManager] Starting TelegramPoster character initialization');

      // Try to get agent from database first - use adapter from runtime
      // Get agent by name
      let agent = await (this.runtime as any).adapter.getAgentByName(this.AGENT_NAME);

      // If agent not found in database, create it from local JSON file
      if (!agent) {
        logger.info('[PostManager] Agent not found in database, creating from local JSON file');

        const telegramPosterJson = telegramPoster as Character;

        const now = Date.now();
        const newAgent = {
          ...telegramPosterJson,
          createdAt: now,
          updatedAt: now,
          status: AgentStatus.ACTIVE,
          enabled: true,
        } as Agent;

        await this.runtime.createAgent(newAgent);
        agent = await (this.runtime as any).adapter.getAgentByName(this.AGENT_NAME);
        if (!agent) {
          throw new Error('Failed to retrieve newly created agent');
        }

        logger.info('[PostManager] Successfully created agent in database');
      } else {
        logger.info('[PostManager] Found agent in runtime');
      }

      // Update plugins based on environment
      const plugins = [
        '@elizaos/plugin-sql',
        '@elizaos/plugin-bootstrap',
        ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
        ...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),
      ];

      // Resolve environment variable template strings in settings
      const resolvedSettings = this.resolveEnvTemplates(agent.settings || {});
      const resolvedSecrets = this.resolveEnvTemplates(agent.secrets || {});

      // Return enhanced character with plugins and context
      return {
        ...agent,
        id: agent.id,
        name: agent.name,
        username: agent.username || null,
        bio: agent.bio || null,
        system: agent.system || null,
        style: agent.style || null,
        topics: agent.topics || null,
        adjectives: agent.adjectives || null,
        knowledge: agent.knowledge || null,
        messageExamples: agent.messageExamples || null,
        postExamples: agent.postExamples || null,
        core_readings: agent.core_readings || null,
        settings: {
          ...resolvedSettings,
          plugins,
        },
        secrets: {
          ...resolvedSecrets,
          key: process.env.TELEGRAM_BOT_TOKEN || '',
        },
      } as Character;
    } catch (error) {
      logger.error('[PostManager] Failed to load TelegramPoster character:', error);
      throw new Error('Failed to load TelegramPoster character configuration');
    }
  }

  async handlePostCallback(ctx: Context): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;

    const data = ctx.callbackQuery.data;
    logger.info('[PostManager] Handling callback:', { data });

    try {
      // Try to handle with shared edit manager first
      const wasHandled = await this.editManager.handleEditCallback(ctx, data, this.postEditConfig);
      if (wasHandled) {
        // Handle regenerate callback
        if (data === 'regenerate_post') {
          // Get current theme settings BEFORE cleanup (they get cleared during cleanup)
          const currentTheme = await this.runtime.getSetting('current_post_theme');
          const currentStyle = await this.runtime.getSetting('current_post_style');
          const currentFormat = await this.runtime.getSetting('current_post_format');

          logger.info('[PostManager] Regenerating with stored settings:', {
            currentTheme,
            currentStyle,
            currentFormat,
          });

          // Clean up the current session after getting the settings
          await this.editManager.cleanupEditSession(this.postEditConfig, true); // Preserve theme for regeneration

          if (currentTheme) {
            // Regenerate with the same theme
            logger.info('[PostManager] Regenerating theme-based post:', {
              theme: currentTheme,
              style: currentStyle,
              format: currentFormat,
            });
            await this.generatePostByTheme(
              ctx,
              currentTheme,
              currentStyle || 'honest, without poetry',
              currentFormat || 'short_post'
            );
          } else {
            // Use a fallback theme for regeneration
            logger.info('[PostManager] No stored theme, using fallback theme for regeneration');
            await this.generatePostByTheme(
              ctx,
              'размышления о текущем моменте',
              'honest, without poetry',
              'short_post'
            );
          }
        }

        // Remove the inline keyboard
        if (ctx.callbackQuery.message && 'reply_markup' in ctx.callbackQuery.message) {
          try {
            await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
          } catch (error: any) {
            // Ignore "message is not modified" errors - they're harmless
            if (!error.message?.includes('message is not modified')) {
              logger.error('[PostManager] Error removing keyboard during regenerate:', error);
            }
          }
        }
        return;
      }

      // Handle post-specific callbacks
      if (data.startsWith('publish_post:')) {
        const hash = data.replace('publish_post:', '');
        const postText = await this.editManager.getAndClearTemporaryContent(
          hash,
          this.postEditConfig.storagePrefix
        );

        if (!postText) {
          await ctx.answerCbQuery('❌ Пост истёк или не найден');
          return;
        }

        if (process.env.TELEGRAM_CHANNEL_ID) {
          await ctx.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, postText);
          await ctx.answerCbQuery('✅ Пост опубликован!');

          // Combine text edit and keyboard removal in a single operation
          if (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message) {
            try {
              await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ Опубликовано', {
                reply_markup: { inline_keyboard: [] },
              });
            } catch (error: any) {
              // Ignore "message is not modified" errors - they're harmless
              if (!error.message?.includes('message is not modified')) {
                logger.error('[PostManager] Error updating message after publish:', error);
              }
            }
          }
        }

        // Clean up edit session
        await this.editManager.cleanupEditSession(this.postEditConfig, false); // Clear everything including theme
        return; // Important: return here to avoid duplicate keyboard removal
      }

      // Remove the inline keyboard (only for other callbacks)
      if (ctx.callbackQuery.message && 'reply_markup' in ctx.callbackQuery.message) {
        try {
          await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        } catch (error: any) {
          // Ignore "message is not modified" errors - they're harmless
          if (!error.message?.includes('message is not modified')) {
            logger.error('[PostManager] Error removing keyboard:', error);
          }
        }
      }
    } catch (error) {
      logger.error('[PostManager] Error handling post callback:', error);
      await ctx.reply('Произошла ошибка при обработке запроса.');
    }
  }

  async generatePost(ctx: Context): Promise<void> {
    logger.info('[PostManager] Generating post: ', ctx);
    if (!ctx.message || !ctx.from || !ctx.chat) return;

    try {
      // Notify start
      await ctx.reply('Начинаю создавать новый пост...');

      // Create unique IDs
      const userId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
      const worldId = createUniqueUuid(this.runtime, `telegram-${userId}`) as UUID;
      const roomId = createUniqueUuid(this.runtime, process.env.TELEGRAM_CHANNEL_ID || '') as UUID;

      // Check if we need to load TelegramPoster character
      let currentRuntime = this.runtime;
      let originalCharacter: Character | null = null;

      if (this.runtime.character.name !== 'TelegramPoster') {
        try {
          const telegramPosterChar = await this.loadTelegramPosterCharacter();
          // Store the original character and temporarily swap it
          originalCharacter = this.runtime.character;
          // Use type assertion to temporarily modify the readonly character property
          (currentRuntime as any).character = telegramPosterChar;
          logger.info('Loaded TelegramPoster character configuration');
        } catch (error) {
          logger.error('Failed to load TelegramPoster character:', error);
          await ctx.reply('Ошибка: Не удалось загрузить конфигурацию TelegramPoster');
          return;
        }
      }

      // Verify we have a valid OpenAI API key before proceeding
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey || openaiKey.includes('${') || openaiKey.includes('*')) {
        logger.error('Invalid or missing OPENAI_API_KEY environment variable');
        await ctx.reply('Ошибка: Неверно настроен API ключ OpenAI');
        // Restore original character if we swapped it
        if (originalCharacter) {
          (currentRuntime as any).character = originalCharacter;
        }
        return;
      }

      try {
        // Use the core postGeneratedHandler through event system
        await currentRuntime.emitEvent(EventType.POST_GENERATED, {
          runtime: currentRuntime,
          callback: async (content) => {
            if (!content.text) return;

            // IMPORTANT: Store content using the original runtime (not the swapped one)
            // to ensure consistent retrieval later during callback handling
            const hash = await this.editManager.storeTemporaryContent(
              content.text,
              this.postEditConfig.storagePrefix
            );

            // Also store draft and settings using original runtime
            await this.runtime.setSetting(this.postEditConfig.draftKey, content.text);
            await this.runtime.setSetting(this.postEditConfig.aiEditModeKey, 0);
            await this.runtime.setSetting(this.postEditConfig.manualEditModeKey, 0);

            // Clear any theme settings since this is regular post generation
            await this.runtime.setSetting('current_post_theme', null);
            await this.runtime.setSetting('current_post_style', null);
            await this.runtime.setSetting('current_post_format', null);

            // Generate buttons using shared manager
            const buttons = this.editManager.generateEditButtons(hash, this.postEditConfig);

            await ctx.reply(content.text, {
              reply_markup: { inline_keyboard: buttons },
            });
          },
          worldId,
          userId,
          roomId,
          source: 'telegram',
        });
      } finally {
        // Always restore the original character if we swapped it
        if (originalCharacter) {
          (currentRuntime as any).character = originalCharacter;
        }
      }
    } catch (error) {
      logger.error('Error generating post:', error);
      await ctx.reply('Произошла ошибка при создании поста.');
    }
  }
}
