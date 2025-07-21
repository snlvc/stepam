import {
  type IAgentRuntime,
  type Memory,
  type MemoryMetadata,
  type UUID,
  logger,
  ModelType,
  Service,
  createUniqueUuid,
  ChannelType,
} from '@elizaos/core';
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import { MemoryType } from '@elizaos/core';

// Add MEMORY_SUMMARY to ServiceType
declare module '@elizaos/core' {
  export interface ServiceTypeRegistry {
    MEMORY_SUMMARY: 'memory_summary';
  }
}

/**
 * Service that generates weekly and monthly summaries of agent memories
 */
export class MemorySummaryManager extends Service {
  private weeklyJob: ScheduledTask | null = null;
  private monthlyJob: ScheduledTask | null = null;
  static serviceType = 'memory_summary' as const;
  capabilityDescription = 'The agent can generate weekly and monthly summaries of its memories';

  constructor() {
    super();
    logger.info('[MemorySummaryManager] Service constructed');
  }

  /**
   * Initialize the service when it's registered
   */
  async initialize(): Promise<void> {
    logger.info('[MemorySummaryManager] Initializing service...');
    if (!this.runtime) {
      throw new Error('[MemorySummaryManager] Runtime not set during initialization');
    }
    await this.startCronJobs();
    // Immediately generate summaries on startup
    await this.generateSummariesNow();
    logger.info('[MemorySummaryManager] Service initialized successfully');
  }

  /**
   * Manually trigger summary generation
   */
  public async generateSummariesNow(): Promise<void> {
    logger.info('[MemorySummaryManager] Manually triggering summary generation...');
    try {
      await this.generateWeeklySummary();
      await this.generateMonthlySummary();
      logger.info('[MemorySummaryManager] Manual summary generation completed');
    } catch (error) {
      logger.error('[MemorySummaryManager] Error in manual summary generation:', error);
      throw error;
    }
  }

  /**
   * Start the MemorySummaryManager with the given runtime
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('[MemorySummaryManager] Starting service...');
    const service = new MemorySummaryManager();
    service.runtime = runtime;
    await service.initialize();
    logger.info('[MemorySummaryManager] Service started successfully');
    return service;
  }

  /**
   * Start the cron jobs for weekly and monthly summaries
   */
  private async startCronJobs() {
    logger.info('[MemorySummaryManager] Starting cron jobs setup...');
    logger.info(`[MemorySummaryManager] Runtime info:`, {
      agentId: this.runtime?.agentId,
      characterName: this.runtime?.character?.name,
    });

    try {
      // Weekly summary - runs every Sunday at 1 PM
      this.weeklyJob = cron.schedule('0 13 * * 0', async () => {
        try {
          logger.info('[MemorySummaryManager] ========== WEEKLY SUMMARY CRON TRIGGERED ==========');
          logger.info('[MemorySummaryManager] Runtime check:', {
            agentId: this.runtime?.agentId,
            characterName: this.runtime?.character?.name,
          });
          await this.generateWeeklySummary();
        } catch (error) {
          logger.error('[MemorySummaryManager] Error in weekly summary cron:', error);
        }
      });

      // Monthly summary - runs on the first day of each month at midnight
      this.monthlyJob = cron.schedule('0 0 1 * *', async () => {
        try {
          logger.info(
            '[MemorySummaryManager] ========== MONTHLY SUMMARY CRON TRIGGERED =========='
          );
          logger.info('[MemorySummaryManager] Runtime check:', {
            agentId: this.runtime?.agentId,
            characterName: this.runtime?.character?.name,
          });
          await this.generateMonthlySummary();
        } catch (error) {
          logger.error('[MemorySummaryManager] Error in monthly summary cron:', error);
        }
      });

      logger.info('[MemorySummaryManager] Cron jobs setup completed successfully');
    } catch (error) {
      logger.error('[MemorySummaryManager] Error setting up cron jobs:', error);
      throw error; // Re-throw to ensure initialization fails if cron setup fails
    }
  }

