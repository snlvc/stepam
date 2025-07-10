import {
  type IAgentRuntime,
  type Memory,
  type MemoryMetadata,
  type UUID,
  logger,
  ModelType,
  Service,
  ServiceType,
  createUniqueUuid,
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

  /**
   * Start the MemorySummaryManager with the given runtime
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new MemorySummaryManager(runtime);
    await service.startCronJobs();
    return service;
  }

  /**
   * Start the cron jobs for weekly and monthly summaries
   */
  private async startCronJobs() {
    // Weekly summary - runs every Sunday at 12:00 AM
    this.weeklyJob = cron.schedule('0 0 * * 0', async () => {
      try {
        await this.generateWeeklySummary();
      } catch (error) {
        logger.error('[MemorySummaryManager] Error generating weekly summary:', error);
      }
    });

    // Monthly summary - runs on the 1st of every month at 12:00 AM
    this.monthlyJob = cron.schedule('0 0 1 * *', async () => {
      try {
        await this.generateMonthlySummary();
      } catch (error) {
        logger.error('[MemorySummaryManager] Error generating monthly summary:', error);
      }
    });

    logger.info('[MemorySummaryManager] Started cron jobs for memory summaries');
  }

  /**
   * Generate a weekly summary of memories
   */
  private async generateWeeklySummary() {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Get memories from the last 7 days
    const memories = await this.runtime.getMemories({
      tableName: 'messages',
      start: sevenDaysAgo,
      end: now,
    });

    if (memories.length === 0) {
      logger.info('[MemorySummaryManager] No memories found for weekly summary');
      return;
    }

    const summary = await this.generateSummary(memories, MemoryType.WEEKLY_SUMMARY);
    await this.saveSummary(summary, MemoryType.WEEKLY_SUMMARY);
  }

  /**
   * Generate a monthly summary of memories
   */
  private async generateMonthlySummary() {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Get memories from the last 30 days
    const memories = await this.runtime.getMemories({
      tableName: 'messages',
      start: thirtyDaysAgo,
      end: now,
    });

    if (memories.length === 0) {
      logger.info('[MemorySummaryManager] No memories found for monthly summary');
      return;
    }

    const summary = await this.generateSummary(memories, MemoryType.MONTHLY_SUMMARY);
    await this.saveSummary(summary, MemoryType.MONTHLY_SUMMARY);
  }

  /**
   * Generate a summary of the given memories using the LLM
   */
  private async generateSummary(
    memories: Memory[],
    type: MemoryType.WEEKLY_SUMMARY | MemoryType.MONTHLY_SUMMARY
  ): Promise<string> {
    const memoryTexts = memories
      .map((m) => m.content.text)
      .filter(Boolean)
      .join('\n\n');

    const prompt = `You are ${this.runtime.character.name}, generating a ${type} summary of your memories. 
    Review these memories and create a reflective summary in your characteristic style:

    ${memoryTexts}

    Generate a concise but meaningful summary that captures:
    1. Key interactions and events
    2. Important insights or learnings
    3. Notable patterns or trends
    4. Areas for improvement or focus

    Write in first person from your perspective as ${this.runtime.character.name}.`;

    const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    return result;
  }

  /**
   * Save a summary as a new memory
   */
  private async saveSummary(summary: string, type: string): Promise<UUID> {
    const metadata: MemoryMetadata = {
      type,
      source: 'memory_summary',
      timestamp: Date.now(),
    };

    const memory: Memory = {
      content: { text: summary },
      metadata,
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: createUniqueUuid(this.runtime, 'memory_summaries'),
      createdAt: Date.now(),
    };

    return this.runtime.createMemory(memory, type);
  }

  /**
   * Stop the cron jobs
   */
  async stop() {
    this.weeklyJob?.stop();
    this.monthlyJob?.stop();
    logger.info('[MemorySummaryManager] Stopped cron jobs');
  }
}
