import { AgentRuntime, Character, DatabaseAdapter } from '@elizaos/core';
import { AgentServer } from '@elizaos/server';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import openaiPlugin from '@elizaos/plugin-openai';
import telegramPlugin from '@elizaos/plugin-telegram';
import { MemorySummaryManager } from '../cron/memory-summaries';
import * as dotenv from 'dotenv';
import { join } from 'path';

// Load environment variables from the root .env file
dotenv.config({ path: join(__dirname, '../../../../.env') });

if (!process.env.POSTGRES_URL) {
  console.error('Error: POSTGRES_URL environment variable is not set');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  process.exit(1);
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

const POSTGRES_URL = process.env.POSTGRES_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function startMemorySummariesDaemon() {
  try {
    // Initialize database adapter through AgentServer
    console.log('Initializing database...');
    const server = new AgentServer();
    await server.initialize({ postgresUrl: POSTGRES_URL });
    const dbAdapter = (server as any).database as DatabaseAdapter;

    // Get your agent from database
    console.log('Getting agent from database...');
    const agent = await dbAdapter.getAgentByName('stepam');
    if (!agent) {
      throw new Error('Could not find agent "stepam" in database');
    }
    console.log('Found agent:', agent.name);

    // Create character configuration from database agent
    const character: Character = {
      ...agent,
      settings: {
        ...agent.settings,
        POSTGRES_URL,
        OPENAI_API_KEY,
        TELEGRAM_BOT_TOKEN,
      },
    };

    // Initialize runtime with plugins
    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, openaiPlugin, telegramPlugin],
      settings: {
        POSTGRES_URL,
        OPENAI_API_KEY,
        TELEGRAM_BOT_TOKEN,
      },
    });

    console.log('Initializing runtime...');
    await runtime.initialize();
    console.log('Runtime initialized successfully.');

    // Create and initialize MemorySummaryManager
    console.log('Starting MemorySummaryManager service...');
    const memorySummaryManager = await MemorySummaryManager.start(runtime);
    console.log('MemorySummaryManager service started successfully.');

    // Handle process termination
    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM signal. Shutting down...');
      await (memorySummaryManager as MemorySummaryManager).stop();
      await runtime.close();
      await server.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.log('Received SIGINT signal. Shutting down...');
      await (memorySummaryManager as MemorySummaryManager).stop();
      await runtime.close();
      await server.stop();
      process.exit(0);
    });

    // Keep the process running
    console.log('Memory summaries daemon is now running...');
    console.log('Weekly summaries will run every Sunday at midnight (0 0 * * 0)');
    console.log(
      'Monthly summaries will run on the first day of each month at midnight (0 0 1 * *)'
    );
  } catch (error) {
    console.error('Error in daemon:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  startMemorySummariesDaemon();
}