  /**
   * Detect the language of memories
   */
  private async detectLanguage(memories: Memory[]): Promise<string> {
    if (memories.length === 0) return 'english';

    // Get the first few memories to analyze
    const sampleTexts = memories
      .slice(0, 5)
      .map((m) => m.content.text)
      .join('\n');

    const prompt = `Analyze the following text and return ONLY the language name in lowercase (e.g., 'english', 'russian', etc.):

    ${sampleTexts}`;

    const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    return result.toLowerCase().trim();
  }

  /**
   * Generate a weekly summary of memories
   */
  private async generateWeeklySummary() {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    logger.info('[MemorySummaryManager] Fetching memories for weekly summary...');
    logger.info(
      `[MemorySummaryManager] Time range: ${new Date(sevenDaysAgo).toISOString()} to ${new Date(now).toISOString()}`
    );

    // Get unsummarized memories from the last 7 days
    const memories = await this.getUnsummarizedMemories(
      sevenDaysAgo,
      now,
      MemoryType.WEEKLY_SUMMARY
    );
    logger.info(
      `[MemorySummaryManager] Found ${memories.length} unsummarized memories for weekly summary`
    );

    if (memories.length > 0) {
      logger.info(
        '[MemorySummaryManager] Memory contents:',
        memories.map((m) => ({
          id: m.id,
          text: m.content.text?.substring(0, 50) + '...',
          source: m.content.source,
          metadata: m.metadata,
        }))
      );
    }

    if (memories.length === 0) {
      logger.info('[MemorySummaryManager] No new memories found for weekly summary');
      return;
    }

    logger.info('[MemorySummaryManager] Generating weekly summary...');
    const summary = await this.generateSummary(memories, MemoryType.WEEKLY_SUMMARY);
    logger.info('[MemorySummaryManager] Summary generated, saving...');
    await this.saveSummary(summary, MemoryType.WEEKLY_SUMMARY, memories);
    logger.info('[MemorySummaryManager] Marking memories as summarized...');
    await this.markMemoriesAsSummarized(memories, MemoryType.WEEKLY_SUMMARY);
    logger.info('[MemorySummaryManager] Weekly summary process completed');
  }

  /**
   * Generate a monthly summary of memories
   */
  private async generateMonthlySummary() {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    logger.info('[MemorySummaryManager] Fetching memories for monthly summary...');
    logger.info(
      `[MemorySummaryManager] Time range: ${new Date(thirtyDaysAgo).toISOString()} to ${new Date(now).toISOString()}`
    );

    // Get unsummarized memories from the last 30 days
    const memories = await this.getUnsummarizedMemories(
      thirtyDaysAgo,
      now,
      MemoryType.MONTHLY_SUMMARY
    );
    logger.info(
      `[MemorySummaryManager] Found ${memories.length} unsummarized memories for monthly summary`
    );

    if (memories.length > 0) {
      logger.info(
        '[MemorySummaryManager] Memory contents:',
        memories.map((m) => ({
          id: m.id,
          text: m.content.text?.substring(0, 50) + '...',
          source: m.content.source,
          metadata: m.metadata,
        }))
      );
    }

    if (memories.length === 0) {
      logger.info('[MemorySummaryManager] No new memories found for monthly summary');
      return;
    }

    logger.info('[MemorySummaryManager] Generating monthly summary...');
    const summary = await this.generateSummary(memories, MemoryType.MONTHLY_SUMMARY);
    logger.info('[MemorySummaryManager] Summary generated, saving...');
    await this.saveSummary(summary, MemoryType.MONTHLY_SUMMARY, memories);
    logger.info('[MemorySummaryManager] Marking memories as summarized...');
    await this.markMemoriesAsSummarized(memories, MemoryType.MONTHLY_SUMMARY);
    logger.info('[MemorySummaryManager] Monthly summary process completed');
  }

  /**
   * Get unsummarized memories for the given time period
   */
  private async getUnsummarizedMemories(
    start: number,
    end: number,
    type: string
  ): Promise<Memory[]> {
    try {
      logger.info(
        `[MemorySummaryManager] Getting memories between ${new Date(start).toISOString()} and ${new Date(end).toISOString()}`
      );

      // Get memories directly with date range filtering
      const memories = await this.runtime.getMemories({
        tableName: 'messages',
        start,
        end,
        count: 1000, // Get a reasonable batch size
      });

      logger.info(`[MemorySummaryManager] Found ${memories.length} total memories in time range`);

      if (memories.length > 0) {
        logger.info('[MemorySummaryManager] Sample memory:', {
          id: memories[0].id,
          createdAt: memories[0].createdAt,
          text: memories[0].content.text?.substring(0, 100),
          metadata: memories[0].metadata,
        });
      }

      // Filter out memories that have already been summarized or are summaries themselves
      const unsummarizedMemories = memories.filter((memory) => {
        // Skip action results and system messages
        if (memory.content?.type === 'action_result' || memory.content?.type === 'summary') {
          logger.info(
            `[MemorySummaryManager] Skipping ${memory.content.type} memory: ${memory.id}`
          );
          return false;
        }

        // Skip messages that are already marked as summarized
        const summarizedTypes =
          memory.metadata?.tags?.filter((tag) => tag.startsWith('summarized:')) || [];
        const isUnsummarized = !summarizedTypes.includes(`summarized:${type}`);

        if (!isUnsummarized) {
          logger.info(`[MemorySummaryManager] Skipping already summarized memory: ${memory.id}`);
        }

        return isUnsummarized;
      });

      logger.info(
        `[MemorySummaryManager] Found ${unsummarizedMemories.length} unsummarized memories`
      );

      if (unsummarizedMemories.length > 0) {
        logger.info('[MemorySummaryManager] First unsummarized memory:', {
          id: unsummarizedMemories[0].id,
          createdAt: unsummarizedMemories[0].createdAt,
          text: unsummarizedMemories[0].content.text?.substring(0, 100),
          metadata: unsummarizedMemories[0].metadata,
        });
      }

      return unsummarizedMemories;
    } catch (error) {
      logger.error('[MemorySummaryManager] Error getting unsummarized memories:', error);
      throw error;
    }
  }

  /**
   * Generate a summary of the given memories using the LLM
   */
  private async generateSummary(
    memories: Memory[],
    type: MemoryType.WEEKLY_SUMMARY | MemoryType.MONTHLY_SUMMARY
  ): Promise<string> {
    try {
      logger.info(
        `[MemorySummaryManager] Generating ${type} summary for ${memories.length} memories`
      );

      const memoryTexts = memories
        .map((m) => m.content.text)
        .filter(Boolean)
        .join('\n\n');

      // Detect the language of memories
      const language = await this.detectLanguage(memories);
      logger.info(`[MemorySummaryManager] Detected language: ${language}`);

      const prompt = `
        Based on the user’s personal memories listed below, generate a structured and insightful weekly (or monthly) summary.

        ✅ Important:
        – Identify the dominant language of the memories (e.g., Russian or English).
        – Write the summary entirely in that same language.
        – Maintain a coaching-style structure and a grounded, reflective tone.

        ✅ Format:

        🚀 Headline: A short, emotionally resonant title that captures the theme of the week (e.g., “От перегрузки к новому импульсу” or “From Burnout to Clarity”).

        Date Range: For example, “14–20 июля” or “July 14–20”, depending on the memory language.

        Overview: A clear and concise paragraph summarizing key emotional themes, decisions, challenges, breakthroughs, or focus areas. Stay grounded, not abstract.

        Insights
        — Include 2–3 short reflections or takeaways in the second person (“ты” or “you”), such as mindset shifts, inner discoveries, or behavioral insights.

        Weekly Wins
        — 2–3 concrete wins (personal or professional) from the week. Highlight progress, not perfection.

        ✅ Guidelines:
        – Use the dominant language of the memories.
        – Use clear and accessible language (no academic or poetic overload).
        – Avoid generic advice. Ground each insight in the themes reflected in the memories.
        – Weave fragmented memories into a coherent narrative if needed.

        Here are the memories:
        ${memoryTexts}
        `;

      logger.info('[MemorySummaryManager] Calling LLM for summary generation...');
      const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      logger.info('[MemorySummaryManager] Summary generated successfully');

      return result;
    } catch (error) {
      logger.error('[MemorySummaryManager] Error generating summary:', error);
      throw error;
    }
  }

  /**
   * Send summary notification to Telegram
   */
  private async sendTelegramNotification(
    summary: string,
    type: string,
    memories: Memory[]
  ): Promise<void> {
    try {
      logger.info('[MemorySummaryManager] Getting Telegram service...');
      const telegramService = this.runtime.getService('telegram') as any;
      if (!telegramService) {
        logger.warn('[MemorySummaryManager] Telegram service not available, skipping notification');
        return;
      }

      // Find a Telegram memory to get the chat ID
      logger.info('[MemorySummaryManager] Looking for Telegram DM memory...');
      const telegramMemory = memories.find(
        (m) => m.content?.source === 'telegram' && m.content?.channelType === 'DM'
      );

      if (!telegramMemory) {
        logger.warn('[MemorySummaryManager] No Telegram DM memory found, skipping notification');
        return;
      }

      // Get the room ID which corresponds to the Telegram chat ID
      const room = await this.runtime.getRoom(telegramMemory.roomId);

      if (!room?.channelId) {
        logger.warn(
          '[MemorySummaryManager] Could not find channel ID in room, skipping notification'
        );
        return;
      }

      const formattedMessage = {
        text: summary,
        source: 'telegram',
        type: 'summary',
        channelType: ChannelType.DM,
      };

      logger.info('[MemorySummaryManager] Sending message to Telegram...');
      await telegramService.messageManager.sendMessage(room.channelId, formattedMessage);
      logger.info(`[MemorySummaryManager] Summary sent to Telegram chat ${room.channelId}`);
    } catch (error) {
      logger.error('[MemorySummaryManager] Error sending Telegram notification:', error);
    }
  }

  /**
   * Save a summary as a new memory and send notification
   */
  private async saveSummary(summary: string, type: string, memories: Memory[]): Promise<void> {
    try {
      // Create a unique room ID for summaries
      const roomId = createUniqueUuid(this.runtime, 'memory_summaries');

      // Create the room first
      await this.runtime.createRoom({
        id: roomId,
        name: `Memory Summaries - ${type}`,
        source: 'memory_summary',
        type: ChannelType.SELF,
        channelId: roomId,
        serverId: this.runtime.agentId,
        worldId: this.runtime.agentId,
        agentId: this.runtime.agentId,
      });

      // Create the memory with proper metadata
      const metadata = {
        type,
        source: 'memory_summary',
        timestamp: Date.now(),
        tags: [], // Initialize empty tags array
      };

      const memory: Memory = {
        content: {
          text: summary,
          source: 'memory_summary',
          type: 'summary',
        },
        metadata,
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: roomId,
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(memory, type);
      logger.info(`[MemorySummaryManager] ${type} summary saved successfully in room ${roomId}`);

      // Send to Telegram
      await this.sendTelegramNotification(summary, type, memories);
    } catch (error) {
      logger.error('[MemorySummaryManager] Error saving summary:', error);
      throw error;
    }
  }

  /**
   * Mark memories as summarized
   */
  private async markMemoriesAsSummarized(memories: Memory[], type: string): Promise<void> {
    logger.info(
      `[MemorySummaryManager] Marking ${memories.length} memories as summarized in ${type}...`
    );
    for (const memory of memories) {
      if (!memory.id) continue;

      await this.runtime.updateMemory({
        id: memory.id,
        metadata: {
          type: memory.metadata?.type || 'message',
          source: memory.metadata?.source || 'summary',
          timestamp: Date.now(),
          tags: [...(memory.metadata?.tags || []), `summarized:${type}`],
        },
      });
    }
    logger.info('[MemorySummaryManager] Memories marked as summarized');
  }

  /**
   * Stop the cron jobs
   */
  async stop() {
    logger.info('[MemorySummaryManager] Stopping cron jobs...');
    this.weeklyJob?.stop();
    this.monthlyJob?.stop();
    logger.info('[MemorySummaryManager] Cron jobs stopped');
  }
}
